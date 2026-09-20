/**
 * 诊断：连续跨多层缩放的"防抖中间层抑制"是否生效。
 *
 * 用真实 CesiumTerrainLayer（桩掉 DOM/网络 + 合成 quantized-mesh）模拟
 * "10 级快速放大到 13 级"的手势突发（相邻步间隔 << LOD_BURST_GAP_MS），
 * 逐步记录：
 *   - fastZoom 是否进入快速跳层模式
 *   - loadedTiles 的层级直方图 / 总块数
 *   - "代际堆叠"块数（某块区域同时有祖先 + 更细后代在渲染的数量）
 *   - 影像请求数、拼接画布数、fade-out 中的块数
 *   - 手势停下后的恢复过程（中间层级是否从缓存回归）
 *
 * 对照组：把 updateFastZoomState 打成 no-op（fastZoom 永远 false），
 * 其余完全一致，用来看抑制到底省了多少中间层渲染。
 *
 * 运行：node scripts/diag-fast-zoom.cjs
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const ROOT = path.resolve(__dirname, "..");
const METADATA_CACHE = path.join(__dirname, ".terrain-metadata.json");

// ── 浏览器 API 桩 ─────────────────────────────────────────────
let canvasCreated = 0;
const fakeCanvas = () => {
  const element = {
    style: {},
    getContext() {
      return {
        drawImage() {},
        clearRect() {},
        fillRect() {},
        setTransform() {},
        imageSmoothingEnabled: false,
      };
    },
  };
  let width = 0;
  let height = 0;
  Object.defineProperty(element, "width", {
    get: () => width,
    set: (value) => {
      width = value;
      if (width && height) canvasCreated++;
    },
  });
  Object.defineProperty(element, "height", {
    get: () => height,
    set: (value) => {
      height = value;
      if (width && height) canvasCreated++;
    },
  });
  return element;
};
global.document = {
  createElement: () => fakeCanvas(),
  createElementNS: () => fakeCanvas(),
};
global.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });

// ── 合成 quantized-mesh（4 顶点平面） ──────────────────────────
function buildTerrainBuffer() {
  const vertexCount = 4;
  const buffer = new ArrayBuffer(88 + 4 + vertexCount * 2 * 3 + 4 + 6 * 2);
  const view = new DataView(buffer);
  view.setFloat32(24, 0, true);
  view.setFloat32(28, 0, true);
  view.setUint32(88, vertexCount, true);
  let offset = 92;
  for (const values of [
    [0, 32767, 32767, 0],
    [0, 0, 32767, 32767],
    [0, 32767, 32767, 0],
  ]) {
    let prev = 0;
    values.forEach((value, i) => {
      const delta = value - prev;
      prev = value;
      const encoded = delta < 0 ? ((-delta << 1) | 1) : delta << 1;
      view.setUint16(offset + i * 2, encoded, true);
    });
    offset += vertexCount * 2;
  }
  view.setUint32(offset, 2, true);
  offset += 4;
  [0, 0, 0, 1, 2, 0].forEach((code, i) => view.setUint16(offset + i * 2, code, true));
  return buffer;
}

const TERRAIN_BUFFER = buildTerrainBuffer();
const TERRAIN_BASE = "https://terrain.example.com/world";
const IMAGERY_TEMPLATE = "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}";

let metadata = { available: null };
let terrainRequests = 0;
let imageryRequests = 0;
global.fetch = async (url) => {
  const target = String(url);
  if (target.includes("layer.json")) {
    const available = metadata.available?.length ? metadata.available : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tiles: [`${TERRAIN_BASE}/{z}/{x}/{y}.terrain`],
        maxzoom: metadata.maxzoom,
        available,
        scheme: metadata.scheme,
      }),
    };
  }
  if (/\.terrain/.test(target)) {
    terrainRequests++;
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  if (/[?&]z=\d+/.test(target)) {
    imageryRequests++;
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)]) };
  }
  return { ok: false, status: 404, blob: async () => new Blob(["x"]) };
};

// ── 真实模块 ──────────────────────────────────────────────────
const THREE = require(path.join(ROOT, "node_modules/three"));
const { CesiumTerrainLayer } = require(path.join(
  ROOT,
  "lib/sources/engine/layers/CesiumTerrainLayer.ts",
));
const { WebMercatorGIS } = require(path.join(ROOT, "lib/sources/gis/WebMercatorGIS.ts"));
const {
  getSuggestZoom,
  getViewGroundCorners,
  cornersToLngLatBounds,
} = require(path.join(ROOT, "lib/sources/engine/utils/camera-utils.ts"));

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const MAX_TOOL_ZOOM = 15;
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLayer(gis) {
  return new CesiumTerrainLayer(
    gis,
    { terrainUrl: TERRAIN_BASE, accessToken: "" },
    {
      minZoom: 1,
      maxZoom: MAX_TOOL_ZOOM,
      maxConcurrent: 10,
      maxQueueSize: 160,
      maxRequestsPerFrame: 8,
      maxTileRendersPerFrame: 4,
      tileYOrigin: "auto",
      terrainZoomOffset: 0,
      imageryZoomOffset: 0,
      imageryMaxCanvasSize: 2048,
      terrainTilePixelSize: 512,
      maximumScreenSpaceError: 4,
      maxTilesPerView: 128,
      maxCacheSize: 256,
      exaggeration: 1,
      imageryUrlTemplate: IMAGERY_TEMPLATE,
      imagerySubdomains: ["0", "1", "2", "3"],
      imageryRequestGroup: "google",
      imageryMaximumRequestsPerServer: 12,
      maximumRequestsPerServer: 10,
      prefetchTileBudget: 0,
    },
  );
}

function makeCamera(target, altitude) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, altitude);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

function runViewUpdate(layer, camera, target, gis, lat) {
  const cameraDistance = camera.position.distanceTo(target);
  const bounds = cornersToLngLatBounds(getViewGroundCorners(camera, 0), gis);
  if (!bounds) return null;
  const cameraHeight = Math.max(camera.position.z, 1);
  layer.updateTilesInView(
    [bounds.west, bounds.east],
    [bounds.south, bounds.north],
    getSuggestZoom(cameraDistance, FOV, VIEWPORT_HEIGHT, lat),
    target,
    cameraDistance,
    camera.position,
    getSuggestZoom(cameraHeight, FOV, VIEWPORT_HEIGHT, lat),
    camera,
    VIEWPORT_WIDTH,
    VIEWPORT_HEIGHT,
  );
  layer.update();
  return bounds;
}

/** loadedTiles 快照：层级直方图 + 代际堆叠块数（同区域同时有祖先与更细后代） */
function snapshot(layer) {
  const keys = [...layer.loadedTiles.keys()];
  const histogram = new Map();
  const parsed = keys.map((key) => {
    const [x, y, zoom] = key.split(",").map(Number);
    return { key, x, y, zoom };
  });
  for (const tile of parsed) histogram.set(tile.zoom, (histogram.get(tile.zoom) ?? 0) + 1);
  let stacked = 0;
  for (const tile of parsed) {
    for (const other of parsed) {
      if (other.zoom <= tile.zoom) continue;
      if (other.x >> (other.zoom - tile.zoom) === tile.x && other.y >> (other.zoom - tile.zoom) === tile.y) {
        stacked++;
        break;
      }
    }
  }
  return { total: parsed.length, histogram, stacked };
}

function formatHistogram(histogram) {
  return [...histogram.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([zoom, count]) => `z${zoom}x${count}`)
    .join(" ");
}

async function runCase(label, { disableFastZoom }) {
  const gis = new WebMercatorGIS(118.1371, 24.49);
  const target = gis.lngLatToThree(118.1371, 24.49, 0);
  const layer = createLayer(gis);
  if (disableFastZoom) {
    layer.updateFastZoomState = function () {
      this.fastZoomActive = false;
    };
  }
  await idle(60);
  const camera = makeCamera(target, 20000);

  // 稳定在起点层级（等效 z10 附近）
  for (let i = 0; i < 12; i++) {
    runViewUpdate(layer, camera, target, gis, 24.49);
    await idle(40);
  }

  const rows = [];
  const record = (tag) => {
    const snap = snapshot(layer);
    rows.push(
      `${tag.padEnd(12)} | fast=${layer.isFastZoomActive() ? "Y" : "n"} | ` +
        `tiles=${String(snap.total).padStart(3)} | stacked=${String(snap.stacked).padStart(3)} | ` +
        `fading=${String(layer.fadingOut.size).padStart(3)} | visible=${String(layer.currentVisibleKeys.size).padStart(3)} | ` +
        `${formatHistogram(snap.histogram)}`,
    );
  };

  record("start");

  // 快速跳层突发：20000 → 9000 → 4000 → 1500（步间隔 60ms << 250ms 突发间隔）
  terrainRequests = 0;
  imageryRequests = 0;
  canvasCreated = 0;
  for (const altitude of [9000, 4000, 1500]) {
    camera.position.set(0, 0, altitude);
    camera.updateMatrixWorld(true);
    runViewUpdate(layer, camera, target, gis, 24.49);
    record(`to ${altitude}m`);
    await idle(60);
  }
  const duringBurst = snapshot(layer);
  const burstStats = `burst window: terrainReq=${terrainRequests} imageryReq=${imageryRequests} canvases=${canvasCreated}`;

  // 手势停下：继续在原高度更新，观察中间层级是否回归
  for (let i = 0; i < 6; i++) {
    runViewUpdate(layer, camera, target, gis, 24.49);
    await idle(80);
    if (i === 0 || i === 3) record(`settle ${i}`);
  }
  const settled = snapshot(layer);

  console.log(`\n=== ${label} ===`);
  for (const row of rows) console.log(row);
  console.log(burstStats);
  console.log(
    `end of burst: tiles=${duringBurst.total} stacked=${duringBurst.stacked}; ` +
      `after settle: tiles=${settled.total} stacked=${settled.stacked}`,
  );
  layer.dispose();
}

async function main() {
  if (fs.existsSync(METADATA_CACHE)) {
    metadata = JSON.parse(fs.readFileSync(METADATA_CACHE, "utf8"));
  }
  console.log(`terrain availability levels: ${metadata.available?.length ?? "unknown"}`);
  await runCase("fast-zoom suppression ON", { disableFastZoom: false });
  await runCase("control: suppression OFF", { disableFastZoom: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

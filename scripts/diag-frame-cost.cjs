/**
 * 诊断：放大后稳态下每帧主线程开销在哪。
 *
 * 在 400m 高度驱动真实 CesiumTerrainLayer，分两个阶段测量：
 *   A) 预热加载 25 轮（等瓦片/影像就绪）
 *   B) 稳态 40 轮：相机不动，理论上每帧应接近零工作。
 * 逐项计时 updateTilesInView / update / processTerrainRenderQueue /
 * updateTerrainChildOcclusion，并统计画布创建、fetchImagery、几何组装次数。
 *
 * 运行：node scripts/diag-frame-cost.cjs [lng] [lat] [altitude]
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

// ── 浏览器 API 桩（画布创建计数） ──────────────────────────────
let canvasCreated = 0;
const fakeCanvas = () => ({
  width: 0,
  height: 0,
  style: {},
  getContext() {
    return {
      drawImage() {},
      clearRect() {},
      fillRect() {},
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      setTransform() {},
      imageSmoothingEnabled: false,
    };
  },
});
global.document = {
  createElement: (tag) => {
    if (tag === "canvas") canvasCreated++;
    return fakeCanvas();
  },
  createElementNS: () => fakeCanvas(),
};
global.createImageBitmap = async (blob) => ({ width: 256, height: 256, close() {}, __blob: blob });

// ── 合成 quantized-mesh ────────────────────────────────────────
function buildTerrainBuffer() {
  const vertexCount = 4;
  const buffer = new ArrayBuffer(88 + 4 + vertexCount * 2 * 3 + 4 + 6 * 2);
  const view = new DataView(buffer);
  view.setFloat32(24, 0, true);
  view.setFloat32(28, 100, true);
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

const realFetch = global.fetch;
async function loadTerrainMetadata() {
  if (fs.existsSync(METADATA_CACHE)) return JSON.parse(fs.readFileSync(METADATA_CACHE, "utf8"));
  const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const token = (env.match(/NEXT_PUBLIC_CESIUM_ION_TOKEN\s*=\s*(.+)/)?.[1] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  const endpoint = await (
    await realFetch(`https://api.cesium.com/v1/assets/1/endpoint?access_token=${token}`)
  ).json();
  const base = endpoint.url.replace(/\/$/, "");
  const metadata = await (
    await realFetch(`${base}/layer.json?access_token=${endpoint.accessToken}`)
  ).json();
  fs.writeFileSync(METADATA_CACHE, JSON.stringify(metadata));
  return metadata;
}

let unmatched = 0;
let metadata = { available: null };
global.fetch = async (url) => {
  const target = String(url);
  if (target.includes("layer.json")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tiles: [`${TERRAIN_BASE}/{z}/{x}/{y}.terrain`],
        maxzoom: metadata.maxzoom,
        available: metadata.available,
        scheme: metadata.scheme,
      }),
    };
  }
  if (/\/(\d+)\/(-?\d+)\/(-?\d+)\.terrain/.test(target)) {
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  if (/[?&]z=(\d+)/.test(target)) {
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)]) };
  }
  unmatched++;
  return { ok: false, status: 404, blob: async () => new Blob(["x"]) };
};

// ── 真实模块 + 计时插桩 ────────────────────────────────────────
const THREE = require(path.join(ROOT, "node_modules/three"));
const { CesiumTerrainLayer } = require(path.join(
  ROOT,
  "lib/sources/engine/layers/CesiumTerrainLayer.ts",
));
const { WebMercatorGIS } = require(path.join(ROOT, "lib/sources/gis/WebMercatorGIS.ts"));
const { getSuggestZoom, getViewGroundCorners, cornersToLngLatBounds } = require(path.join(
  ROOT,
  "lib/sources/engine/utils/camera-utils.ts",
));

const timers = {
  updateTilesInView: { ms: 0, n: 0, max: 0 },
  update: { ms: 0, n: 0, max: 0 },
  processTerrainRenderQueue: { ms: 0, n: 0, max: 0 },
  updateTerrainChildOcclusion: { ms: 0, n: 0, max: 0 },
  collectQuadtreeTerrainTiles: { ms: 0, n: 0, max: 0 },
};
let fetchImageryCalls = 0;
let geometryBuilds = 0;
let tracking = false;

function time(name, self, args, original) {
  if (!tracking) return original.apply(self, args);
  const t0 = performance.now();
  const result = original.apply(self, args);
  const dt = performance.now() - t0;
  const slot = timers[name];
  slot.ms += dt;
  slot.n += 1;
  if (dt > slot.max) slot.max = dt;
  return result;
}

{
  const proto = CesiumTerrainLayer.prototype;
  for (const name of Object.keys(timers)) {
    const original = proto[name];
    proto[name] = function (...args) {
      return time(name, this, args, original);
    };
  }
  const originalFetchImagery = proto.fetchImagery;
  proto.fetchImagery = function (...args) {
    if (tracking) fetchImageryCalls++;
    return originalFetchImagery.apply(this, args);
  };
  const originalBuild = proto.buildGeometryFromArrays;
  proto.buildGeometryFromArrays = function (...args) {
    if (tracking) geometryBuilds++;
    return originalBuild.apply(this, args);
  };
}

// ── 场景参数（与 CesiumTerrainDemo 一致） ─────────────────────
const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const PITCH_DEG = 55;
const MAX_TOOL_ZOOM = 15;
const IMAGERY_CANVAS = 2048;
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
      imageryMaxCanvasSize: IMAGERY_CANVAS,
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

function makeCamera(gis, target, altitude) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  const pitch = (PITCH_DEG * Math.PI) / 180;
  const distance = altitude / Math.sin(pitch);
  camera.position.set(0, -distance * Math.cos(pitch), altitude);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

function runViewUpdate(layer, camera, target, gis, lat) {
  const cameraDistance = camera.position.distanceTo(target);
  const bounds = cornersToLngLatBounds(getViewGroundCorners(camera, 0), gis);
  if (!bounds) return;
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
}

async function run(lng, lat, altitude) {
  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(60);
  const camera = makeCamera(gis, target, altitude);

  // 阶段 A：预热 25 轮
  for (let i = 0; i < 25; i++) {
    runViewUpdate(layer, camera, target, gis, lat);
    await idle(40);
  }

  // 阶段 B：稳态 40 轮（相机不动）
  for (const slot of Object.values(timers)) {
    slot.ms = 0;
    slot.n = 0;
    slot.max = 0;
  }
  fetchImageryCalls = 0;
  geometryBuilds = 0;
  canvasCreated = 0;
  tracking = true;
  const steadyStart = performance.now();
  let steadyWallMax = 0;
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    runViewUpdate(layer, camera, target, gis, lat);
    const wall = performance.now() - t0;
    if (wall > steadyWallMax) steadyWallMax = wall;
    await idle(16);
  }
  const steadyWall = performance.now() - steadyStart;
  tracking = false;

  const loaded = layer.loadedTiles ? layer.loadedTiles.size : -1;
  const visible = layer.currentVisibleKeys ? layer.currentVisibleKeys.size : -1;
  console.log(`\n== 高度 ${altitude}m 稳态 40 轮 ==`);
  console.log(
    `loadedTiles=${loaded} visibleKeys=${visible} 稳态总耗时=${steadyWall.toFixed(0)}ms 单轮峰值=${steadyWallMax.toFixed(1)}ms`,
  );
  for (const [name, slot] of Object.entries(timers)) {
    if (slot.n === 0) continue;
    console.log(
      `  ${name}: 共 ${slot.n} 次 合计 ${slot.ms.toFixed(1)}ms 平均 ${(slot.ms / slot.n).toFixed(2)}ms 峰值 ${slot.max.toFixed(2)}ms`,
    );
  }
  console.log(
    `  fetchImagery=${fetchImageryCalls} geometryBuilds=${geometryBuilds} canvasCreated=${canvasCreated}`,
  );
  layer.dispose();
}

(async () => {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 400);
  const originalWarn = console.warn;
  console.warn = () => {};

  // 阶段 C：模拟滚轮放大手势 1600m → 800m → 400m，统计每个缩放步
  // 触发的影像画布重建与 fetchImagery 次数（浏览器里每次重建都是
  // 一次主线程 drawImage 拼接 + 一次 GPU 纹理上传）
  {
    const gis = new WebMercatorGIS(lng, lat);
    const target = gis.lngLatToThree(lng, lat, 0);
    const layer = createLayer(gis);
    await idle(60);
    let camera = makeCamera(gis, target, 2400);
    for (let i = 0; i < 20; i++) {
      runViewUpdate(layer, camera, target, gis, lat);
      await idle(30);
    }
    console.log(`\n== 缩放手势逐轮统计（1600m → 400m，每步 4 轮，交互中门控）==`);
    console.log("高度 | 状态 | fetchImagery | canvasCreated");
    for (const height of [1600, 1200, 900, 700, 550, 450, 400]) {
      camera = makeCamera(gis, target, height);
      layer.setCameraInteracting(true);
      for (let step = 0; step < 4; step++) {
        fetchImageryCalls = 0;
        canvasCreated = 0;
        tracking = true;
        runViewUpdate(layer, camera, target, gis, lat);
        tracking = false;
        if (fetchImageryCalls || canvasCreated) {
          console.log(
            `${String(height).padStart(5)} | 交互中 | ${String(fetchImageryCalls).padStart(12)} | ${String(canvasCreated).padStart(13)}`,
          );
        }
        await idle(40);
      }
      // 松手：一次性补齐（应受 maxRequestsPerFrame=8 限制）
      layer.setCameraInteracting(false);
      fetchImageryCalls = 0;
      canvasCreated = 0;
      runViewUpdate(layer, camera, target, gis, lat);
      console.log(
        `${String(height).padStart(5)} | 松手后 | ${String(fetchImageryCalls).padStart(12)} | ${String(canvasCreated).padStart(13)}`,
      );
      await idle(80);
    }
    console.log(`最终 loadedTiles=${layer.loadedTiles.size} visibleKeys=${layer.currentVisibleKeys.size}`);
    layer.dispose();
  }

  await run(lng, lat, altitude);
  console.warn = originalWarn;
  if (unmatched > 0) console.log(`未匹配的 URL: ${unmatched}`);
})();

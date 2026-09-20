/**
 * 诊断：渲染/加载是否"从离视角最近的地方先开始"。
 *
 * 用户现象：倾斜视角下，远处影像/几何都清晰了，最近的下方（屏幕底部）还是
 * 最模糊的一代瓦片。本脚本用真实 CesiumTerrainLayer（桩 DOM/网络）复现：
 *
 *  1) 屏幕锐度图：把屏幕切成 NDC 网格，逐点射线打到地面上，找覆盖它的可见
 *     瓦片，报告该瓦片的层级 / 已加载影像层级 / 影像是否就绪 / 到相机距离。
 *     按屏幕行（底=近，顶=远）汇总 → 直接看出"近处是不是最后才清晰"。
 *  2) 请求顺序：记录每次 fetchImagery 的发起顺序、所属瓦片到相机距离、画布
 *     尺寸、子块请求数 → 判断排序是否近处优先、近处瓦片为何最慢。
 *
 * 运行：node scripts/diag-near-priority.cjs [lng] [lat] [高度m] [俯仰角]
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
const fakeCanvas = () => {
  const element = {
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
  };
  let width = 0;
  let height = 0;
  Object.defineProperty(element, "width", {
    get: () => width,
    set: (v) => {
      width = v;
    },
  });
  Object.defineProperty(element, "height", {
    get: () => height,
    set: (v) => {
      height = v;
    },
  });
  return element;
};
global.document = {
  createElement: () => fakeCanvas(),
  createElementNS: () => fakeCanvas(),
};
global.createImageBitmap = async (blob) => ({ width: 256, height: 256, close() {}, __blob: blob });

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

let metadata = { available: null };
let terrainRequests = 0;
let imageryRequests = 0;
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

/** 每次 fetchImagery 的记录（发起顺序 = 排序后的实际顺序） */
const imageryLog = [];
let tracking = false;
{
  const proto = CesiumTerrainLayer.prototype;
  const originalFetchImagery = proto.fetchImagery;
  proto.fetchImagery = function (x, y, zoom, requestedImageryZoom, signal, maxCanvasSize, priority) {
    if (tracking) {
      imageryLog.push({
        key: `${x},${y},${zoom}`,
        x,
        y,
        zoom,
        requestedZoom: requestedImageryZoom,
        canvas: maxCanvasSize,
        priority,
      });
    }
    return originalFetchImagery.apply(this, arguments);
  };
}

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

function makeCamera(target, altitude, pitchDeg) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  const pitch = (pitchDeg * Math.PI) / 180;
  const distance = altitude / Math.sin(pitch);
  camera.position.set(0, -distance * Math.cos(pitch), altitude);
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

function geoTileBoundsLocal(x, y, zoom, yOrigin) {
  const numX = Math.pow(2, zoom + 1);
  const numY = Math.pow(2, zoom);
  const west = (x / numX) * 360 - 180;
  const east = ((x + 1) / numX) * 360 - 180;
  const north = yOrigin === "north" ? 90 - (y / numY) * 180 : ((y + 1) / numY) * 180 - 90;
  const south = yOrigin === "north" ? 90 - ((y + 1) / numY) * 180 : (y / numY) * 180 - 90;
  return { west, east, south, north };
}

function tileCenterDistance(gis, camera, x, y, zoom, yOrigin) {
  const b = geoTileBoundsLocal(x, y, zoom, yOrigin);
  const c = gis.lngLatToThree((b.west + b.east) / 2, (b.south + b.north) / 2, 0);
  return c.distanceTo(camera.position);
}

/** 找覆盖 (lng,lat) 的可见瓦片（最细的那块） */
function findCoveringTile(layer, lng, lat) {
  let best = null;
  for (const key of layer.currentVisibleKeys ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!best || zoom > best.zoom) best = { key, x, y, zoom };
  }
  return best;
}

/**
 * 屏幕锐度图：NDC 网格逐点打地面，看覆盖瓦片的层级与影像状态。
 * rows: 屏幕从下(近)到上(远)
 */
function buildSharpnessMap(layer, camera, gis) {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const cols = 7;
  const rows = 5;
  const table = [];
  for (let r = 0; r < rows; r++) {
    // ndcY: -0.9(屏幕最下=最近) → 0.9(最上=最远)
    const ndcY = -0.9 + (1.8 * r) / (rows - 1);
    const rowSamples = [];
    for (let c = 0; c < cols; c++) {
      const ndcX = -0.9 + (1.8 * c) / (cols - 1);
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hit)) {
        rowSamples.push({ ndcX, ndcY, none: true });
        continue;
      }
      const [lng, lat] = gis.threeToLngLat(hit);
      const tile = findCoveringTile(layer, lng, lat);
      if (!tile) {
        rowSamples.push({ ndcX, ndcY, none: true });
        continue;
      }
      const entry = layer.loadedTiles?.get(tile.key);
      const distance = tileCenterDistance(gis, camera, tile.x, tile.y, tile.zoom, layer.tileYOrigin);
      rowSamples.push({
        ndcX,
        ndcY,
        key: tile.key,
        zoom: tile.zoom,
        distance,
        loaded: Boolean(entry),
        imageryZoom: entry ? entry.imageryZoom : null,
        imageryReady: entry ? entry.imageryReady : false,
        idealZoom: layer.getTileImageryZoom(tile.x, tile.y, tile.zoom),
      });
    }
    table.push({ ndcY, samples: rowSamples });
  }
  return table;
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 3000);
  const pitch = Number(process.argv[5] ?? 40);

  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(80);
  const camera = makeCamera(target, altitude, pitch);

  const originalWarn = console.warn;
  console.warn = () => {};

  console.log(
    `位置 (${lng}, ${lat}) | 高度 ${altitude}m | 俯仰 ${pitch}° | availability 层级 ${metadata.available?.length ?? 0}`,
  );

  tracking = true;
  // 预热：模拟交互过程中每 50ms 一次视图更新 + 每帧 update
  const WARMUP_MS = Number(process.env.WARMUP_MS ?? 4000);
  const t0 = Date.now();
  while (Date.now() - t0 < WARMUP_MS) {
    runViewUpdate(layer, camera, target, gis, lat);
    await idle(50);
  }
  tracking = false;

  console.log(
    `预热 ${WARMUP_MS}ms：地形请求 ${terrainRequests}，影像子块请求 ${imageryRequests}，` +
      `可见 ${layer.currentVisibleKeys?.size ?? 0}，已加载 ${layer.loadedTiles?.size ?? 0}`,
  );

  // ── 1) 屏幕锐度图 ──────────────────────────────────────────
  const map = buildSharpnessMap(layer, camera, gis);
  console.log("\n=== 屏幕锐度图（每行：NDC-Y 从下[近]到上[远]） ===");
  console.log("行 | 屏幕纵坐标 | 覆盖瓦片层级(z) | 影像就绪/总数 | 该行瓦片到相机距离 | 缺的层级");
  console.log("-".repeat(110));
  for (let i = 0; i < map.length; i++) {
    const row = map[i];
    const valid = row.samples.filter((s) => !s.none && s.loaded);
    const zooms = valid.map((s) => s.zoom);
    const ready = valid.filter((s) => s.imageryReady).length;
    const distances = valid.map((s) => s.distance);
    const avgDist = distances.length
      ? distances.reduce((a, b) => a + b, 0) / distances.length / 1000
      : 0;
    const gaps = valid.map((s) => Math.max(0, s.idealZoom - s.imageryZoom));
    const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    const minZoom = zooms.length ? Math.min(...zooms) : 0;
    const maxZoom = zooms.length ? Math.max(...zooms) : 0;
    console.log(
      `${String(i).padStart(2)} | ${row.ndcY.toFixed(2).padStart(9)} | ` +
        `z${String(minZoom).padStart(2)}~${String(maxZoom).padStart(2)} | ` +
        `${String(ready).padStart(2)}/${String(valid.length).padStart(2)} | ` +
        `${avgDist.toFixed(1).padStart(6)}km | 平均差 ${avgGap.toFixed(1)} 级`,
    );
  }

  // ── 2) 每个屏幕采样点的明细（最下面一行 vs 最上面一行） ──
  console.log("\n=== 明细：屏幕最下（最近）一行 vs 最上（最远）一行 ===");
  for (const idx of [0, map.length - 1]) {
    const row = map[idx];
    console.log(`\n[屏幕纵坐标 ${row.ndcY.toFixed(2)}]`);
    for (const s of row.samples) {
      if (s.none) {
        console.log(`  x=${s.ndcX.toFixed(2)}  无覆盖瓦片`);
        continue;
      }
      console.log(
        `  x=${s.ndcX.toFixed(2)}  z${String(s.zoom).padStart(2)} ${s.loaded ? "" : "未加载"}` +
          `  影像 z${s.imageryZoom ?? "-"}/${s.idealZoom}(需求) 就绪=${s.imageryReady ? "是" : "否"}` +
          `  距相机 ${(s.distance / 1000).toFixed(1)}km`,
      );
    }
  }

  // ── 3) 影像请求顺序（前 40 条 = 调度优先级最高的那批） ──
  console.log(`\n=== 影像请求顺序（共 ${imageryLog.length} 条，列出前 40） ===`);
  console.log("序 | 瓦片 | 地形z | 请求影像z | 画布 | 距相机km | 优先级(越小越先)");
  console.log("-".repeat(90));
  for (let i = 0; i < Math.min(40, imageryLog.length); i++) {
    const e = imageryLog[i];
    const d = tileCenterDistance(gis, camera, e.x, e.y, e.zoom, layer.tileYOrigin);
    console.log(
      `${String(i).padStart(3)} | ${e.key.padEnd(18)} | ${String(e.zoom).padStart(5)} | ` +
        `${String(e.requestedZoom).padStart(9)} | ${String(e.canvas).padStart(4)} | ` +
        `${(d / 1000).toFixed(1).padStart(8)} | ${Math.round(e.priority)}`,
    );
  }

  // ── 4) 请求成本分布：近处 vs 远处各占多少子块请求 ──
  const buckets = new Map();
  for (const e of imageryLog) {
    const d = tileCenterDistance(gis, camera, e.x, e.y, e.zoom, layer.tileYOrigin);
    const bucket = `${Math.round(Math.log2(Math.max(d, 1)))}`;
    if (!buckets.has(bucket)) buckets.set(bucket, { tiles: 0, canvasPx: 0, zooms: new Set() });
    const b = buckets.get(bucket);
    b.tiles++;
    b.canvasPx += e.canvas * e.canvas;
    b.zooms.add(e.requestedZoom);
  }
  console.log("\n=== 影像请求成本分布（按所属瓦片到相机距离分桶） ===");
  console.log("距离桶 | 发起次数 | 画布总像素MP | 涉及影像层级");
  console.log("-".repeat(70));
  for (const [bucket, b] of [...buckets.entries()].sort((a, b2) => Number(a[0]) - Number(b2[0]))) {
    console.log(
      `${(Math.pow(2, Number(bucket)) / 1000).toFixed(1).padStart(6)}km | ${String(b.tiles).padStart(8)} | ` +
        `${(b.canvasPx / 1e6).toFixed(1).padStart(12)} | z${[...b.zooms].sort((a, b2) => a - b2).join(",z")}`,
    );
  }

  // ── 5) 未完成情况：还差多少瓦片没影像 ──
  let pending = 0;
  let pendingNear = 0;
  for (const [, entry] of layer.loadedTiles ?? []) {
    if (entry.imageryReady) continue;
    pending++;
    const [x, y, zoom] = entry.key.split(",").map(Number);
    if (tileCenterDistance(gis, camera, x, y, zoom, layer.tileYOrigin) < 20000) pendingNear++;
  }
  console.log(
    `\n已加载瓦片中影像未就绪：${pending}（其中距相机 <20km 的 ${pendingNear}），` +
      `拼接队列剩余 ${layer.getCacheStats().stitchPending}`,
  );

  console.warn = originalWarn;
  layer.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

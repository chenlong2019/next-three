/**
 * 诊断：方位角（heading）对地形/影像瓦片选取与请求节奏的影响。
 *
 * 目的：验证"从北向南看流畅、从东向西看卡"是否真实存在，并定位是
 * "选取阶段截断"还是"请求阶段排序"。
 *
 * 关键指标：
 *   ① 视野 AABB 尺寸（km）—— 倾斜 + 旋转后包围盒膨胀多少
 *   ② 选中瓦片数 / 是否撞 maxTilesPerView 上限（截断 = 一部分屏幕永远不请求）
 *   ③ 屏幕采样点的"无覆盖"比例 —— 选中集里没有任何瓦片覆盖它
 *   ④ 每行（近→远）达到"完全清晰"的耗时
 *   ⑤ 请求节奏：每秒地形/影像请求数
 *
 * 每个方位用**全新的图层实例**，避免上一个方位的缓存污染对照。
 *
 * 运行：
 *   node scripts/diag-heading.cjs [lng] [lat] [高度] [俯仰] [延迟ms] [时长ms] [方位列表]
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
global.document = { createElement: () => fakeCanvas(), createElementNS: () => fakeCanvas() };
global.createImageBitmap = async () => ({ width: 256, height: 256, close() {} });

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

let LATENCY_MS = 60;
const TERRAIN_LATENCY_MS = 120;
const MAX_PER_HOST = 12;
let metadata = { available: null };

let terrainRequests = 0;
let imageryRequests = 0;
let queuedRequests = 0;
/** 影像请求去过重后的 URL 集合：用于区分"必要覆盖量"与"重复劳动" */
const imageryUrls = new Set();
const inFlightByHost = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function simulatedResponse(url, kind) {
  const host = (String(url).match(/^https?:\/\/([^/]+)/) ?? [, "unknown"])[1];
  for (;;) {
    const active = inFlightByHost.get(host) ?? 0;
    if (active < MAX_PER_HOST) {
      inFlightByHost.set(host, active + 1);
      break;
    }
    queuedRequests++;
    await sleep(4);
  }
  try {
    await sleep(kind === "terrain" ? TERRAIN_LATENCY_MS : LATENCY_MS);
  } finally {
    inFlightByHost.set(host, (inFlightByHost.get(host) ?? 1) - 1);
  }
}

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
    await simulatedResponse(target, "terrain");
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  if (/[?&]z=\d+/.test(target)) {
    imageryRequests++;
    imageryUrls.add(target);
    await simulatedResponse(target, "imagery");
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)]) };
  }
  return { ok: false, status: 404, blob: async () => new Blob(["x"]) };
};

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

// ── 插桩：记录 collectQuadtreeTerrainTiles 的产出规模 + 耗时 ──
let collectStats = null;
let collectMs = 0;
{
  const proto = CesiumTerrainLayer.prototype;
  const orig = proto.collectQuadtreeTerrainTiles;
  proto.collectQuadtreeTerrainTiles = function (
    vb,
    lb,
    bz,
    cam,
    tgt,
    camPos,
    visibleKeys,
    tilesToLoad,
  ) {
    const t0 = performance.now();
    orig.call(this, vb, lb, bz, cam, tgt, camPos, visibleKeys, tilesToLoad);
    collectMs += performance.now() - t0;
    collectStats = {
      visible: visibleKeys.size,
      toLoad: tilesToLoad.length,
      cap: this.maxTilesPerView,
    };
  };
}

// ── 插桩：记录 cancelExcept 的抖动规模（旋转/移动时被丢弃的排队与在途请求） ──
const cancelStats = { calls: 0, droppedPending: 0, abortedLoading: 0, droppedRenders: 0 };
{
  const proto = CesiumTerrainLayer.prototype;
  const orig = proto.cancelExcept;
  proto.cancelExcept = function (visibleKeys, retainedKeys) {
    const p0 = this.pending.length;
    const l0 = this.loading.size;
    const r0 = this.pendingTerrainRenders.length;
    orig.call(this, visibleKeys, retainedKeys);
    cancelStats.calls++;
    cancelStats.droppedPending += Math.max(0, p0 - this.pending.length);
    cancelStats.abortedLoading += Math.max(0, l0 - this.loading.size);
    cancelStats.droppedRenders += Math.max(0, r0 - this.pendingTerrainRenders.length);
  };
}

// ── 可选实验开关 ──
//   DIAG_NOPIXEL=1 → 把 pixelSize 归零，隔离 LOD 判据里的两条条件
//   DIAG_NOCLIP=1  → 把 visiblePixelSize 还原成未裁剪的 pixelSize（A/B 对照）
if (process.env.DIAG_NOPIXEL === "1") {
  const proto = CesiumTerrainLayer.prototype;
  const origProj = proto.getTerrainTileProjection;
  proto.getTerrainTileProjection = function (...args) {
    const result = origProj.apply(this, args);
    return { ...result, pixelSize: 0 };
  };
}
if (process.env.DIAG_NOCLIP === "1") {
  const proto = CesiumTerrainLayer.prototype;
  const origProj = proto.getTerrainTileProjection;
  proto.getTerrainTileProjection = function (...args) {
    const result = origProj.apply(this, args);
    return { ...result, visiblePixelSize: result.pixelSize };
  };
}

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const EARTH_RADIUS = 6378137;
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLayer(gis) {
  const layer = new CesiumTerrainLayer(
    gis,
    { terrainUrl: TERRAIN_BASE, accessToken: "" },
    {
      minZoom: 1,
      maxZoom: 15,
      maxConcurrent: 10,
      maxQueueSize: 160,
      maxRequestsPerFrame: 8,
      maxTileRendersPerFrame: 4,
      tileYOrigin: "south",
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
      // DIAG_FREEZE=1 → 手势期间完全冻结影像升级（旧行为），用于 A/B 对照；
      // 通过初始化选项 imageryInteractingBudget: 0 实现
      ...(process.env.DIAG_FREEZE === "1" ? { imageryInteractingBudget: 0 } : {}),
    },
  );
  return layer;
}

/** heading: 0=向北看, 90=向东看, 180=向南看, 270=向西看（y 轴 = 正北, x 轴 = 正东） */
function makeCameraHeading(target, altitude, pitchDeg, headingDeg) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  setCameraHeading(camera, target, altitude, pitchDeg, headingDeg);
  return camera;
}

/** 原地改变朝向（相机与目标距离不变，只转方位，便于隔离"旋转"这一变量） */
function setCameraHeading(camera, target, altitude, pitchDeg, headingDeg) {
  const pitch = (pitchDeg * Math.PI) / 180;
  const heading = (headingDeg * Math.PI) / 180;
  const distance = altitude / Math.sin(pitch);
  const look = new THREE.Vector3(Math.sin(heading), Math.cos(heading), 0);
  camera.position.set(
    target.x - look.x * distance * Math.cos(pitch),
    target.y - look.y * distance * Math.cos(pitch),
    target.z + altitude,
  );
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
}

function runViewUpdate(layer, camera, target, gis, lat) {
  const cameraDistance = camera.position.distanceTo(target);
  const bounds = cornersToLngLatBounds(getViewGroundCorners(camera, target.z), gis);
  if (!bounds) return null;
  const cameraHeight = Math.max(camera.position.z - target.z, 1);
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

function findRenderedTile(layer, lng, lat) {
  let best = null;
  for (const [key, entry] of layer.loadedTiles ?? []) {
    if (!entry.mesh.visible) continue;
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!best || zoom > best.zoom) best = { key, x, y, zoom, entry };
  }
  return best;
}

/** 选中集里覆盖该点的最细瓦片（= 这一块最终会被请求/渲染的那块） */
function findSelectedTile(layer, lng, lat) {
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
 * 复算每块选中瓦片的投影盒分量：判据用的 pixelSize = max(宽px, 高px)，
 * 这里把"宽"和"高"分开统计，才能看出方向偏差来自哪个轴。
 */
function dumpProjectionSplit(layer, camera) {
  const tmp = new THREE.Vector3();
  let n = 0;
  let wSum = 0;
  let hSum = 0;
  let pSum = 0;
  const byZoom = new Map();
  for (const key of layer.currentVisibleKeys ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
    const pts = [
      [b.west, b.north],
      [b.east, b.north],
      [b.east, b.south],
      [b.west, b.south],
      [(b.west + b.east) / 2, (b.south + b.north) / 2],
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [lng, lat] of pts) {
      const p = layer.gis.lngLatToThree(lng, lat, 0).clone().project(camera);
      if (p.z < -1 || p.z > 1) continue;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) continue;
    const w = ((maxX - minX) * VIEWPORT_WIDTH) / 2;
    const h = ((maxY - minY) * VIEWPORT_HEIGHT) / 2;
    n++;
    wSum += w;
    hSum += h;
    pSum += Math.max(w, h);
    const slot = byZoom.get(zoom) ?? { count: 0, w: 0, h: 0 };
    slot.count++;
    slot.w += w;
    slot.h += h;
    byZoom.set(zoom, slot);
  }
  void tmp;
  return {
    count: n,
    meanW: n ? wSum / n : 0,
    meanH: n ? hSum / n : 0,
    meanP: n ? pSum / n : 0,
    byZoom: [...byZoom.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(
        ([zoom, s]) =>
          `z${zoom}:n${s.count} w${(s.w / s.count).toFixed(0)} h${(s.h / s.count).toFixed(0)}`,
      ),
  };
}

function buildScreenSamples(camera, gis, planeZ) {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
  const horizon =
    EARTH_RADIUS *
    Math.acos(EARTH_RADIUS / (EARTH_RADIUS + Math.max(camera.position.z - planeZ, 1)));
  const rows = 6;
  const cols = 9;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const ndcY = -0.9 + (1.8 * r) / (rows - 1);
    const row = [];
    for (let c = 0; c < cols; c++) {
      const ndcX = -0.9 + (1.8 * c) / (cols - 1);
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hit)) continue;
      // 几何地平线之外 = 天空，不参与统计
      if (Math.hypot(hit.x - camera.position.x, hit.y - camera.position.y) > horizon * 1.02) continue;
      const [lng, lat] = gis.threeToLngLat(hit);
      row.push({ ndcX, ndcY, lng, lat });
    }
    if (row.length > 0) grid.push({ ndcY, points: row });
  }
  return grid;
}

function sampleRow(layer, row) {
  let total = 0;
  let ready = 0;
  let sharp = 0;
  let hole = 0;
  let selectedZoomSum = 0;
  let selectedCount = 0;
  for (const point of row.points) {
    total++;
    const selected = findSelectedTile(layer, point.lng, point.lat);
    if (selected) {
      selectedZoomSum += selected.zoom;
      selectedCount++;
    } else {
      hole++;
    }
    const tile = findRenderedTile(layer, point.lng, point.lat);
    if (!tile) continue;
    const entry = tile.entry;
    if (entry.imageryReady) ready++;
    const ideal = layer.getTileImageryZoom(tile.x, tile.y, tile.zoom);
    if (entry.imageryReady && entry.imageryZoom >= ideal) sharp++;
  }
  return {
    total,
    ready,
    sharp,
    hole,
    selectedAvgZoom: selectedCount ? selectedZoomSum / selectedCount : 0,
  };
}

async function runHeading(ctx, heading, duration, sampleMs) {
  const { gis, target, lng, lat, altitude, pitch } = ctx;
  terrainRequests = 0;
  imageryRequests = 0;
  queuedRequests = 0;
  inFlightByHost.clear();
  collectStats = null;
  collectMs = 0;

  const layer = createLayer(gis);
  await idle(60);
  const camera = makeCameraHeading(target, altitude, pitch, heading);
  const grid = buildScreenSamples(camera, gis, target.z);

  const bounds0 = cornersToLngLatBounds(getViewGroundCorners(camera, target.z), gis);
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((lat * Math.PI) / 180);
  const aabbW = bounds0 ? (bounds0.east - bounds0.west) * kmPerDegLng : 0;
  const aabbH = bounds0 ? (bounds0.north - bounds0.south) * kmPerDegLat : 0;

  const t0 = Date.now();
  let lastViewUpdate = 0;
  let lastSample = 0;
  const timeline = [];
  const firstSharp = new Array(grid.length).fill(null);
  let totalUpdates = 0;
  let truncatedUpdates = 0;
  const stopReasons = { visitedBudget: 0, maxTilesPerView: 0 };

  while (Date.now() - t0 < duration) {
    const now = Date.now() - t0;
    if (now - lastViewUpdate >= 200) {
      runViewUpdate(layer, camera, target, gis, lat);
      lastViewUpdate = now;
      totalUpdates++;
      const stoppedBy = layer.getCacheStats().traversal.stoppedBy;
      if (stoppedBy) {
        truncatedUpdates++;
        stopReasons[stoppedBy]++;
      }
    }
    layer.update();
    if (now - lastSample >= sampleMs) {
      lastSample = now;
      const rows = grid.map((row) => sampleRow(layer, row));
      rows.forEach((r, i) => {
        if (firstSharp[i] === null && r.total > 0 && r.sharp >= r.total) firstSharp[i] = now;
      });
      timeline.push({ t: now, rows });
    }
    await idle(12);
  }

  const last = timeline[timeline.length - 1];
  const elapsedSec = duration / 1000;
  const out = {
    heading,
    aabbW,
    aabbH,
    selected: collectStats ? collectStats.visible : 0,
    cap: collectStats ? collectStats.cap : 0,
    toLoad: collectStats ? collectStats.toLoad : 0,
    collectMs,
    terrainRequests,
    imageryRequests,
    terrainPerSec: terrainRequests / elapsedSec,
    imageryPerSec: imageryRequests / elapsedSec,
    holeNear: last.rows.slice(0, 2).reduce((a, r) => a + r.hole, 0),
    holeFar: last.rows.slice(-2).reduce((a, r) => a + r.hole, 0),
    holeTotal: last.rows.reduce((a, r) => a + r.hole, 0),
    traversal: layer.getCacheStats().traversal,
    projSplit: dumpProjectionSplit(layer, camera),
    stopReason: stopReasons,
    totalUpdates,
    truncatedUpdates,
    sharpRate: last.rows.reduce((a, r) => a + r.sharp, 0) /
      Math.max(1, last.rows.reduce((a, r) => a + r.total, 0)),
    selectedZoomByRow: last.rows.map((r) => r.selectedAvgZoom),
    firstSharp,
    gridSize: grid.map((g) => g.points.length),
    layer,
    grid,
  };
  return out;
}

/**
 * 持续旋转模式：相机绕目标匀速转一整圈，把每帧指标按当前朝向分桶。
 * 这直接复现"转动视角时请求不流畅"——同一圈里哪些朝向请求速率掉、抖动大。
 */
async function runRotation(ctx, duration, sampleMs, speedDegPerSec, interacting) {
  const { gis, target, lng, lat, altitude, pitch } = ctx;
  terrainRequests = 0;
  imageryRequests = 0;
  queuedRequests = 0;
  inFlightByHost.clear();
  imageryUrls.clear();
  collectStats = null;
  collectMs = 0;
  Object.assign(cancelStats, { calls: 0, droppedPending: 0, abortedLoading: 0, droppedRenders: 0 });

  const layer = createLayer(gis);
  await idle(60);
  // 真实示例：手势期间 setCameraInteracting(true) → 完全跳过影像升级
  if (interacting) layer.setCameraInteracting(true);

  const camera = makeCameraHeading(target, altitude, pitch, 0);

  const BUCKETS = 8;
  const buckets = Array.from({ length: BUCKETS }, () => ({
    frames: 0,
    ms: 0,
    viewUpdates: 0,
    terrain: 0,
    imagery: 0,
    pending: 0,
    loading: 0,
    selected: 0,
    selectMs: 0,
    collectMs: 0,
  }));
  const series = [];
  const t0 = Date.now();
  let lastViewUpdate = 0;
  let lastSample = 0;
  let lastSeries = 0;
  let lastFrameAt = Date.now();
  let prevTerrain = 0;
  let prevImagery = 0;
  let lastSelected = 0;

  while (Date.now() - t0 < duration) {
    const now = Date.now() - t0;
    const heading = (((speedDegPerSec * now) / 1000) % 360 + 360) % 360;
    setCameraHeading(camera, target, altitude, pitch, heading);
    const bucket = buckets[Math.min(BUCKETS - 1, Math.floor(heading / (360 / BUCKETS)))];
    const frameAt = Date.now();
    const dt = frameAt - lastFrameAt;
    lastFrameAt = frameAt;

    if (now - lastViewUpdate >= 200) {
      lastViewUpdate = now;
      const c0 = collectMs;
      const t1 = performance.now();
      runViewUpdate(layer, camera, target, gis, lat);
      bucket.selectMs += performance.now() - t1;
      bucket.collectMs += collectMs - c0;
      bucket.viewUpdates++;
      lastSelected = collectStats ? collectStats.visible : 0;
    }
    layer.update();

    const dT = terrainRequests - prevTerrain;
    const dI = imageryRequests - prevImagery;
    prevTerrain = terrainRequests;
    prevImagery = imageryRequests;

    bucket.frames++;
    bucket.ms += dt;
    bucket.terrain += dT;
    bucket.imagery += dI;
    bucket.pending += layer.pending.length;
    bucket.loading += layer.loading.size;
    bucket.selected += lastSelected;

    if (now - lastSample >= sampleMs) {
      lastSample = now;
      // 采样网格必须按"当前相机"重建：固定世界点会随旋转离开视野，误判成缺口
      const gridNow = buildScreenSamples(camera, gis, target.z);
      const rows = gridNow.map((row) => sampleRow(layer, row));
      const total = rows.reduce((a, r) => a + r.total, 0);
      const sharp = rows.reduce((a, r) => a + r.sharp, 0);
      const hole = rows.reduce((a, r) => a + r.hole, 0);
      if (now - lastSeries >= sampleMs * 2) {
        lastSeries = now;
        series.push({
          t: now,
          heading,
          terrainReq: terrainRequests,
          imageryReq: imageryRequests,
          pending: layer.pending.length,
          loading: layer.loading.size,
          selected: lastSelected,
          loaded: layer.loadedTiles.size,
          sharp: total ? sharp / total : 0,
          hole,
          total,
        });
      }
    }
    await idle(12);
  }

  const elapsedSec = duration / 1000;
  const dirName = (h) =>
    ({
      0: "北",
      45: "东北",
      90: "东",
      135: "东南",
      180: "南",
      225: "西南",
      270: "西",
      315: "西北",
    }[h] ?? String(h));

  console.log(
    `位置 (${lng}, ${lat}) | 高度 ${altitude}m | 俯仰 ${pitch}° | 旋转 ${speedDegPerSec}°/s 持续 ${(
      duration / 1000
    ).toFixed(1)}s | 影像延迟 ${LATENCY_MS}ms | ` +
      `手势中影像升级=${interacting ? "限速（每次更新放行 imageryInteractingBudget 块）" : "不限速（模拟松手后）"}\n`,
  );
  console.log("=== 按朝向分桶（每帧累加，速率用该朝向的真实驻留时长归一） ===");
  console.log("朝向 | 帧数 | 驻留ms | 地形req/s | 影像req/s | 平均待载 | 平均在途 | 平均选中 | 选取ms/次");
  for (let i = 0; i < BUCKETS; i++) {
    const b = buckets[i];
    const secs = b.ms / 1000;
    const perSec = (v) => (secs > 0 ? (v / secs).toFixed(1) : "-");
    console.log(
      `${dirName(i * 45).padStart(4)} | ${String(b.frames).padStart(4)} | ${String(b.ms).padStart(
        6,
      )} | ${perSec(b.terrain).padStart(9)} | ${perSec(b.imagery).padStart(9)} | ${(
        b.pending / Math.max(1, b.frames)
      )
        .toFixed(1)
        .padStart(8)} | ${(b.loading / Math.max(1, b.frames)).toFixed(1).padStart(8)} | ` +
        `${(b.selected / Math.max(1, b.viewUpdates)).toFixed(1).padStart(8)} | ` +
        `${(b.selectMs / Math.max(1, b.viewUpdates)).toFixed(1).padStart(8)}`,
    );
  }

  console.log("\n=== 时序（每 2 个采样点一行）===");
  console.log("  时间ms | 朝向 | 地形req | 影像req | 待载 | 在途 | 选中 | 已载块 | 清晰率 | 无覆盖");
  for (const s of series) {
    console.log(
      `${String(s.t).padStart(8)} | ${s.heading.toFixed(0).padStart(4)} | ${String(s.terrainReq).padStart(
        7,
      )} | ${String(s.imageryReq).padStart(7)} | ${String(s.pending).padStart(4)} | ${String(
        s.loading,
      ).padStart(4)} | ${String(s.selected).padStart(4)} | ${String(s.loaded).padStart(6)} | ` +
        `${(100 * s.sharp).toFixed(0).padStart(5)}% | ${String(s.hole).padStart(6)}`,
    );
  }

  console.log(
    `\n=== 取消抖动（累计 ${elapsedSec.toFixed(1)}s）===\n` +
      `  cancelExcept 调用 ${cancelStats.calls} 次；丢弃排队请求 ${cancelStats.droppedPending} 个；` +
      `中止在途请求 ${cancelStats.abortedLoading} 个；丢弃已开工渲染 ${cancelStats.droppedRenders} 个`,
  );
  console.log(
    `  总请求：地形 ${terrainRequests} (${(terrainRequests / elapsedSec).toFixed(1)}/s)、` +
      `影像 ${imageryRequests} (${(imageryRequests / elapsedSec).toFixed(1)}/s)`,
  );
  console.log(
    `  影像去重后 ${imageryUrls.size} 个不同 URL → 重复率 ` +
      `${(100 * (1 - imageryUrls.size / Math.max(1, imageryRequests))).toFixed(1)}%` +
      `（重复率高说明同一批瓦片被反复下载，纯浪费带宽与服务端配额）`,
  );

  layer.dispose();
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 1200);
  const pitch = Number(process.argv[5] ?? 40);
  LATENCY_MS = Number(process.argv[6] ?? 60);
  const duration = Number(process.argv[7] ?? 5000);
  const headings = String(process.argv[8] ?? "0,90,180,270,45,135,225,315")
    .split(",")
    .map(Number);
  const sampleMs = 250;

  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const ctx = { gis, target, lng, lat, altitude, pitch };

  const originalWarn = console.warn;
  console.warn = () => {};

  if (process.argv[8] === "rotate") {
    const speed = Number(process.argv[9] ?? 60);
    const interacting = process.argv[10] === "interact";
    await runRotation(ctx, duration, sampleMs, speed, interacting);
    console.warn = originalWarn;
    return;
  }

  console.log(
    `位置 (${lng}, ${lat}) | 高度 ${altitude}m | 俯仰 ${pitch}° | 影像延迟 ${LATENCY_MS}ms | 每 host 并发 ${MAX_PER_HOST}`,
  );
  console.log(`每方位用全新图层实例；采样行 NDC-Y 下[近] → 上[远]。\n`);

  const results = [];
  for (const heading of headings) {
    const r = await runHeading(ctx, heading, duration, sampleMs);
    results.push(r);
    const dirName = (h) =>
      ({ 0: "北", 45: "东北", 90: "东", 135: "东南", 180: "南", 225: "西南", 270: "西", 315: "西北" }[h] ??
        String(h));
    console.log(
      `方位 ${dirName(heading)}(${heading}°) | AABB ${r.aabbW.toFixed(0)}x${r.aabbH.toFixed(0)}km ` +
        `(面积${((r.aabbW * r.aabbH) / 1000).toFixed(1)}k km²) | 选中 ${r.selected}/${r.cap}` +
        `${r.selected >= r.cap ? " ★撞上限" : ""} | 待载 ${r.toLoad} | 选取耗时 ${r.collectMs.toFixed(1)}ms`,
    );
    console.log(
      `   请求：地形 ${r.terrainRequests} (${r.terrainPerSec.toFixed(1)}/s) 影像 ${r.imageryRequests} (${r.imageryPerSec.toFixed(1)}/s) | ` +
        `无覆盖点 近${r.holeNear} 远${r.holeFar} 合计${r.holeTotal} | 末态清晰率 ${(100 * r.sharpRate).toFixed(0)}%`,
    );
    console.log(
      `   遍历：根 ${r.traversal.roots} | 访问 ${r.traversal.visited}/${r.traversal.maxVisited} | ` +
        `接受 ${r.traversal.accepted} | 截断 ${r.truncatedUpdates}/${r.totalUpdates} 次` +
        `${r.traversal.stoppedBy ? ` (末次原因 ${r.traversal.stoppedBy})` : ""} | ` +
        `截断原因累计 visited=${r.stopReason.visitedBudget} cap=${r.stopReason.maxTilesPerView}`,
    );
    console.log(
      `   末态各选中层级(近→远)：${r.selectedZoomByRow.map((z) => z.toFixed(1)).join(" ")}`,
    );
    console.log(
      `   投影盒分量：均值 宽${r.projSplit.meanW.toFixed(0)}px 高${r.projSplit.meanH.toFixed(0)}px ` +
        `→ max=${r.projSplit.meanP.toFixed(0)}px（判据阈值 1024）\n     ` +
        r.projSplit.byZoom.join("  "),
    );
    r.layer.dispose();
    await idle(120);
  }

  // ── 对照表 ──
  console.log("=".repeat(110));
  console.log("汇总（同一机位，仅改朝向）");
  console.log("=".repeat(110));
  console.log(
    "方位 |  AABB面积 | 选中 | 撞上限 | 地形req | 影像req | 影像req/s | 无覆盖 | 末态清晰率 | 各行达标耗时(ms)",
  );
  for (const r of results) {
    console.log(
      `${String(r.heading).padStart(4)} | ${((r.aabbW * r.aabbH) / 1000).toFixed(1).padStart(8)}k | ` +
        `${String(r.selected).padStart(4)} | ${(r.selected >= r.cap ? "是" : "否").padStart(6)} | ` +
        `${String(r.terrainRequests).padStart(7)} | ${String(r.imageryRequests).padStart(7)} | ` +
        `${r.imageryPerSec.toFixed(1).padStart(9)} | ${String(r.holeTotal).padStart(6)} | ` +
        `${(100 * r.sharpRate).toFixed(0).padStart(9)}% | ` +
        r.firstSharp
          .map((t, i) => (t === null ? `行${i}:${"-".padStart(4)}` : `行${i}:${String(t).padStart(4)}`))
          .join(" "),
    );
  }

  console.warn = originalWarn;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

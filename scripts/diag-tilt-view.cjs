/**
 * 诊断：倾斜视角下瓦片选择是否“跑到了很远的地方”，以及每帧开销。
 *
 * 用真实 CesiumTerrainLayer（桩掉 DOM/网络 + 合成 quantized-mesh），
 * 对多组（高度, 俯仰角）组合各跑预热 + 稳态，统计：
 *   - 可见瓦片数量、层级分布
 *   - 可见瓦片中心到相机的距离分布（max / p90 / 超出 2×相机距离的个数）
 *   - 地形请求数、影像请求数（按层级）、拼接画布创建数
 *   - updateTilesInView / update / collectQuadtreeTerrainTiles 每轮耗时
 *
 * 运行：node scripts/diag-tilt-view.cjs [lng] [lat]
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
let canvasPixels = 0; // 所有拼接画布的像素总量（衡量拼接成本）
const canvasSizes = new Map();
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
  let counted = false;
  const record = () => {
    if (counted || !width || !height) return;
    counted = true;
    canvasPixels += width * height;
    const bucket = `${width}x${height}`;
    canvasSizes.set(bucket, (canvasSizes.get(bucket) ?? 0) + 1);
  };
  Object.defineProperty(element, "width", {
    get: () => width,
    set: (value) => {
      width = value;
      record();
    },
  });
  Object.defineProperty(element, "height", {
    get: () => height,
    set: (value) => {
      height = value;
      record();
    },
  });
  return element;
};
global.document = {
  createElement: (tag) => {
    if (tag === "canvas") canvasCreated++;
    return fakeCanvas();
  },
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
let terrainRequests = [];
let imageryRequests = [];
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
  const terrainMatch = target.match(/\/(\d+)\/(-?\d+)\/(-?\d+)\.terrain/);
  if (terrainMatch) {
    terrainRequests.push({ z: Number(terrainMatch[1]) });
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  const imageryMatch = target.match(/[?&]z=(\d+)/);
  if (imageryMatch) {
    imageryRequests.push({ z: Number(imageryMatch[1]) });
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)]) };
  }
  return { ok: false, status: 404, blob: async () => new Blob(["x"]) };
};

// ── 真实模块 + 计时插桩 ────────────────────────────────────────
const THREE = require(path.join(ROOT, "node_modules/three"));
const { CesiumTerrainLayer } = require(path.join(
  ROOT,
  "lib/sources/engine/layers/CesiumTerrainLayer.ts",
));
const { WebMercatorGIS } = require(path.join(ROOT, "lib/sources/gis/WebMercatorGIS.ts"));
const {
  getSuggestZoom,
  getHorizonDistance,
  getViewGroundCorners,
  cornersToLngLatBounds,
} = require(path.join(ROOT, "lib/sources/engine/utils/camera-utils.ts"));

const timers = {
  updateTilesInView: { ms: 0, n: 0, max: 0 },
  update: { ms: 0, n: 0, max: 0 },
  collectQuadtreeTerrainTiles: { ms: 0, n: 0, max: 0 },
  updateTerrainChildOcclusion: { ms: 0, n: 0, max: 0 },
  hideCoveredAncestors: { ms: 0, n: 0, max: 0 },
  processTerrainRenderQueue: { ms: 0, n: 0, max: 0 },
  processStitchQueue: { ms: 0, n: 0, max: 0 },
};
let fetchImageryCalls = 0;
let tracking = false;

{
  const proto = CesiumTerrainLayer.prototype;
  for (const name of Object.keys(timers)) {
    const original = proto[name];
    proto[name] = function (...args) {
      if (!tracking) return original.apply(this, args);
      const t0 = performance.now();
      const result = original.apply(this, args);
      const dt = performance.now() - t0;
      const slot = timers[name];
      slot.ms += dt;
      slot.n += 1;
      if (dt > slot.max) slot.max = dt;
      return result;
    };
  }
  const originalFetchImagery = proto.fetchImagery;
  proto.fetchImagery = function (...args) {
    if (tracking) fetchImageryCalls++;
    return originalFetchImagery.apply(this, args);
  };
}

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
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

/** 俯仰角 = 相机视线与地面夹角（度）。pitch 小 → 更贴近水平，能看到地平线。 */
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

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function measure(lng, lat, altitude, pitchDeg, warmupRounds, steadyRounds) {
  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(60);
  const camera = makeCamera(target, altitude, pitchDeg);

  for (let i = 0; i < warmupRounds; i++) {
    runViewUpdate(layer, camera, target, gis, lat);
    await idle(40);
  }

  // 稳态统计
  for (const slot of Object.values(timers)) {
    slot.ms = 0;
    slot.n = 0;
    slot.max = 0;
  }
  fetchImageryCalls = 0;
  terrainRequests = [];
  imageryRequests = [];
  canvasCreated = 0;
  canvasPixels = 0;
  canvasSizes.clear();
  tracking = true;
  const bounds = runViewUpdate(layer, camera, target, gis, lat);
  tracking = false;

  // 可见瓦片：层级分布 + 距离分布
  const keys = [...(layer.currentVisibleKeys ?? [])];
  const distances = [];
  const zoomHistogram = new Map();
  const byDistance = new Map(); // 距离桶 → 层级集合
  let maxZoom = 0;
  for (const key of keys) {
    const [x, y, zoom] = key.split(",").map(Number);
    const tile = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
    const center = gis.lngLatToThree(
      (tile.west + tile.east) / 2,
      (tile.south + tile.north) / 2,
      0,
    );
    const distance = center.distanceTo(camera.position);
    distances.push(distance);
    zoomHistogram.set(zoom, (zoomHistogram.get(zoom) ?? 0) + 1);
    if (zoom > maxZoom) maxZoom = zoom;
    const bucket = Math.round(Math.log2(Math.max(distance, 1)));
    if (!byDistance.has(bucket)) byDistance.set(bucket, new Set());
    byDistance.get(bucket).add(zoom);
  }
  const cameraDistance = camera.position.distanceTo(target);
  const far = distances.filter((d) => d > cameraDistance * 2).length;
  const horizon = getHorizonDistance(altitude);

  // 稳态：再跑 steadyRounds 轮，统计是否还有重复工作
  for (const slot of Object.values(timers)) {
    slot.ms = 0;
    slot.n = 0;
    slot.max = 0;
  }
  fetchImageryCalls = 0;
  canvasCreated = 0;
  const perRoundFetch = [];
  const perRoundStitch = [];
  tracking = true;
  for (let i = 0; i < steadyRounds; i++) {
    const fetchBefore = fetchImageryCalls;
    runViewUpdate(layer, camera, target, gis, lat);
    perRoundFetch.push(fetchImageryCalls - fetchBefore);
    perRoundStitch.push(layer.getCacheStats().stitchPending);
    await idle(30);
  }
  tracking = false;

  layer.dispose();

  return {
    altitude,
    pitchDeg,
    cameraDistance,
    horizon,
    viewKm: bounds ? ((bounds.east - bounds.west) * 111 * Math.cos((lat * Math.PI) / 180)).toFixed(0) : "?",
    visible: keys.length,
    maxZoom,
    zoomHistogram: [...zoomHistogram.entries()].sort((a, b) => a[0] - b[0]),
    maxDistanceKm: (Math.max(0, ...distances) / 1000).toFixed(0),
    p90DistanceKm: (percentile(distances, 90) / 1000).toFixed(0),
    farTiles: far,
    distanceBuckets: [...byDistance.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, zooms]) => `${Math.pow(2, bucket) / 1000}km:z${Math.max(...zooms)}`),
    terrainRequests: terrainRequests.length,
    imageryRequests: imageryRequests.length,
    imageryZoomHistogram: [...imageryRequests
      .reduce((map, item) => map.set(item.z, (map.get(item.z) ?? 0) + 1), new Map())
      .entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([z, count]) => `z${z}×${count}`)
      .join(" "),
    steadyFetchImagery: fetchImageryCalls,
    steadyCanvas: canvasCreated,
    updateTilesInViewAvg: timers.updateTilesInView.ms / Math.max(1, timers.updateTilesInView.n),
    updateTilesInViewMax: timers.updateTilesInView.max,
    updateAvg: timers.update.ms / Math.max(1, timers.update.n),
    collectAvg: timers.collectQuadtreeTerrainTiles.ms / Math.max(1, timers.collectQuadtreeTerrainTiles.n),
    occlusionAvg:
      timers.updateTerrainChildOcclusion.ms / Math.max(1, timers.updateTerrainChildOcclusion.n),
    occlusionMax: timers.updateTerrainChildOcclusion.max,
    hideCoveredAvg: timers.hideCoveredAncestors.ms / Math.max(1, timers.hideCoveredAncestors.n),
    renderQueueAvg:
      timers.processTerrainRenderQueue.ms / Math.max(1, timers.processTerrainRenderQueue.n),
    stitchQueueAvg: timers.processStitchQueue.ms / Math.max(1, timers.processStitchQueue.n),
    rounds: steadyRounds,
    perRoundFetch,
    perRoundStitch,
    canvasSizes: [...canvasSizes.entries()].map(([size, count]) => `${size}×${count}`).join(" "),
    canvasPixelMp: (canvasPixels / 1e6).toFixed(1),
  };
}

(async () => {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const cases =
    process.argv[4] !== undefined
      ? [[Number(process.argv[4]), Number(process.argv[5] ?? 25)]]
      : [
          [400, 55],
          [400, 25],
          [2000, 55],
          [2000, 25],
          [8000, 20],
          [20000, 15],
        ];
  const originalWarn = console.warn;
  console.warn = () => {};
  console.log(`位置 (${lng}, ${lat}) | availability 层级数=${metadata.available?.length ?? 0}`);
  console.log(
    "高度 | 俯仰 | 视野宽km | 地平线km | 可见 | 最深z | 最远km | p90km | >2d | 地形req | 影像req | 层级分布",
  );
  console.log("-".repeat(150));
  for (const [altitude, pitch] of cases) {
    const r = await measure(lng, lat, altitude, pitch, 30, 20);
    console.log(
      `${String(r.altitude).padStart(5)} | ${String(r.pitchDeg).padStart(3)}° | ${String(
        r.viewKm,
      ).padStart(8)} | ${String((r.horizon / 1000).toFixed(0)).padStart(8)} | ${String(
        r.visible,
      ).padStart(4)} | ${String(r.maxZoom).padStart(5)} | ${String(r.maxDistanceKm).padStart(
        6,
      )} | ${String(r.p90DistanceKm).padStart(5)} | ${String(r.farTiles).padStart(3)} | ${String(
        r.terrainRequests,
      ).padStart(7)} | ${String(r.imageryRequests).padStart(7)} | ${r.imageryZoomHistogram}`,
    );
    console.log(
      `      每轮耗时: updateTilesInView ${r.updateTilesInViewAvg.toFixed(
        1,
      )}ms | update ${r.updateAvg.toFixed(1)}ms | 其中 occlusion ${r.occlusionAvg.toFixed(
        1,
      )}ms(峰值 ${r.occlusionMax.toFixed(1)}ms) hideCovered ${r.hideCoveredAvg.toFixed(
        2,
      )}ms renderQueue ${r.renderQueueAvg.toFixed(2)}ms stitch ${r.stitchQueueAvg.toFixed(
        2,
      )}ms | 稳态 fetchImagery=${r.steadyFetchImagery} canvas=${r.steadyCanvas}`,
    );
    console.log(`      距离分桶(最大层级): ${r.distanceBuckets.join(" ") || "无"}`);
    console.log(`      层级分布: ${r.zoomHistogram.map(([z, c]) => `z${z}×${c}`).join(" ")}`);
    console.log(
      `      画布尺寸分布: ${r.canvasSizes || "无"} | 总像素 ${r.canvasPixelMp}MP`,
    );
    console.log(
      `      稳态每轮 fetchImagery: [${r.perRoundFetch.join(",")}] | 每轮队列剩余: [${r.perRoundStitch.join(",")}]`,
    );
  }
  console.warn = originalWarn;
})();

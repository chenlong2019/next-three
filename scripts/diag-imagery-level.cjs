/**
 * 诊断：地形图层实际会向 Google 请求到第几级影像？
 *
 * 用 TypeScript 编译器 API 直接在 Node 里 require 真实的 CesiumTerrainLayer.ts
 * （不复制逻辑），把 DOM/网络换成桩，注入合成 quantized-mesh，用真实的地形
 * availability（从 Cesium Ion layer.json 缓存）驱动不同相机高度，统计真正发出
 * 的影像请求层级。
 *
 * 运行：
 *   node scripts/diag-imagery-level.cjs [lng] [lat]
 * 首次运行会联网拉取 layer.json 并缓存到 scripts/.terrain-metadata.json。
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

// ── 浏览器 API 桩 ──────────────────────────────────────────────
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
global.document = { createElement: () => fakeCanvas(), createElementNS: () => fakeCanvas() };
global.createImageBitmap = async (blob) => ({ width: 256, height: 256, close() {}, __blob: blob });

// ── 合成 quantized-mesh（4 顶点 / 2 三角面 / 高度 0..100） ─────
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

// ── 真实地形元数据（含 availability） ──────────────────────────
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

let currentRound = 0;
let unmatched = 0;
const imageryRequests = [];
const terrainRequests = [];
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
  const terrainMatch = target.match(/\/(\d+)\/(-?\d+)\/(-?\d+)\.terrain/);
  if (terrainMatch) {
    terrainRequests.push({ z: Number(terrainMatch[1]), round: currentRound });
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  const imageryMatch = target.match(/[?&]z=(\d+)/);
  if (imageryMatch) {
    imageryRequests.push({ z: Number(imageryMatch[1]), round: currentRound });
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)]) };
  }
  unmatched++;
  return { ok: false, status: 404, blob: async () => new Blob(["x"]) };
};

// ── 真实模块 ───────────────────────────────────────────────────
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

// 追踪：getTileImageryZoom 的目标值 vs fetchImagery 实际使用的层级
const targetTrace = new Map();
const fetchTrace = new Map();
{
  const proto = CesiumTerrainLayer.prototype;
  const originalTileZoom = proto.getTileImageryZoom;
  proto.getTileImageryZoom = function (x, y, terrainZoom) {
    const value = originalTileZoom.call(this, x, y, terrainZoom);
    targetTrace.set(`${terrainZoom}->${value}`, (targetTrace.get(`${terrainZoom}->${value}`) ?? 0) + 1);
    return value;
  };
  const originalFetchImagery = proto.fetchImagery;
  proto.fetchImagery = function (x, y, zoom, requested, signal, canvas) {
    const key = `terrainZ${zoom} 请求影像z${requested} 画布上限${canvas}`;
    fetchTrace.set(key, (fetchTrace.get(key) ?? 0) + 1);
    return originalFetchImagery.call(this, x, y, zoom, requested, signal, canvas);
  };
}

// ── 场景参数（与 CesiumTerrainDemo 一致） ─────────────────────
const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const PITCH_DEG = 55;
const MAX_TOOL_ZOOM = 15; // 与 demo 的 maxZoom 一致
const IMAGERY_CANVAS = Number(process.argv[5] ?? 2048);

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
      // 故意用 "auto"：强制走 layer.json，让真实 availability 生效（与线上一致）
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

async function drive(lng, lat, altitude, rounds) {
  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(60); // 等 layer.json 就绪

  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  const pitch = (PITCH_DEG * Math.PI) / 180;
  const distance = altitude / Math.sin(pitch);
  camera.position.set(0, -distance * Math.cos(pitch), altitude);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);

  const observed = { maxImagery: 0, perRound: [], terrainLoaded: new Set(), leaf: new Set() };

  for (let i = 0; i < rounds; i++) {
    currentRound = i;
    const cameraDistance = camera.position.distanceTo(target);
    const bounds = cornersToLngLatBounds(getViewGroundCorners(camera, 0), gis);
    if (!bounds) break;
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
    let roundMax = 0;
    for (const item of imageryRequests) {
      if (item.round === i) {
        if (item.z > roundMax) roundMax = item.z;
        if (item.z > observed.maxImagery) observed.maxImagery = item.z;
      }
    }
    for (const item of terrainRequests) {
      if (item.round === i) observed.terrainLoaded.add(item.z);
    }
    observed.perRound.push(roundMax);
    if (i === 0) {
      for (const key of layer.currentVisibleKeys ?? []) {
        observed.leaf.add(Number(key.slice(key.lastIndexOf(",") + 1)));
      }
    }
    await idle(40);
  }
  layer.dispose();
  return observed;
}

(async () => {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitudes = Number(process.argv[4])
    ? [Number(process.argv[4])]
    : [12000, 5000, 3000, 2000, 1200, 900, 800, 600, 400, 200, 50];

  console.log(
    `位置 (${lng}, ${lat}) | availability 层级数=${metadata.available?.length ?? 0} | maxZoom=${MAX_TOOL_ZOOM} | 影像画布上限=${IMAGERY_CANVAS}`,
  );
  console.log("高度(m) | 地形叶子层 | 地形请求层 | 最深影像z | 逐帧最深 | 影像层级分布");
  console.log("-".repeat(100));
  const originalWarn = console.warn;
  console.warn = () => {};
  for (const altitude of altitudes) {
    imageryRequests.length = 0;
    terrainRequests.length = 0;
    unmatched = 0;
    const result = await drive(lng, lat, altitude, 8);
    const histogram = new Map();
    for (const item of imageryRequests) histogram.set(item.z, (histogram.get(item.z) ?? 0) + 1);
    const dist = [...histogram.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([z, count]) => `z${z}×${count}`)
      .join(" ");
    const terrainDist = [...new Set(terrainRequests.map((item) => item.z))].sort((a, b) => a - b);
    console.log(
      `${String(altitude).padStart(6)} | ${String(Math.max(0, ...result.leaf)).padStart(10)} | [${terrainDist.join(
        ",",
      ).padEnd(11)}] | ${String(result.maxImagery).padStart(9)} | ${result.perRound
        .join(" ")
        .padEnd(26)} | ${dist || "无"}`,
    );
  }
  console.warn = originalWarn;
  if (unmatched > 0) console.log(`未匹配的 URL: ${unmatched}`);
  console.log("\ngetTileImageryZoom 目标（地形层级->影像层级 : 次数）:");
  console.log("  " + [...targetTrace.entries()].map(([k, v]) => `${k} : ${v}`).join(" | "));
  console.log("fetchImagery 调用参数:");
  for (const [k, v] of fetchTrace.entries()) console.log(`  ${k} : ${v} 次`);
})();

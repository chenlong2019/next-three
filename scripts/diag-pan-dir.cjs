/**
 * 诊断：平移手势（拖动）时瓦片的更新情况，对比两个拖动方向。
 *
 * 复刻真实链路：
 *   - OrbitControls 的 pan 数学（screenSpacePanning=false → 沿地平面平移），
 *     相机与 target 一起平移，相机-目标向量不变（距离/俯仰/高度都不变）；
 *   - 每帧（16ms）相机被拖动一次；视图更新走 app 的 200ms 节流；
 *   - 拖动期间 setCameraInteracting(true)（影像升级限流），松手后 false。
 *
 * 每 200ms 采样一次：
 *   - 视图 AABB / 可见集大小 / 未加载的可见瓦片数（miss）
 *   - 遍历是否被预算打断（traversal.stoppedBy）
 *   - 屏幕 近/中/远 三条横带上的「选择层级 vs 已加载层级」
 *   - 累计地形/影像请求数
 *
 * 运行：
 *   node scripts/diag-pan-dir.cjs [lng] [lat] [高度] [俯仰] [拖动像素] [持续时间ms]
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
global.createImageBitmap = async (blob) => ({ width: 256, height: 256, close() {}, __blob: blob });

function buildTerrainBuffer() {
  const TERRAIN_H = Number(process.env.TERRAIN_H ?? 0);
  const vertexCount = 4;
  const buffer = new ArrayBuffer(88 + 4 + vertexCount * 2 * 3 + 4 + 6 * 2);
  const view = new DataView(buffer);
  view.setFloat32(24, 0, true);
  view.setFloat32(28, TERRAIN_H, true);
  view.setUint32(88, vertexCount, true);
  let offset = 92;
  for (const values of [
    [0, 32767, 32767, 0],
    [0, 0, 32767, 32767],
    TERRAIN_H > 0 ? [32767, 32767, 32767, 32767] : [0, 32767, 32767, 0],
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
const IMAGERY_TEMPLATE = "https://mt{s}.example.com/vt/x={x}&y={y}&z={z}";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let LATENCY_MS = 60;
let TERRAIN_LATENCY_MS = 120;
const inFlightByHost = new Map();
const MAX_PER_HOST = 12;

async function simulateNetwork(host, kind) {
  for (;;) {
    const active = inFlightByHost.get(host) ?? 0;
    if (active < MAX_PER_HOST) {
      inFlightByHost.set(host, active + 1);
      break;
    }
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
    await simulateNetwork("terrain.example.com", "terrain");
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  if (/[?&]z=\d+/.test(target)) {
    imageryRequests++;
    await simulateNetwork("mt0.example.com", "imagery");
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

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLayer(gis) {
  return new CesiumTerrainLayer(
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
      prefetchTileBudget: 16,
      revealSpreadMs: 420,
      revealMaxSlotMs: 60,
      revealMaxWaitMs: 400,
      revealMaxPerFrame: 4,
      imageryInteractingBudget: 2,
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

/**
 * 复刻 OrbitControls.pan（screenSpacePanning = false，沿世界地平面平移）。
 * deltaX/deltaY 为像素位移，右/下为正（与 OrbitControls 一致）。
 */
function panCamera(camera, target, deltaXPx, deltaYPx) {
  camera.updateMatrixWorld(true);
  const offset = new THREE.Vector3().copy(camera.position).sub(target);
  let targetDistance = offset.length();
  targetDistance *= Math.tan(((camera.fov / 2) * Math.PI) / 180);
  const panOffset = new THREE.Vector3();
  const vRight = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  panOffset.addScaledVector(vRight, -(2 * deltaXPx * targetDistance) / VIEWPORT_HEIGHT);
  const vUp = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  vUp.crossVectors(camera.up, vUp);
  panOffset.addScaledVector(vUp, (2 * deltaYPx * targetDistance) / VIEWPORT_HEIGHT);
  camera.position.add(panOffset);
  target.add(panOffset);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
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

function sampleAt(camera, gis, ndcX, ndcY) {
  const raycaster = new THREE.Raycaster();
  const terrainZ = Number(process.env.TERRAIN_H ?? 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -terrainZ);
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  const [lng, lat] = gis.threeToLngLat(hit);
  return { lng, lat };
}

const yOriginOf = (layer) => layer.tileYOrigin ?? "south";

function selectedZoomAt(layer, lng, lat) {
  let best = null;
  for (const key of layer.currentVisibleKeys ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, yOriginOf(layer));
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!best || zoom > best.zoom) best = { key, zoom };
  }
  return best;
}

function renderedZoomAt(layer, lng, lat) {
  let best = null;
  for (const [key, entry] of layer.loadedTiles ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, yOriginOf(layer));
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!entry.mesh.visible) continue;
    const mat = entry.mesh.material;
    if ((mat?.opacity ?? 0) <= 0.01) continue;
    if (!best || zoom > best.zoom) best = { key, zoom };
  }
  return best;
}

/** 三条横带（近/中/远）上 5 列的平均「选择层级 / 已上屏层级」，含覆盖列数 */
function bandSummary(layer, camera, gis) {
  const bands = { near: -0.9, mid: 0.0, far: 0.75 };
  const out = {};
  for (const [name, ndcY] of Object.entries(bands)) {
    const selZooms = [];
    const renZooms = [];
    let cols = 0;
    for (const ndcX of [-0.8, -0.4, 0, 0.4, 0.8]) {
      const s = sampleAt(camera, gis, ndcX, ndcY);
      if (!s) continue;
      cols++;
      const sel = selectedZoomAt(layer, s.lng, s.lat);
      const ren = renderedZoomAt(layer, s.lng, s.lat);
      if (sel) selZooms.push(sel.zoom);
      renZooms.push(ren ? ren.zoom : 0);
    }
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    out[name] = { sel: avg(selZooms), ren: avg(renZooms), cols, covered: selZooms.length };
  }
  return out;
}

/** 未加载的可见瓦片、以及"可见集里覆盖底边的瓦片是否已上屏" */
function bottomBandDetail(layer, camera, gis) {
  const rows = [];
  for (const ndcX of [-0.8, -0.4, 0, 0.4, 0.8]) {
    const s = sampleAt(camera, gis, ndcX, -0.92);
    if (!s) continue;
    const sel = selectedZoomAt(layer, s.lng, s.lat);
    const ren = renderedZoomAt(layer, s.lng, s.lat);
    rows.push({
      ndcX,
      lat: s.lat,
      selKey: sel?.key ?? null,
      selZoom: sel?.zoom ?? 0,
      selLoaded: sel ? layer.loadedTiles.has(sel.key) : false,
      renKey: ren?.key ?? null,
      renZoom: ren?.zoom ?? 0,
    });
  }
  return rows;
}

function describeView(layer, camera, target, gis, lat0) {
  const cameraDistance = camera.position.distanceTo(target);
  const cameraHeight = Math.max(camera.position.z, 1);
  const [lng, lat] = gis.threeToLngLat(target);
  const stats = layer.getCacheStats();
  return {
    lng,
    lat,
    cameraDistance,
    cameraHeight,
    terrainZoom: getSuggestZoom(cameraDistance, FOV, VIEWPORT_HEIGHT, lat0),
    imageryZoom: getSuggestZoom(cameraHeight, FOV, VIEWPORT_HEIGHT, lat0),
    visible: (layer.currentVisibleKeys ?? new Set()).size,
    loaded: (layer.loadedTiles ?? new Map()).size,
    queue: (layer.pending ?? []).length,
    stoppedBy: stats.traversal?.stoppedBy ?? "",
    visited: stats.traversal?.visited ?? 0,
    revealPending: stats.revealPending ?? 0,
    stitchPending: stats.stitchPending ?? 0,
    fastZoom: stats.fastZoomActive,
    terrainRequests,
    imageryRequests,
  };
}

async function runDirection({ label, dirPx, lng, lat, altitude, pitch, dragPx, durationMs }) {
  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToTerrainThree
    ? gis.lngLatToTerrainThree(lng, lat, 0)
    : gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(80);
  const camera = makeCamera(target, altitude, pitch);

  const runViewUpdate = () => {
    const cameraDistance = camera.position.distanceTo(target);
    const groundRelief = Math.max(0, layer.getMaxObservedSurfaceHeight() - target.z);
    const bounds = cornersToLngLatBounds(
      getViewGroundCorners(camera, target.z, { groundRelief }),
      gis,
    );
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
  };

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};

  // ── 阶段 1：倾斜后稳定 ──
  for (let i = 0; i < 360; i++) {
    if (i % 12 === 0) runViewUpdate();
    layer.update();
    await idle(16);
  }
  const settled = describeView(layer, camera, target, gis, lat);
  const settledBands = bandSummary(layer, camera, gis);
  console.log(
    `\n===== ${label}（拖动 ${dirPx > 0 ? "向下/朝向相机一侧" : "向上/朝地平线一侧"}）=====`,
  );
  console.log(
    `[起始] 相机高=${settled.cameraHeight.toFixed(0)}m 距离=${settled.cameraDistance.toFixed(0)}m ` +
      `terrainZoom=${settled.terrainZoom} | 可见=${settled.visible} 已加载=${settled.loaded} 队列=${settled.queue} ` +
      `| 选择层级 近${settledBands.near.sel.toFixed(1)} 中${settledBands.mid.sel.toFixed(1)} 远${settledBands.far.sel.toFixed(1)} ` +
      `| 上屏 近${settledBands.near.ren.toFixed(1)} 中${settledBands.mid.ren.toFixed(1)} 远${settledBands.far.ren.toFixed(1)} ` +
      `| 地形请求=${terrainRequests} 影像请求=${imageryRequests}`,
  );

  // ── 阶段 2：拖动 ──
  layer.setCameraInteracting(true);
  const frames = Math.max(1, Math.round(durationMs / 16));
  const perFramePx = (dirPx * dragPx * 16) / durationMs;
  const ticks = [];
  let lastTerrain = terrainRequests;
  let lastImagery = imageryRequests;
  console.log(
    `[拖动] 每帧 ${perFramePx.toFixed(1)}px（共 ${dragPx}px / ${durationMs}ms），视图更新节流 200ms`,
  );
  console.log(
    "  时刻 | target纬度 | 视图AABB纬度[南,北] | 可见/已加载/队列 | 本轮新增地形/影像 | 未加载可见数 | 遍历(visited,stoppedBy) | 选择层级 近/中/远 | 上屏 近/中/远",
  );
  for (let f = 0; f < frames; f++) {
    panCamera(camera, target, 0, perFramePx);
    if (f % 12 === 0 || f === frames - 1) {
      const bounds = runViewUpdate();
      layer.update();
      const d = describeView(layer, camera, target, gis, lat);
      const bands = bandSummary(layer, camera, gis);
      let miss = 0;
      for (const key of layer.currentVisibleKeys ?? new Set()) {
        if (!layer.loadedTiles.has(key)) miss++;
      }
      const dt = terrainRequests - lastTerrain;
      const di = imageryRequests - lastImagery;
      lastTerrain = terrainRequests;
      lastImagery = imageryRequests;
      ticks.push({ t: f * 16, dt, di, miss, bands, d });
      console.log(
        `  ${String(f * 16).padStart(5)}ms | ${d.lat.toFixed(5)} | ` +
          `[${bounds.south.toFixed(5)}, ${bounds.north.toFixed(5)}] | ` +
          `${d.visible}/${d.loaded}/${d.queue} | +${dt}/+${di} | ${miss} | ` +
          `(${d.visited}${d.stoppedBy ? `,${d.stoppedBy}` : ""}) | ` +
          `${bands.near.sel.toFixed(1)}/${bands.mid.sel.toFixed(1)}/${bands.far.sel.toFixed(1)} | ` +
          `${bands.near.ren.toFixed(1)}/${bands.mid.ren.toFixed(1)}/${bands.far.ren.toFixed(1)} | ` +
          `覆盖 近${bands.near.covered}/${bands.near.cols} 中${bands.mid.covered}/${bands.mid.cols} 远${bands.far.covered}/${bands.far.cols}`,
      );
      if (f === frames - 1) {
        const detail = bottomBandDetail(layer, camera, gis);
        for (const row of detail) {
          console.log(
            `      底边 NDC-X ${row.ndcX.toFixed(2)} lat ${row.lat.toFixed(5)} | 选择=${row.selKey ?? "无"} ` +
              `(${row.selLoaded ? "已加载" : "未加载"}) | 最细上屏=${row.renKey ?? "无"}`,
          );
        }
      }
    } else {
      layer.update();
    }
    await idle(16);
  }

  // ── 阶段 3：松手 + 静止恢复 ──
  layer.setCameraInteracting(false);
  for (let i = 0; i < 300; i++) {
    runViewUpdate();
    layer.update();
    await idle(16);
  }
  const after = describeView(layer, camera, target, gis, lat);
  const afterBands = bandSummary(layer, camera, gis);
  console.log(
    `[松手 4.8s 后] 可见=${after.visible} 已加载=${after.loaded} 队列=${after.queue} ` +
      `| 选择层级 近${afterBands.near.sel.toFixed(1)} 中${afterBands.mid.sel.toFixed(1)} 远${afterBands.far.sel.toFixed(1)} ` +
      `| 上屏 近${afterBands.near.ren.toFixed(1)} 中${afterBands.mid.ren.toFixed(1)} 远${afterBands.far.ren.toFixed(1)} ` +
      `| 地形请求=${terrainRequests} 影像请求=${imageryRequests}`,
  );

  const totalTerrain = ticks.reduce((a, x) => a + x.dt, 0);
  const totalImagery = ticks.reduce((a, x) => a + x.di, 0);
  const avgMiss = ticks.reduce((a, x) => a + x.miss, 0) / Math.max(1, ticks.length);
  const stopped = ticks.filter((x) => x.d.stoppedBy).length;
  console.log(
    `[小结] 拖动 ${ticks.length} 个更新轮次：新增地形请求 ${totalTerrain}，新增影像请求 ${totalImagery}，` +
      `平均未加载可见瓦片 ${avgMiss.toFixed(1)}，遍历被打断 ${stopped}/${ticks.length} 次`,
  );

  console.warn = originalWarn;
  console.error = originalError;
  layer.dispose();
  return { ticks, totalTerrain, totalImagery, avgMiss, stopped, settled, after };
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 3000);
  const pitch = Number(process.argv[5] ?? 55);
  const dragPx = Number(process.argv[6] ?? 600);
  const durationMs = Number(process.argv[7] ?? 1200);
  LATENCY_MS = Number(process.env.LAT ?? 60);

  console.log(
    `配置：lng=${lng} lat=${lat} 高度=${altitude}m 俯仰=${pitch}° 拖动=${dragPx}px/${durationMs}ms ` +
      `TERRAIN_H=${process.env.TERRAIN_H ?? 0} 影像延迟=${LATENCY_MS}ms 地形延迟=${TERRAIN_LATENCY_MS}ms`,
  );

  const common = { lng, lat, altitude, pitch, dragPx, durationMs };
  // 向下拖（deltaY>0）：相机沿地面前进（向屏幕近端/相机外侧推进）
  await runDirection({ ...common, label: "A 向下拖", dirPx: +1 });
  terrainRequests = 0;
  imageryRequests = 0;
  // 向上拖（deltaY<0）：相机沿地面后退
  await runDirection({ ...common, label: "B 向上拖", dirPx: -1 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * 诊断：倾斜手势过程中/之后，屏幕"最下方一条"的瓦片状态。
 *
 * 前面的 diag-tilt-bottom 是单帧稳态快照，看不出"没被替换"这种时序问题。
 * 本脚本复刻真实手势：同一个 layer 实例上先俯视稳定，再连续俯仰到低角度，
 * 然后逐帧采样「屏幕最下一条」与「中上部」的：
 *   - 可见集里覆盖该点的最细层级（选择阶段应该给的层级）
 *   - 实际渲染（visible + opacity>0）的最细层级 + 覆盖该点的整条瓦片栈
 *   - 该点渲染瓦片的影像层级 / 目标层级
 * 并在稳定后打印"底部带"覆盖点的完整渲染栈（含 renderOrder / depthWrite /
 * childVisibility），用于判断是几何被粗瓦片盖住，还是影像没升级。
 *
 * 运行：
 *   node scripts/diag-tilt-band.cjs [lng] [lat] [高度] [起始俯仰] [结束俯仰]
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
  // TERRAIN_H>0：把每块瓦片做成海拔 H 的"高原"，用于复现
  // 「近处地形高于 planeZ 时，屏幕最下方一条落在视图 AABB 之外」的问题
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
    // height：TERRAIN_H>0 时四个顶点都顶到 maxHeight
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
let imageryRequestZoomSum = 0;
const imageryZoomHist = new Map();
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
    const z = Number(/[?&]z=(\d+)/.exec(target)[1]);
    imageryZoomHist.set(z, (imageryZoomHist.get(z) ?? 0) + 1);
    imageryRequestZoomSum += z;
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

function geoTileBoundsLocal(x, y, zoom, yOrigin) {
  const numX = Math.pow(2, zoom + 1);
  const numY = Math.pow(2, zoom);
  const west = (x / numX) * 360 - 180;
  const east = ((x + 1) / numX) * 360 - 180;
  const north = yOrigin === "north" ? 90 - (y / numY) * 180 : ((y + 1) / numY) * 180 - 90;
  const south = yOrigin === "north" ? 90 - ((y + 1) / numY) * 180 : (y / numY) * 180 - 90;
  return { west, east, south, north };
}

/** 覆盖该点的「已加载且真正上屏」的整条瓦片栈（按 renderOrder 排序） */
function renderedStack(layer, lng, lat) {
  const yOrigin = layer.tileYOrigin ?? "south";
  const out = [];
  for (const [key, entry] of layer.loadedTiles ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, yOrigin);
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!entry.mesh.visible) continue;
    const mat = entry.mesh.material;
    out.push({
      key,
      zoom,
      opacity: mat?.opacity ?? 0,
      renderOrder: entry.mesh.renderOrder,
      depthWrite: mat?.depthWrite,
      childVisibility: mat?.userData?.childVisibility
        ? {
            sw: mat.userData.childVisibility.x,
            se: mat.userData.childVisibility.y,
            nw: mat.userData.childVisibility.z,
            ne: mat.userData.childVisibility.w,
          }
        : null,
      imageryZoom: entry.imageryZoom,
      imageryReady: entry.imageryReady,
      pendingImageryZoom: entry.pendingImageryZoom,
      imageryFailures: entry.imageryFailures,
      retryInMs: entry.imageryRetryAt > Date.now() ? entry.imageryRetryAt - Date.now() : 0,
      inVisibleKeys: layer.currentVisibleKeys.has(key),
    });
    out.push;
  }
  out.sort((a, b) => a.renderOrder - b.renderOrder);
  return out;
}

function findVisibleCovering(layer, lng, lat) {
  const yOrigin = layer.tileYOrigin ?? "south";
  let best = null;
  for (const key of layer.currentVisibleKeys ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, yOrigin);
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!best || zoom > best.zoom) best = { key, x, y, zoom };
  }
  return best;
}

function sampleAt(camera, gis, ndcX, ndcY, planeZ) {
  const raycaster = new THREE.Raycaster();
  const terrainZ = Number(process.env.TERRAIN_H ?? 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -terrainZ);
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  const [lng, lat] = gis.threeToLngLat(hit);
  return { lng, lat };
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 3000);
  const pitchStart = Number(process.argv[5] ?? 78);
  const pitchEnd = Number(process.argv[6] ?? 30);
  LATENCY_MS = Number(process.env.LAT ?? 60);

  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(80);
  const camera = makeCamera(target, altitude, pitchStart);

  const originalWarn = console.warn;
  console.warn = () => {};
  const originalError = console.error;
  console.error = () => {};

  const runViewUpdate = () => {
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
    return bounds;
  };

  // ── 阶段 1：俯视稳定 ──
  for (let i = 0; i < 300; i++) {
    if (i % 12 === 0) runViewUpdate();
    layer.update();
    await idle(16);
  }

  const describe = (label) => {
    const cameraDistance = camera.position.distanceTo(target);
    const cameraHeight = Math.max(camera.position.z, 1);
    const rows = [];
    for (const ndcY of [-0.98, -0.9, -0.7, -0.3, 0.3, 0.8]) {
      const s = sampleAt(camera, gis, 0, ndcY, 0);
      if (!s) {
        rows.push(`${ndcY.toFixed(2)}: 无地面交点`);
        continue;
      }
      const stack = renderedStack(layer, s.lng, s.lat);
      const opaque = stack.filter((t) => t.opacity > 0.01);
      const finest = opaque.length ? opaque[opaque.length - 1] : null;
      const sel = findVisibleCovering(layer, s.lng, s.lat);
      rows.push(
        `NDC-Y ${String(ndcY.toFixed(2)).padStart(5)} | lat ${s.lat.toFixed(5)} | ` +
          `选择=${sel ? "z" + sel.zoom : "无"} | ` +
          `渲染栈=[${stack.map((t) => `z${t.zoom}${t.opacity < 0.01 ? "(透明)" : ""}`).join(" ")}] | ` +
          `最细上屏=${finest ? `z${finest.zoom}` : "无"} | ` +
          `影像=${finest ? `z${finest.imageryZoom}${finest.imageryReady ? "" : "(未就绪)"}` : "-"}`,
      );
    }
    console.log(
      `\n[${label}] 相机高=${cameraHeight.toFixed(0)}m 距离=${cameraDistance.toFixed(0)}m ` +
        `terrainZoom=${getSuggestZoom(cameraDistance, FOV, VIEWPORT_HEIGHT, lat)} ` +
        `imageryZoom=${getSuggestZoom(cameraHeight, FOV, VIEWPORT_HEIGHT, lat)} | ` +
        `可见=${(layer.currentVisibleKeys ?? new Set()).size} 已加载=${(layer.loadedTiles ?? new Map()).size} ` +
        `terrainReq=${terrainRequests} imageryReq=${imageryRequests}`,
    );
    const vb = layer.currentViewLatBounds ?? [];
    const vl = layer.currentViewLngBounds ?? [];
    console.log(
      `   视图AABB lat=[${vb.map((v) => v.toFixed(5)).join(", ")}] lng=[${vl.map((v) => v.toFixed(5)).join(", ")}]`,
    );
    for (const r of rows) console.log("   " + r);
  };

  describe("阶段1 俯视稳定");

  // ── 阶段 2：连续俯仰手势（每帧 1°，约 1 秒）──
  const steps = Math.abs(pitchStart - pitchEnd);
  const dir = pitchEnd > pitchStart ? 1 : -1;
  for (let i = 1; i <= steps; i++) {
    const p = pitchStart + dir * i;
    const pitch = (p * Math.PI) / 180;
    const distance = altitude / Math.sin(pitch);
    camera.position.set(0, -distance * Math.cos(pitch), altitude);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    runViewUpdate();
    layer.update();
    await idle(16);
  }
  describe(`阶段2 手势刚结束 俯仰 ${pitchEnd}°`);

  // ── 阶段 3：静止观察是否自行恢复 ──
  for (let i = 0; i < 60; i++) {
    runViewUpdate();
    layer.update();
    await idle(16);
  }
  describe("阶段3 静止 1s 后");

  for (let i = 0; i < 180; i++) {
    runViewUpdate();
    layer.update();
    await idle(16);
  }
  describe("阶段4 静止 4s 后");

  // ── 底部带的详细瓦片栈 ──
  console.log("\n=== 底部带（NDC-Y -0.98）逐列渲染栈明细 ===");
  for (const ndcX of [-0.9, -0.45, 0, 0.45, 0.9]) {
    const s = sampleAt(camera, gis, ndcX, -0.98, 0);
    if (!s) continue;
    const stack = renderedStack(layer, s.lng, s.lat);
    const sel = findVisibleCovering(layer, s.lng, s.lat);
    console.log(
      `\n  NDC-X ${ndcX.toFixed(2)} | lat ${s.lat.toFixed(5)} lng ${s.lng.toFixed(5)} | 选择集最细=${sel ? sel.key : "无"}`,
    );
    for (const t of stack) {
      console.log(
        `    [上屏] ${t.key.padEnd(18)} opacity=${t.opacity.toFixed(2)} renderOrder=${t.renderOrder} ` +
          `depthWrite=${t.depthWrite ? 1 : 0} childVis=${t.childVisibility ? `[${t.childVisibility.sw}${t.childVisibility.se}${t.childVisibility.nw}${t.childVisibility.ne}]` : "-"} ` +
          `影像=z${t.imageryZoom}${t.imageryReady ? "" : "(未就绪)"} pending=${t.pendingImageryZoom ?? "-"} 失败=${t.imageryFailures} ${t.retryInMs ? `退避${Math.round(t.retryInMs)}ms` : ""} ` +
          `可见集=${t.inVisibleKeys ? "是" : "否"}`,
      );
    }
  }

  // ── 影像请求层级分布（看倾斜后是不是整体降级了）──
  console.log("\n=== 影像请求层级分布（z: 次数） ===");
  console.log(
    "  " +
      [...imageryZoomHist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([z, n]) => `z${z}:${n}`)
        .join("  "),
  );

  console.warn = originalWarn;
  console.error = originalError;
  layer.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

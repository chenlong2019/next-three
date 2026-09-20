/**
 * 诊断：倾斜视角下，屏幕最下方那一条为什么停在底层级瓦片？
 *
 * 做法：稳态（零延迟）跑一段，让所有该加载的都加载完，然后
 *   ① 打印 quadtree 遍历统计 traversalDebug（visited / accepted / stoppedBy）
 *   ② 把屏幕底带（NDC-Y -1.0 → -0.6）横向采样，逐点问：
 *        该点的「可见集覆盖瓦片」层级、「实际渲染瓦片」层级、该点是否在视图 bounds 内
 *   ③ 比较"底部带"与"中上部带"的瓦片层级差，定位是选择阶段丢了还是加载阶段丢了
 *
 * 运行：
 *   node scripts/diag-tilt-bottom.cjs [lng] [lat] [高度] [俯仰] [方位角]
 *   node scripts/diag-tilt-bottom.cjs 118.1371 24.49 1200 55 0
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
const requestedTerrain = new Set();

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
    requestedTerrain.add(target);
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
      maxQueueSize: 200,
      maxRequestsPerFrame: 32,
      maxTileRendersPerFrame: 16,
      tileYOrigin: "south",
      terrainZoomOffset: 0,
      imageryZoomOffset: 0,
      imageryMaxCanvasSize: 1024,
      terrainTilePixelSize: 512,
      maximumScreenSpaceError: 4,
      maxTilesPerView: 128,
      maxCacheSize: 512,
      exaggeration: 1,
      imageryUrlTemplate: "https://mt{s}.example.com/vt/x={x}&y={y}&z={z}",
      imagerySubdomains: ["0", "1", "2", "3"],
      imageryRequestGroup: "google",
      imageryMaximumRequestsPerServer: 12,
      maximumRequestsPerServer: 10,
      prefetchTileBudget: 0,
      revealSpreadMs: 0,
    },
  );
}

function makeCamera(target, altitude, pitchDeg, azimuthDeg) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  const pitch = (pitchDeg * Math.PI) / 180;
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const distance = altitude / Math.sin(pitch);
  camera.position.set(
    target.x + distance * Math.cos(pitch) * Math.sin(azimuth),
    target.y - distance * Math.cos(pitch) * Math.cos(azimuth),
    altitude,
  );
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

function findCovering(iterable, lng, lat, yOrigin, onlyVisibleRendered) {
  let best = null;
  for (const item of iterable) {
    const key = Array.isArray(item) ? item[0] : item;
    const entry = Array.isArray(item) ? item[1] : null;
    if (onlyVisibleRendered) {
      if (!entry.mesh.visible) continue;
      if (!((entry.mesh.material?.opacity ?? 0) > 0.01)) continue;
    }
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, yOrigin);
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!best || zoom > best.zoom) best = { key, x, y, zoom };
  }
  return best;
}

/** 屏幕采样：把 NDC 网格打到地面上 */
function buildSamples(camera, gis, ndcY, cols) {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const out = [];
  for (let c = 0; c < cols; c++) {
    const ndcX = -0.9 + (1.8 * c) / (cols - 1);
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) continue;
    const [lng, lat] = gis.threeToLngLat(hit);
    out.push({ ndcX, lng, lat });
  }
  return out;
}

function describeRow(layer, gis, camera, ndcY, cols) {
  const yOrigin = layer.tileYOrigin ?? "south";
  const samples = buildSamples(camera, gis, ndcY, cols);
  const [latMin, latMax] = layer.currentViewLatBounds ?? [0, 0];
  const rows = [];
  for (const s of samples) {
    const sel = findCovering(layer.currentVisibleKeys ?? [], s.lng, s.lat, yOrigin, false);
    const ren = findCovering(layer.loadedTiles ?? [], s.lng, s.lat, yOrigin, true);
    rows.push({
      ndcX: s.ndcX,
      lat: s.lat,
      inBounds: s.lat >= latMin && s.lat <= latMax,
      selZoom: sel ? sel.zoom : null,
      renZoom: ren ? ren.zoom : null,
    });
  }
  return rows;
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 1200);
  const pitch = Number(process.argv[5] ?? 55);
  const azimuth = Number(process.argv[6] ?? 0);

  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(80);
  const camera = makeCamera(target, altitude, pitch, azimuth);

  const originalWarn = console.warn;
  console.warn = () => {};

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

  const t0 = Date.now();
  let lastViewUpdate = 0;
  while (Date.now() - t0 < 4000) {
    const now = Date.now() - t0;
    if (now - lastViewUpdate >= 100) {
      runViewUpdate();
      lastViewUpdate = now;
    }
    layer.update();
    await idle(16);
  }
  // 再静止一小段，让加载队列清空
  for (let i = 0; i < 60; i++) {
    layer.update();
    await idle(16);
  }

  console.log(
    `位置 (${lng}, ${lat}) | 高度 ${altitude}m | 俯仰 ${pitch}° | 方位 ${azimuth}° | ` +
      `视口 ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT} | tileYOrigin=${layer.tileYOrigin}`,
  );
  console.log(
    `视图 lat 范围: [${(layer.currentViewLatBounds ?? []).map((v) => v.toFixed(5)).join(", ")}]  ` +
      `lng 范围: [${(layer.currentViewLngBounds ?? []).map((v) => v.toFixed(5)).join(", ")}]`,
  );
  console.log(`quadtree 遍历: ${JSON.stringify(layer.traversalDebug ?? {})}`);
  const stats = layer.getCacheStats?.() ?? {};
  console.log(
    `缓存统计: visible=${(layer.currentVisibleKeys ?? new Set()).size} loaded=${(layer.loadedTiles ?? new Map()).size} ` +
      `lodZoom=${stats.lodZoom ?? "-"} fastZoom=${stats.fastZoom ?? "-"}`,
  );

  // 可见集层级分布
  const zoomHist = new Map();
  for (const key of layer.currentVisibleKeys ?? []) {
    const z = Number(key.split(",")[2]);
    zoomHist.set(z, (zoomHist.get(z) ?? 0) + 1);
  }
  console.log(
    "可见集层级分布: " +
      [...zoomHist.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([z, n]) => `z${z}:${n}`)
        .join(" "),
  );

  const cols = 9;
  console.log("\n=== 逐行采样（NDC-Y 从下[近]到上[远]）：选择层级 / 渲染层级 ===");
  for (const ndcY of [-1.0, -0.9, -0.8, -0.7, -0.5, -0.2, 0.2, 0.6, 0.9]) {
    const rows = describeRow(layer, gis, camera, ndcY, cols);
    const sel = rows.map((r) => (r.selZoom === null ? " --" : String(r.selZoom).padStart(3))).join(" ");
    const ren = rows.map((r) => (r.renZoom === null ? " --" : String(r.renZoom).padStart(3))).join(" ");
    const out = rows.filter((r) => !r.inBounds).length;
    console.log(`NDC-Y ${ndcY.toFixed(2)} | sel:${sel} | ren:${ren} | bounds外:${out}/${rows.length}`);
  }

  // ── 底部带各处到底缺了什么 ──
  console.log("\n=== 底部带（NDC-Y -1.00 ~ -0.75）逐点诊断 ===");
  const yOrigin = layer.tileYOrigin ?? "south";
  const seen = new Set();
  for (const ndcY of [-1.0, -0.93, -0.86, -0.78]) {
    for (const s of buildSamples(camera, gis, ndcY, cols)) {
      const sel = findCovering(layer.currentVisibleKeys ?? [], s.lng, s.lat, yOrigin, false);
      const ren = findCovering(layer.loadedTiles ?? [], s.lng, s.lat, yOrigin, true);
      if (ren && ren.zoom < 8 && !seen.has(`${ren.key}|${ndcY}`)) continue;
      seen.add(`${ren ? ren.key : "none"}|${ndcY}`);
      console.log(
        `  NDC-X ${s.ndcX.toFixed(2)} Y ${ndcY.toFixed(2)} | lat ${s.lat.toFixed(5)} lng ${s.lng.toFixed(5)} ` +
          `| 选择=${sel ? sel.key : "无覆盖"} | 渲染=${ren ? ren.key : "无覆盖"}`,
      );
    }
  }

  // ── 可见集里 y 方向覆盖是否完整 ──
  console.log("\n=== 可见集按 (zoom, y 范围) 汇总：底部方向的 y 是否被覆盖到 ===");
  const latToY = (lat, zoom) => {
    const numY = Math.pow(2, zoom);
    const y = yOrigin === "north" ? ((90 - lat) / 180) * numY : ((lat + 90) / 180) * numY;
    return Math.max(0, Math.min(numY - 1, Math.floor(y)));
  };
  const needed = (z) => {
    const [latMin, latMax] = layer.currentViewLatBounds ?? [0, 0];
    const yA = latToY(latMin, z);
    const yB = latToY(latMax, z);
    return [Math.min(yA, yB), Math.max(yA, yB)];
  };
  const byZoom = new Map();
  for (const key of layer.currentVisibleKeys ?? []) {
    const [x, y, zoom] = key.split(",").map(Number);
    if (!byZoom.has(zoom)) byZoom.set(zoom, { min: Infinity, max: -Infinity, n: 0 });
    const rec = byZoom.get(zoom);
    rec.min = Math.min(rec.min, y);
    rec.max = Math.max(rec.max, y);
    rec.n++;
  }
  for (const [zoom, rec] of [...byZoom.entries()].sort((a, b) => a[0] - b[0])) {
    const [ny0, ny1] = needed(zoom);
    console.log(
      `  z${String(zoom).padStart(2)} 可见 ${String(rec.n).padStart(3)} 块, y∈[${rec.min}, ${rec.max}]  ` +
        `实际需要 y∈[${ny0}, ${ny1}]  ` +
        `缺口: 南${rec.min > ny0 ? " 缺 " + (rec.min - ny0) : "ok"} / 北${rec.max < ny1 ? " 缺 " + (ny1 - rec.max) : "ok"}`,
    );
  }

  console.log(`\n地形请求数=${terrainRequests} 唯一URL=${requestedTerrain.size} 影像请求数=${imageryRequests}`);
  console.warn = originalWarn;
  layer.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

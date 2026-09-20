/**
 * 诊断：倾斜视角下，"近处 vs 远处"谁先清晰？
 *
 * 之前的 diag-near-priority 用零延迟 fetch，所有请求瞬间完成，看不出时序问题。
 * 本脚本给影像/地形请求注入真实网络延迟 + 并发上限，然后按时间轴采样：
 * 把屏幕切成 NDC 网格，逐点射线打地面 → 找覆盖它的可见瓦片 → 判断
 *   ① 影像是否就绪（能上屏）② 影像层级是否达到该瓦片的"目标层级"（真正清晰）。
 * 按屏幕行汇总（底=近，顶=远），输出达标率随时间的演化。
 *
 * 运行：
 *   node scripts/diag-near-first-order.cjs [lng] [lat] [高度] [俯仰] [延迟ms] [时长ms]
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
let LATENCY_MS = 60;
let TERRAIN_LATENCY_MS = 120;
let terrainRequests = 0;
let imageryRequests = 0;
const inFlightByHost = new Map();
const MAX_PER_HOST = 12;
let queuedRequests = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带延迟 + 每 host 并发上限的"假网络" */
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
// DIAG_NOREVEAL=1 → 关闭入场节拍（就绪即上屏），用于 A/B 对照；
// 由 createLayer 通过初始化选项 revealSpreadMs: 0 实现
const { WebMercatorGIS } = require(path.join(ROOT, "lib/sources/gis/WebMercatorGIS.ts"));
const {
  getSuggestZoom,
  getViewGroundCorners,
  cornersToLngLatBounds,
} = require(path.join(ROOT, "lib/sources/engine/utils/camera-utils.ts"));

/** 统计 upgradeTileImagery 的调用与返回值：看清"卡住不升级"的原因 */
const upgradeLog = [];
{
  const proto = CesiumTerrainLayer.prototype;
  const originalUpgrade = proto.upgradeTileImagery;
  proto.upgradeTileImagery = function (entry, imageryZoom, coverage) {
    const ret = originalUpgrade.call(this, entry, imageryZoom, coverage);
    if (upgradeLog.length < 4000) {
      upgradeLog.push({
        key: entry.key,
        target: imageryZoom,
        current: entry.imageryZoom,
        cap: entry.imageryZoomCap,
        pending: entry.pendingImageryZoom,
        retryIn: entry.imageryRetryAt > Date.now() ? entry.imageryRetryAt - Date.now() : 0,
        ret,
      });
    }
    return ret;
  };
}

const VIEWPORT_WIDTH = 1000;const VIEWPORT_HEIGHT = 900;
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
      prefetchTileBudget: 0,
      // DIAG_NOREVEAL=1 → 关闭入场节拍（就绪即上屏），用于 A/B 对照：
      // 直接使用初始化选项，不再 monkey-patch 内部方法
      ...(process.env.DIAG_NOREVEAL === "1" ? { revealSpreadMs: 0 } : {}),
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

/** 屏幕上"实际被渲染"的那块瓦片 = loadedTiles 里覆盖该点的最细瓦片 */
function findRenderedTile(layer, lng, lat) {
  let best = null;
  for (const [key, entry] of layer.loadedTiles ?? []) {
    if (!entry.mesh.visible) continue;
    // 只算"真正能看见的"：opacity=0 的瓦片（影像未就绪 / 淡入起点）在屏幕上
    // 完全透明，把它算作覆盖会让"清晰率"虚高——入场节拍把就绪→可见的间隔
    // 显式化之后，这个口径差异足以让 A/B 对比失真。
    if (!((entry.mesh.material?.opacity ?? 0) > 0.01)) continue;
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
    if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
    if (!best || zoom > best.zoom) best = { key, x, y, zoom, entry };
  }
  return best;
}

/** 屏幕采样点（固定，不随时间变） */
function buildScreenSamples(camera, gis) {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const rows = 6;
  const cols = 7;
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const ndcY = -0.9 + (1.8 * r) / (rows - 1);
    const row = [];
    for (let c = 0; c < cols; c++) {
      const ndcX = -0.9 + (1.8 * c) / (cols - 1);
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(plane, hit)) continue;
      const [lng, lat] = gis.threeToLngLat(hit);
      row.push({ ndcX, ndcY, lng, lat });
    }
    grid.push({ ndcY, points: row });
  }
  return grid;
}

/** 单行达标情况：就绪率 + 达标率（影像层级 >= 目标层级） */
function sampleRow(layer, gis, row) {
  let total = 0;
  let ready = 0;
  let sharp = 0;
  let zoomSum = 0;
  let blanket = 0;
  for (const point of row.points) {
    const tile = findRenderedTile(layer, point.lng, point.lat);
    total++;
    if (!tile) continue;
    zoomSum += tile.zoom;
    // 底图毯（比 LOD 粗 4 级以上的纯兜底瓦片）不计入"清晰"统计：
    // 它整片被更细的瓦片遮住，讨论它的影像层级没有意义
    const lodZoom = layer.getCacheStats?.().lodZoom ?? 0;
    if (tile.zoom < lodZoom - 3) {
      blanket++;
      continue;
    }
    const entry = tile.entry;
    if (entry.imageryReady) ready++;
    const ideal = layer.getTileImageryZoom(tile.x, tile.y, tile.zoom);
    if (entry.imageryReady && entry.imageryZoom >= ideal) sharp++;
  }
  return { total, ready, sharp, avgZoom: total ? zoomSum / total : 0, blanket };
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 1200);
  const pitch = Number(process.argv[5] ?? 40);
  LATENCY_MS = Number(process.argv[6] ?? 60);
  const duration = Number(process.argv[7] ?? 6000);
  const sampleMs = 400;

  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(80);
  const camera = makeCamera(target, altitude, pitch);
  const grid = buildScreenSamples(camera, gis);

  const originalWarn = console.warn;
  console.warn = () => {};

  console.log(
    `位置 (${lng}, ${lat}) | 高度 ${altitude}m | 俯仰 ${pitch}° | 影像延迟 ${LATENCY_MS}ms / 地形 ${TERRAIN_LATENCY_MS}ms | 每 host 并发 ${MAX_PER_HOST}`,
  );
  console.log(
    `屏幕行（NDC-Y 从下[近]到上[远]）: ${grid.map((g) => g.ndcY.toFixed(2)).join(" | ")}`,
  );

  const t0 = Date.now();
  let lastViewUpdate = 0;
  let lastSample = 0;
  const timeline = [];

  while (Date.now() - t0 < duration) {
    const now = Date.now() - t0;
    // 模拟应用：每帧 update()，每 200ms 一次 view update
    if (now - lastViewUpdate >= 200) {
      runViewUpdate(layer, camera, target, gis, lat);
      lastViewUpdate = now;
    }
    layer.update();

    if (now - lastSample >= sampleMs) {
      lastSample = now;
      const rows = grid.map((row) => ({
        ndcY: row.ndcY,
        ...sampleRow(layer, gis, row),
      }));
      timeline.push({ t: now, rows });
    }
    await idle(16);
  }

  console.log("\n=== 时间轴：每行「清晰率」= 影像层级达到目标层级的采样点占比（另列平均瓦片层级） ===");
  const header = timeline[0].rows.map((r) => `NDC${r.ndcY.toFixed(2)}`.padStart(11)).join(" |");
  console.log(`  时间ms |${header} |  | 影像req | 地形req | 排队`);
  console.log("-".repeat(130));
  for (const snap of timeline) {
    const cells = snap.rows
      .map((r) =>
        r.blanket === r.total
          ? "   毯(不计)".padStart(11)
          : `${Math.round((100 * r.sharp) / Math.max(1, r.total))}% z${r.avgZoom.toFixed(1)}`.padStart(
              11,
            ),
      )
      .join(" |");
    console.log(
      `${String(snap.t).padStart(8)} |${cells} |  | ${String(imageryRequests).padStart(
        7,
      )} | ${String(terrainRequests).padStart(7)} | ${String(queuedRequests).padStart(4)}`,
    );
  }

  // ── 未达标采样点的覆盖瓦片状态 ──
  console.log("\n=== 屏幕上「实际渲染」的瓦片里，未达标的那些 ===");
  const seen = new Set();
  for (const row of grid) {
    for (const point of row.points) {
      const tile = findRenderedTile(layer, point.lng, point.lat);
      if (!tile || seen.has(tile.key)) continue;
      const ideal = layer.getTileImageryZoom(tile.x, tile.y, tile.zoom);
      if (tile.entry.imageryReady && tile.entry.imageryZoom >= ideal) continue;
      seen.add(tile.key);
      const entry = tile.entry;
      console.log(
        `  ${tile.key} | NDC-Y ${row.ndcY.toFixed(2)} | 影像 z${entry.imageryZoom}/${ideal}(需) ` +
          `就绪=${entry.imageryReady ? "是" : "否"} pending=${entry.pendingImageryZoom ?? "-"} ` +
          `失败=${entry.imageryFailures} ` +
          `retryIn=${
            entry.imageryRetryAt > Date.now()
              ? Math.round((entry.imageryRetryAt - Date.now()) / 1000) + "s"
              : "-"
          }`,
      );
    }
  }
  if (seen.size === 0) console.log("  （全部达标）");

  // ── 卡住的瓦片：upgradeTileImagery 对它们的调用记录 ──
  if (seen.size > 0) {
    console.log("\n=== 这些卡住瓦片的 upgradeTileImagery 调用记录（最后 20 条） ===");
    const stuck = [...seen];
    const hits = upgradeLog.filter((e) => stuck.includes(e.key));
    console.log(
      `  对卡住瓦片的调用次数=${hits.length}，全部调用次数=${upgradeLog.length}；` +
        `返回 true 的=${upgradeLog.filter((e) => e.ret).length}`,
    );
    for (const e of hits.slice(-20)) {
      console.log(
        `  ${e.key} | 目标 z${e.target} 当前 z${e.current} cap=${e.cap} pending=${e.pending} ` +
          `retryIn=${Math.round(e.retryIn)}ms → ${e.ret ? "已发起" : "跳过"}`,
      );
    }
    if (hits.length === 0) console.log("  （从未被调用 → 没进 candidates 列表）");
  }

  // ── 针对某个卡住点的"全状态"展开 ──
  const probeRow = grid.find((row) => row.ndcY >= 0.5) ?? grid[grid.length - 1];
  const probe = probeRow.points[3];
  console.log(`\n=== 探针点 NDC-Y ${probeRow.ndcY.toFixed(2)} 处的所有相关瓦片 ===`);
  const covers = (key) => {
    const [x, y, zoom] = key.split(",").map(Number);
    const b = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
    return probe.lng >= b.west && probe.lng <= b.east && probe.lat >= b.south && probe.lat <= b.north;
  };
  const rows = [];
  for (const [key, entry] of layer.loadedTiles ?? []) {
    if (!covers(key)) continue;
    rows.push(
      `  [loaded] ${key.padEnd(18)} visible=${entry.mesh.visible ? "1" : "0"} ` +
        `imagery z${entry.imageryZoom} ready=${entry.imageryReady ? 1 : 0} pending=${entry.pendingImageryZoom ?? "-"} ` +
        `可见集=${layer.currentVisibleKeys.has(key) ? "是" : "否"}`,
    );
  }
  for (const key of layer.currentVisibleKeys ?? []) {
    if (!covers(key)) continue;
    if (layer.loadedTiles?.has(key)) continue;
    rows.push(`  [可见未加载] ${key.padEnd(12)} pending=${(layer.pending ?? []).some((p) => p.key === key) ? 1 : 0} loading=${(layer.loading ?? new Map()).has(key) ? 1 : 0} cached=${(layer.tileCache ?? new Map()).has(key) ? 1 : 0}`);
  }
  for (const [key, entry] of layer.tileCache ?? []) {
    if (!covers(key)) continue;
    rows.push(`  [cached] ${key.padEnd(18)} imagery z${entry.imageryZoom} ready=${entry.imageryReady ? 1 : 0}`);
  }
  console.log(rows.join("\n") || "  （无）");

  const stats = layer.getCacheStats?.() ?? {};
  console.log("\n=== 缓存统计 ===\n" + JSON.stringify(stats));

  console.warn = originalWarn;
  layer.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

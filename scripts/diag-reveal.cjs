/**
 * 诊断：入场节拍（reveal pacing）是否把"同一帧批量就绪"的瓦片摊开。
 *
 * 想定的坏观感：一批瓦片在同一帧前后完成影像拼接，于是同一帧集体开始淡入，
 * 整片地形"啪"地一起浮出来（像放鞭炮）。修复后应当是一块块依次亮起。
 *
 * 指标：
 *   ① 单帧最大新上屏数（爆发峰值）
 *   ② "爆发帧"（一帧 ≥ 4 块）的数量与占比
 *   ③ 集中度 = 前 3 大帧的上屏数之和 / 总上屏数（越高越像放鞭炮）
 *   ④ 上屏时间轴（每 100ms 聚合），直接看节奏是否均匀
 *
 * 对照：DIAG_NOREVEAL=1 把 enqueueReveal 短路成"就绪即上屏"（旧行为）。
 *
 * 运行：
 *   node scripts/diag-reveal.cjs [lng] [lat] [高度] [俯仰] [时长ms]
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

const LATENCY_MS = 60;
const TERRAIN_LATENCY_MS = 120;
const MAX_PER_HOST = 12;
let metadata = { available: null };

let imageryRequests = 0;
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
const { WebMercatorGIS } = require(path.join(ROOT, "lib/sources/gis/WebMercatorGIS.ts"));
const { getSuggestZoom, getViewGroundCorners, cornersToLngLatBounds } = require(path.join(
  ROOT,
  "lib/sources/engine/utils/camera-utils.ts",
));

const proto = CesiumTerrainLayer.prototype;
const origProcessRevealQueue = proto.processRevealQueue;
const origRestoreFromCache = proto.restoreFromCache;

/** 上屏来源计数：区分"节拍放行"与"缓存恢复"两条路径 */
const revealSource = { paced: 0, cached: 0 };

/**
 * 对照用开关：直接走初始化选项 `revealSpreadMs = 0`（关闭节拍、就绪即上屏），
 * 不再 monkey-patch 内部方法 —— 这样对照同时验证了该选项真的生效。
 */
function revealOptions(disabled) {
  return disabled ? { revealSpreadMs: 0 } : {};
}

// 节拍放行的块数：processRevealQueue 执行前后队列长度之差
proto.processRevealQueue = function (now) {
  const before = this.revealQueue.length;
  origProcessRevealQueue.call(this, now);
  revealSource.paced += Math.max(0, before - this.revealQueue.length);
};
// 从缓存恢复的块数（这条路径刻意不进节拍：转回视野应秒回）
proto.restoreFromCache = function (key) {
  const restored = origRestoreFromCache.call(this, key);
  if (restored) revealSource.cached++;
  return restored;
};

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createLayer(gis, extraOptions = {}) {
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
      ...extraOptions,
    },
  );
}

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
  if (!bounds) return;
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
}

/** 已入场（可见且不在候场队列）的瓦片集合 */
function sampleRevealed(layer) {
  const set = new Set();
  for (const [key, entry] of layer.loadedTiles ?? []) {
    if (entry.revealPending) continue;
    if (!entry.mesh.visible) continue;
    set.add(key);
  }
  return set;
}

async function runCase(label, { disabled, windowMs, warmupMs, altitude, pitch, lng, lat }) {
  imageryRequests = 0;
  inFlightByHost.clear();

  const gis = new WebMercatorGIS(lng, lat);
  const layer = createLayer(gis, revealOptions(disabled));
  const target = gis.lngLatToThree(lng, lat, 0);
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  setCameraHeading(camera, target, altitude, pitch, 0);

  // ── 预热：把首屏瓦片全部加载完、候场队列排空，A/B 从同一状态起跑 ──
  const tWarm = Date.now();
  let lastView = 0;
  while (Date.now() - tWarm < warmupMs) {
    const now = Date.now() - tWarm;
    if (now - lastView >= 200) {
      lastView = now;
      runViewUpdate(layer, camera, target, gis, lat);
    }
    layer.update();
    await idle(16);
  }
  const warmQueue = layer.getCacheStats().revealPending;

  // ── 转向 40°：触发一批新瓦片集中就绪（"放鞭炮"最典型的场景） ──
  setCameraHeading(camera, target, altitude, pitch, 40);
  revealSource.paced = 0;
  revealSource.cached = 0;
  const t0 = Date.now();
  let prev = sampleRevealed(layer);
  const frames = [];
  const timeline = [];
  let lastBucket = 0;
  let bucketNew = 0;
  lastView = 0;

  while (Date.now() - t0 < windowMs) {
    const now = Date.now() - t0;
    if (now - lastView >= 200) {
      lastView = now;
      runViewUpdate(layer, camera, target, gis, lat);
    }
    layer.update();

    const revealed = sampleRevealed(layer);
    let newly = 0;
    for (const key of revealed) if (!prev.has(key)) newly++;
    prev = revealed;

    const stats = layer.getCacheStats();
    frames.push({ t: now, newly, queue: stats.revealPending, visible: revealed.size });

    bucketNew += newly;
    if (now - lastBucket >= 50) {
      timeline.push({ t: now, newly: bucketNew });
      bucketNew = 0;
      lastBucket = now;
    }
    await idle(16);
  }

  // ── 统计 ──
  const totalRevealed = frames.reduce((a, f) => a + f.newly, 0);
  const sorted = frames.map((f) => f.newly).sort((a, b) => b - a);
  const peak = sorted[0] ?? 0;
  const multiFrames = frames.filter((f) => f.newly >= 2).length;
  const activeFrames = frames.filter((f) => f.newly > 0).length;
  const top3 = sorted.slice(0, 3).reduce((a, b) => a + b, 0);
  const concentration = totalRevealed > 0 ? top3 / totalRevealed : 0;
  const maxQueue = frames.reduce((a, f) => Math.max(a, f.queue), 0);
  const revealTimes = [];
  {
    let seen = new Set();
    for (const f of frames) {
      if (f.newly > 0) revealTimes.push(f.t);
    }
  }
  const spreadMs = revealTimes.length > 1 ? revealTimes[revealTimes.length - 1] - revealTimes[0] : 0;

  console.log(`\n=== ${label} ===`);
  console.log(`  [预热结束] 候场队列残留 ${warmQueue} 块`);
  console.log(`  转向后上屏 ${totalRevealed} 块，跨度 ${spreadMs}ms，有上屏的帧 ${activeFrames}/${frames.length}`);
  console.log(
    `  单帧峰值 ${peak} 块 | 同帧≥2块 ${multiFrames} 帧 | 前3大帧占比 ${(concentration * 100).toFixed(0)}%`,
  );
  console.log(`  候场队列峰值 ${maxQueue} 块 | 影像请求 ${imageryRequests} 次`);
  console.log(
    `  上屏来源：节拍放行 ${revealSource.paced} 块 | 缓存秒回 ${revealSource.cached} 块 | ` +
      `其他(直放/初载) ${totalRevealed - revealSource.paced - revealSource.cached} 块`,
  );
  console.log("  上屏节奏（每 50ms 一格，`#` = 1 块）：");
  for (const bucket of timeline) {
    console.log(`    ${String(bucket.t).padStart(5)}ms | ${"#".repeat(Math.min(bucket.newly, 60))}`);
  }
  layer.dispose();
  return { peak, multiFrames, concentration, totalRevealed, maxQueue, spreadMs };
}

/**
 * 确定性验证：把 N 块已就绪的瓦片在同一帧塞进"入场"流程，观察它们上屏的
 * 时间分布。这是"放鞭炮"的最小复现（真实网络下这一批会被请求时序打散，
 * 反而不容易看出节拍是否生效）。
 */
async function runBatchCase(label, { disabled, batchSize, watchMs, altitude, pitch, lng, lat }) {
  const gis = new WebMercatorGIS(lng, lat);
  const layer = createLayer(gis, revealOptions(disabled));
  const target = gis.lngLatToThree(lng, lat, 0);
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  setCameraHeading(camera, target, altitude, pitch, 0);

  const tWarm = Date.now();
  let lastView = 0;
  while (Date.now() - tWarm < 2200) {
    const now = Date.now() - tWarm;
    if (now - lastView >= 200) {
      lastView = now;
      runViewUpdate(layer, camera, target, gis, lat);
    }
    layer.update();
    await idle(16);
  }

  const candidates = [...layer.loadedTiles.entries()]
    .filter(([, entry]) => entry.imageryReady)
    .slice(0, batchSize);
  if (candidates.length === 0) {
    console.log(`\n=== ${label} ===\n  （无可用瓦片，跳过）`);
    layer.dispose();
    return null;
  }
  // 复位到"影像刚拼完、尚未上屏"的状态
  for (const [, entry] of candidates) {
    entry.mesh.visible = false;
    entry.revealPending = false;
  }
  layer.revealQueue.length = 0;
  layer.revealLastAt = 0;
  layer.revealCredit = 1;
  layer.revealSlotMs = 0;
  layer.lastRevealAdmitAt = 0;

  // ← 同一帧注入整批（模拟这批瓦片的影像拼接在同一帧全部完成）
  for (const [key, entry] of candidates) layer.enqueueReveal(key, entry);

  const frames = [];
  const t0 = Date.now();
  let prevVisible = 0;
  while (Date.now() - t0 < watchMs) {
    layer.update();
    const visible = candidates.filter(([, entry]) => entry.mesh.visible).length;
    frames.push({
      t: Date.now() - t0,
      newly: visible - prevVisible,
      queue: layer.revealQueue.length,
    });
    prevVisible = visible;
    await idle(16);
  }

  const total = candidates.length;
  const sorted = frames.map((f) => f.newly).sort((a, b) => b - a);
  const peak = sorted[0] ?? 0;
  const activeFrames = frames.filter((f) => f.newly > 0).length;
  const doneFrames = frames.filter((f) => f.newly > 0);
  const spreadMs = doneFrames.length > 1 ? doneFrames[doneFrames.length - 1].t - doneFrames[0].t : 0;

  console.log(`\n=== ${label} ===`);
  console.log(
    `  同帧注入 ${total} 块 | 单帧峰值 ${peak} 块 | 出完耗时 ${spreadMs}ms | 有上屏的帧 ${activeFrames}`,
  );
  console.log("  上屏节奏（每 16ms 一帧，`#` = 1 块）：");
  for (const f of frames.slice(0, 60)) {
    if (f.newly === 0 && f.t > spreadMs + 100) continue;
    console.log(`    ${String(f.t).padStart(5)}ms | ${"#".repeat(Math.min(f.newly, 40))}`);
  }
  layer.dispose();
  return { total, peak, spreadMs, activeFrames };
}

async function main() {
  const args = process.argv.slice(2);
  const lng = Number(args[0] ?? 118.1371);
  const lat = Number(args[1] ?? 24.49);
  const altitude = Number(args[2] ?? 1200);
  const pitch = Number(args[3] ?? 40);
  const warmupMs = Number(args[4] ?? 2200);
  const windowMs = Number(args[5] ?? 2200);

  metadata = await loadTerrainMetadata();
  console.log(`terrain availability 层数: ${metadata.available?.length ?? "未知"}`);
  console.log(
    `位置 (${lng}, ${lat}) | 高度 ${altitude}m | 俯仰 ${pitch}° | 预热 ${warmupMs}ms | 转向后统计 ${windowMs}ms`,
  );

  const originalWarn = console.warn;
  console.warn = () => {};

  const a = await runCase("A：禁用入场节拍（就绪即上屏，旧行为）", {
    disabled: true,
    windowMs,
    warmupMs,
    altitude,
    pitch,
    lng,
    lat,
  });
  const b = await runCase("B：启用入场节拍（依次亮起）", {
    disabled: false,
    windowMs,
    warmupMs,
    altitude,
    pitch,
    lng,
    lat,
  });

  console.warn = originalWarn;
  console.log("\n=== 转向场景对照汇总 ===");
  console.log(`  上屏瓦片数：     ${a.totalRevealed} → ${b.totalRevealed} 块`);
  console.log(`  上屏时间跨度：   ${a.spreadMs} → ${b.spreadMs} ms`);
  console.log(`  单帧峰值：       ${a.peak} → ${b.peak} 块`);
  console.log(`  同帧≥2块帧数：   ${a.multiFrames} → ${b.multiFrames} 帧`);
  console.log(
    `  前3大帧占比：    ${(a.concentration * 100).toFixed(0)}% → ${(b.concentration * 100).toFixed(0)}%`,
  );

  // ── 确定性验证：同帧注入一整批就绪瓦片 ──
  console.warn = () => {};
  const batchSize = 24;
  const ba = await runBatchCase("批处理 A：禁用节拍（同帧整批亮起 = 放鞭炮）", {
    disabled: true,
    batchSize,
    watchMs: 1600,
    altitude,
    pitch,
    lng,
    lat,
  });
  const bb = await runBatchCase("批处理 B：启用节拍（依次亮起）", {
    disabled: false,
    batchSize,
    watchMs: 1600,
    altitude,
    pitch,
    lng,
    lat,
  });
  console.warn = originalWarn;

  if (ba && bb) {
    console.log("\n=== 批处理对照汇总 ===");
    console.log(`  注入 ${ba.total} 块 → 单帧峰值：${ba.peak} → ${bb.peak} 块`);
    console.log(`  出完耗时：       ${ba.spreadMs} → ${bb.spreadMs} ms`);
    console.log(`  有上屏的帧数：   ${ba.activeFrames} → ${bb.activeFrames}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

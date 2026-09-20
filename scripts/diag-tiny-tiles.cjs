/**
 * 小瓦片（屏幕可见足迹远小于 256×256）探针。
 *
 * 目的：量化"拖动过程中有些瓦块比 256*256 小了很多"的资源浪费。
 * 做法：遍历所有已加载且可见的瓦片，用真实网格顶点投影到屏幕，
 * 与视口求交后的可见包围盒尺寸即"上屏可见足迹"。统计：
 *   tiny = 可见足迹最大边 < TINY_PX 的瓦片数与分布
 *   （细分护栏的目标：上屏瓦片可见足迹 ≥ ~256px）
 *
 * 运行前提：dev server (localhost:12345)。
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));

const URL =
  process.env.REPRO_URL ||
  "http://localhost:12345/examples/cesium-terrain/fullscreen/";
const OUT_DIR = path.join(process.cwd(), "artifacts");
const TINY_PX = Number(process.env.TINY_PX || 160);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(page) {
  for (let i = 0; i < 90; i++) {
    const ok = await page.evaluate(
      () =>
        Boolean(
          globalThis.__terrainDebug &&
            globalThis.__terrainDebug.currentCamera &&
            globalThis.__terrainDebug.currentVisibleKeys.size > 0,
        ),
    );
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

/** 页面内测量：每个可见已加载瓦片的屏幕可见足迹 */
function measure(tinyPx) {
  const L = globalThis.__terrainDebug;
  if (!L || !L.currentCamera) return { err: "not ready" };
  const camera = L.currentCamera;
  const V = camera.position.constructor;
  const W = L.currentViewportWidth || 1280;
  const H = L.currentViewportHeight || 860;
  const TINY_PX = tinyPx;

  const toScreenClamped = (v) => {
    const p = v.clone().project(camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.z < -1 || p.z > 1) return null;
    return {
      x: Math.min(Math.max((p.x + 1) / 2, 0), 1) * W,
      y: Math.min(Math.max((1 - p.y) / 2, 0), 1) * H,
    };
  };

  const tiles = [];
  for (const [key, entry] of L.loadedTiles) {
    const mesh = entry.mesh;
    const mat = mesh && mesh.material;
    if (!mesh || !mesh.visible) continue;
    if ((mat?.opacity ?? 0) <= 0.5) continue;
    const pos = mesh.geometry?.attributes?.position;
    if (!pos || pos.count < 3) continue;
    mesh.updateWorldMatrix(true, false);
    const step = Math.max(1, Math.floor(pos.count / 96));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const v = new V();
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const s = toScreenClamped(v);
      if (!s) continue;
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
    }
    if (!Number.isFinite(minX)) continue;
    const w = maxX - minX;
    const h = maxY - minY;
    tiles.push({
      key,
      zoom: +key.slice(key.lastIndexOf(",") + 1),
      w: Math.round(w),
      h: Math.round(h),
      maxDim: Math.round(Math.max(w, h)),
      // 等效边长 = sqrt(可见面积)：细长条（如 360x8）最长边可能远大于 256，
      // 但可用像素面积极小——它照样要占一次地形请求和一张 256/512 画布，
      // 用最长边单看会把它漏掉，故同时统计等效边长。
      eqSide: Math.round(Math.sqrt(Math.max(w, 0) * Math.max(h, 0))),
    });
  }

  tiles.sort((a, b) => a.eqSide - b.eqSide);
  const tiny = tiles.filter((t) => t.maxDim < TINY_PX);
  const thin = tiles.filter((t) => t.eqSide < TINY_PX);
  const zoomHist = {};
  for (const t of thin) zoomHist[`z${t.zoom}`] = (zoomHist[`z${t.zoom}`] ?? 0) + 1;
  const areaShare = tiles.length
    ? +(thin.reduce((s, t) => s + t.w * t.h, 0) / (W * H)).toFixed(4)
    : 0;
  return {
    camH: Math.round(camera.position.length()),
    viewport: `${W}x${H}`,
    drawn: tiles.length,
    visSize: L.currentVisibleKeys.size,
    maxTiles: L.maxTilesPerView,
    traversal: L.traversalDebug ? JSON.stringify(L.traversalDebug) : "",
    tinyCount: tiny.length,
    tinyRatio: tiles.length ? +(tiny.length / tiles.length).toFixed(3) : 0,
    tinyZoomHist: zoomHist,
    thinCount: thin.length,
    thinRatio: tiles.length ? +(thin.length / tiles.length).toFixed(3) : 0,
    areaShare,
    smallest: tiles.slice(0, 8).map((t) => `${t.key} ${t.w}x${t.h} eq=${t.eqSide}`),
    median: tiles.length
      ? tiles[Math.floor(tiles.length / 2)].maxDim
      : 0,
  };
}

async function dump(page, label) {
  const s = await page.evaluate(measure, TINY_PX);
  console.log(`\n===== ${label} =====`);
  if (s.err) {
    console.log("ERR:", s.err);
    return s;
  }
  console.log(
    `相机高度=${s.camH}m 上屏瓦片=${s.drawn} 可见集=${s.visSize}/${s.maxTiles} 遍历=${s.traversal} 小瓦片(<${TINY_PX}px)=${s.tinyCount} 占比=${s.tinyRatio} 中位尺寸=${s.median}px`,
  );
  console.log(
    `  细长条(等效边长<${TINY_PX}px)=${s.thinCount} 占比=${s.thinRatio} 层级分布=${JSON.stringify(s.tinyZoomHist)} 覆盖屏幕=${(s.areaShare * 100).toFixed(2)}%`,
  );
  if (s.smallest.length) {
    console.log("等效边长最小的瓦片:");
    for (const t of s.smallest) console.log(`   ${t}`);
  }
  return s;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  console.log(`URL: ${URL}  小瓦片阈值=${TINY_PX}px`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page))) {
    await browser.close();
    process.exit(2);
  }
  await sleep(8000);
  await dump(page, "0-初始");

  const cx = 640;
  const cy = 430;

  // 拉近到低空
  for (let i = 0; i < 26; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(240);
  }
  await sleep(8000);
  await dump(page, "1-拉近后");
  await page.screenshot({ path: path.join(OUT_DIR, "tiny-1-拉近.png") });

  // 压低视角看向地平线（对齐用户截图的斜视场景）
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  for (let i = 0; i < 7; i++) {
    await page.mouse.move(cx, cy + 90, { steps: 6 });
    await sleep(70);
  }
  await page.mouse.up({ button: "left" });
  await sleep(8000);
  await dump(page, "2-压低视角后");
  await page.screenshot({ path: path.join(OUT_DIR, "tiny-2-压低.png") });

  // 拖动过程中测量（手势进行中）
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx - 60, cy - 40, { steps: 4 });
    await sleep(60);
  }
  const sDrag = await dump(page, "3-拖动中（手势未松开）");
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx - 120, cy - 80, { steps: 4 });
    await sleep(60);
  }
  await page.screenshot({ path: path.join(OUT_DIR, "tiny-3-拖动中.png") });
  await page.mouse.up({ button: "left" });
  await sleep(6000);
  const sSettled = await dump(page, "4-静置后");

  console.log("\n判定口径：");
  console.log(`  细长条占比 < 2% 且拖动中/静置均稳定 → 护栏生效（瓦片可见足迹 ≥ ~256px）`);
  console.log(`  占比高（>5%）或集中在高层级 → 仍有浪费，需继续收紧`);
  console.log(
    `  拖动中 细长条=${sDrag?.thinCount ?? "?"}/${sDrag?.drawn ?? "?"}（覆盖屏幕 ${((sDrag?.areaShare ?? 0) * 100).toFixed(2)}%），静置 细长条=${sSettled?.thinCount ?? "?"}/${sSettled?.drawn ?? "?"}（${((sSettled?.areaShare ?? 0) * 100).toFixed(2)}%）`,
  );

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

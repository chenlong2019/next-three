/**
 * "由近拖远"逐代换级观测：
 * 1) 拉近到低空，记录此时正选瓦片（高等级）
 * 2) patch fetchImagery / fetchTerrain 记录每一次真实请求 (x,y,zoom)
 * 3) 分轮向远端平移（把近处地形拖向远方），逐轮 dump 请求增量（按 zoom 分组）
 * 验证原理：远离后同区域改选低层级瓦片 → 是否逐代发出新请求。
 * 运行：node scripts/diag-pan-recede.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12345";
const URL = process.env.REPRO_URL ?? `http://localhost:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installRecorder() {
  const layer = globalThis.__terrainDebug;
  if (!layer || layer.__reqRecorder) return !!layer;
  if (!layer) return false;
  layer.__reqRecorder = { img: [], ter: [] };
  const origImg = layer.fetchImagery.bind(layer);
  layer.fetchImagery = function (x, y, zoom, reqZoom, signal, canvasSize, priority) {
    layer.__reqRecorder.img.push({ x, y, zoom, reqZoom, t: Date.now() });
    return origImg(x, y, zoom, reqZoom, signal, canvasSize, priority);
  };
  const origTer = layer.fetchTerrain.bind(layer);
  layer.fetchTerrain = function (x, y, zoom, signal, priority, onStart) {
    layer.__reqRecorder.ter.push({ x, y, zoom, t: Date.now() });
    return origTer(x, y, zoom, signal, priority, onStart);
  };
  return true;
}

function sampleState() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const hist = {};
    for (const k of layer.currentVisibleKeys) {
      const z = +k.split(",")[2];
      hist[z] = (hist[z] || 0) + 1;
    }
    const cam = layer.gis.threeToLngLat(layer.currentCamera.position);
    const rec = layer.__reqRecorder || { img: [], ter: [] };
    const tally = (arr, from) => {
      const m = {};
      for (const r of arr.slice(from)) m[r.zoom] = (m[r.zoom] || 0) + 1;
      return m;
    };
    return {
      cam: { lng: +cam[0].toFixed(5), lat: +cam[1].toFixed(5), alt: Math.round(cam[2]) },
      visHist: hist, visTotal: layer.currentVisibleKeys.size,
      imgTotal: rec.img.length, terTotal: rec.ter.length,
      imgDelta: tally(rec.img, sampleState._img ?? 0),
      terDelta: tally(rec.ter, sampleState._ter ?? 0),
      fastZoom: !!layer.fastZoomActive,
    };
  } catch (e) { return { err: String((e && e.message) || e) }; }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => document.querySelectorAll("canvas").length) > 0) break;
    await sleep(1000);
  }
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => !!globalThis.__terrainDebug?.currentCamera)) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) { console.error("图层未就绪"); await browser.close(); process.exit(2); }
  await sleep(12000);
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  const dump = (label, s) => {
    if (s.err) { console.log(`\n== ${label} == ${s.err}`); return; }
    console.log(`\n== ${label} == 相机(${s.cam.lng},${s.cam.lat}) alt=${s.cam.alt}m 可见集=${s.visTotal} ${JSON.stringify(s.visHist)} 快速跳层=${s.fastZoom}`);
    console.log(`   累计: terrain=${s.terTotal} imagery=${s.imgTotal} | 本轮增量: terrain=${JSON.stringify(s.terDelta)} imagery=${JSON.stringify(s.imgDelta)}`);
  };
  const mark = async () => {
    const s = await page.evaluate(() => {
      const rec = globalThis.__terrainDebug.__reqRecorder;
      return { i: rec.img.length, t: rec.ter.length };
    });
    sampleState._img = s.i; sampleState._ter = s.t;
  };
  const probe = async (label) => page.evaluate(sampleState).then((s) => dump(label, s));

  // 1) 压低视角 + 拉近（建立"近处高等级"状态）
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(12000);
  await page.evaluate(installRecorder);
  await mark();
  await probe("拉近后(基线,记录从此开始)");

  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "recede-0.png") });

  // 2) 分 4 轮向远端平移（右键从屏幕下往上拖 = 把近处地形拖向远方）
  for (let round = 1; round <= 4; round++) {
    await page.mouse.move(cx, box.y + box.h * 0.7);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 60; i++) { await page.mouse.move(cx, box.y + box.h * 0.7 - (box.h * 0.55 * i) / 60); await sleep(25); }
    await page.mouse.up({ button: "right" });
    await sleep(2500);
    await mark();
    await probe(`拖远第${round}轮后`);
    await page.screenshot({ path: path.join(process.cwd(), "artifacts", `recede-${round}.png`) });
  }
  await sleep(8000);
  await probe("最终(静置8s)");
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

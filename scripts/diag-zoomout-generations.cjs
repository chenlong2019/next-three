/**
 * 定点拉远换代观测：固定经纬度（不平移），逐级滚轮拉远。
 * 每级记录"覆盖相机脚下同一地理点"的正选瓦片 key 与影像层级，
 * 以及该级的 terrain/imagery 请求增量 —— 直接展示同一区域的
 * "高等级→低等级"换代链与每代的真实网络请求。
 * 运行：node scripts/diag-zoomout-generations.cjs
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

function stateAt() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const camera = layer.currentCamera;
    const [lng, lat] = layer.gis.threeToLngLat(camera.position);
    // 覆盖相机脚下点的正选瓦片（可渲染的最高层级）
    let cover = null;
    for (const [key, entry] of layer.loadedTiles) {
      if (!entry.mesh?.visible) continue;
      const [x, y, zoom] = key.split(",").map(Number);
      const n2 = Math.pow(2, zoom + 1), n = Math.pow(2, zoom);
      const west = (x / n2) * 360 - 180, east = ((x + 1) / n2) * 360 - 180;
      const south = (y / n) * 180 - 90, north = ((y + 1) / n) * 180 - 90;
      if (lng >= west && lng < east && lat >= south && lat < north) {
        if (!cover || zoom > cover.zoom) {
          cover = { key, zoom, img: entry.imageryZoom, ready: !!entry.imageryReady, op: +(entry.mesh.material?.opacity ?? 0).toFixed(2) };
        }
      }
    }
    const rec = layer.__reqRecorder || { img: [], ter: [] };
    return { cover, imgTotal: rec.img.length, terTotal: rec.ter.length };
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

  // 拉近
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(15000);
  await page.evaluate(installRecorder);

  const chain = [];
  const snap = async (label) => {
    const s = await page.evaluate(stateAt);
    if (s.err) { console.log(`${label}: ${s.err}`); return; }
    console.log(`${label} 脚下正选=${s.cover ? s.cover.key + " img=z" + s.cover.img + (s.cover.ready ? "" : "(未就绪)") + " op=" + s.cover.op : "无"} 累计 ter=${s.terTotal} img=${s.imgTotal}`);
    chain.push({ label, ...s });
  };
  await snap("拉近后");

  // 逐级拉远
  for (let step = 1; step <= 6; step++) {
    const before = await page.evaluate(() => {
      const r = globalThis.__terrainDebug.__reqRecorder;
      return { i: r.img.length, t: r.ter.length };
    });
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, 480);
    await sleep(5000);
    const s = await page.evaluate(stateAt);
    if (s.err || !s.cover) { console.log(`第${step}级: 无数据`); continue; }
    const rec = await page.evaluate(() => globalThis.__terrainDebug.__reqRecorder);
    const imgDelta = {};
    for (const r of rec.img.slice(before.i)) imgDelta[r.zoom] = (imgDelta[r.zoom] || 0) + 1;
    const terDelta = {};
    for (const r of rec.ter.slice(before.t)) terDelta[r.zoom] = (terDelta[r.zoom] || 0) + 1;
    console.log(`第${step}级拉远 脚下正选=${s.cover.key} img=z${s.cover.img}${s.cover.ready ? "" : "(未就绪)"} op=${s.cover.op} | 增量 terrain=${JSON.stringify(terDelta)} imagery=${JSON.stringify(imgDelta)}`);
    chain.push({ step, cover: s.cover, terDelta, imgDelta });
    await page.screenshot({ path: path.join(process.cwd(), "artifacts", `zoomout-${step}.png`) });
  }
  console.log("\n换代链（同一地理点）:");
  for (const c of chain) {
    if (c.cover) console.log(`  ${c.label || "第" + c.step + "级"}: ${c.cover.key} img=z${c.cover.img}`);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

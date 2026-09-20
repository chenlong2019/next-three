/** 近距离复现：删 AABB 预剪枝后，可见集是否被视锥柱体放进来的远/粗瓦片占满 */
const path = require("path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`));
  await page.goto("http://localhost:12345/examples/cesium-terrain/fullscreen/", { waitUntil: "domcontentloaded", timeout: 90000 });
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => document.querySelectorAll("canvas").length > 0)) break;
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!globalThis.__terrainDebug?.currentCamera)) break;
    await sleep(1000);
  }
  await sleep(10000);

  async function sample(label) {
    const s = await page.evaluate(() => {
      const layer = globalThis.__terrainDebug;
      if (!layer || !layer.currentCamera) return { err: "not ready" };
      const vis = layer.currentVisibleKeys;
      const zoomHist = {};
      for (const k of vis) { const z = +k.split(",")[2]; zoomHist[z] = (zoomHist[z] || 0) + 1; }
      const td = layer.traversalDebug || {};
      const loadHist = {};
      for (const [, e] of layer.loadedTiles) { const z = +e.key.split(",")[2]; loadHist[z] = (loadHist[z] || 0) + 1; }
      const cs = layer.getCacheStats ? layer.getCacheStats() : {};
      return {
        visSize: vis.size, maxTiles: layer.maxTilesPerView, zoomHist,
        camH: Math.round(layer.currentCamera.position.length()),
        traversal: td,
        loadHist, loadTotal: layer.loadedTiles.size,
        stitch: `${cs.stitchPending ?? "?"}+${cs.stitchInFlight ?? "?"}`,
      };
    });
    console.log(`\n===== ${label} =====`);
    if (s.err) { console.log("ERR:", JSON.stringify(s.err)); return; }
    console.log(`相机高=${s.camH}m 可见集=${s.visSize}/${s.maxTiles} zoom分布=${JSON.stringify(s.zoomHist)}`);
    console.log(`traversal: roots=${s.traversal.roots} visited=${s.traversal.visited}/${s.traversal.maxVisited} accepted=${s.traversal.accepted} stoppedBy=${s.traversal.stoppedBy || "-"}`);
    console.log(`loadedTiles=${s.loadTotal} ${JSON.stringify(s.loadHist)} stitch=${s.stitch}`);
  }

  await sample("初始(18km)");
  // 大幅拉近：14 次 wheel，每步间隔稍长让 LOD 跟上
  const cx = 640, cy = 430;
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(400);
  }
  await sleep(20000);
  await sample("拉近30次后(≈1km)");
  // 再朝相机方向拖动一段
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  for (let i = 0; i < 12; i++) { await page.mouse.move(cx, cy + 45, { steps: 4 }); await sleep(80); }
  await page.mouse.up({ button: "right" });
  await sleep(5000);
  await sample("朝相机拖动后");
  await sleep(15000);
  await sample("静置15s后");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

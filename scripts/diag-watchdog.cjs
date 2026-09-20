/** 看门狗验证：模拟 cameraInteracting 卡死（true 后不动相机），应在 ~800ms 后自动解除且细化恢复 */
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
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!(globalThis.__terrainDebug && globalThis.__terrainDebug.currentCamera))) break;
    await sleep(1000);
  }
  await sleep(10000);

  // 拉近制造细化需求
  const cx = 640, cy = 430;
  for (let i = 0; i < 20; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await sleep(250); }
  await sleep(6000);

  // 模拟卡死：置 true 且此后不再动相机、不触发 end
  await page.evaluate(() => globalThis.__terrainDebug.setCameraInteracting(true));
  for (const wait of [300, 600, 1000, 1600]) {
    await sleep(wait);
    let st = null;
    for (let i = 0; i < 30; i++) {
      st = await page.evaluate(() => {
        const L = globalThis.__terrainDebug;
        if (!L || !L.currentCamera) return null;
        const cs = L.getCacheStats ? L.getCacheStats() : {};
        return {
          interacting: !!L.cameraInteracting,
          camH: Math.round(L.currentCamera.position.length()),
          visSize: L.currentVisibleKeys.size,
          stitch: `${cs.stitchPending ?? "?"}+${cs.stitchInFlight ?? "?"}`,
        };
      });
      if (st) break;
      await sleep(1000);
    }
    if (!st) { console.log(`+${wait}ms 场景未就绪（可能 HMR 重建）`); continue; }
    console.log(`+${wait}ms interacting=${st.interacting} camH=${st.camH} 可见集=${st.visSize} stitch=${st.stitch}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

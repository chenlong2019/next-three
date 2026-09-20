/** 抓取缩放过程中的页面报错与层状态 */
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
  page.on("pageerror", (e) => console.log("[pageerror]", String(e.stack || e).slice(0, 1200)));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`[console.${m.type()}]`, m.text().slice(0, 600));
  });
  await page.goto("http://localhost:12345/examples/cesium-terrain/fullscreen/", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  const state = () =>
    page.evaluate(() => {
      const L = globalThis.__terrainDebug;
      if (!L) return "no __terrainDebug";
      return {
        disposed: Boolean(L.disposed),
        hasCamera: Boolean(L.currentCamera),
        vis: L.currentVisibleKeys ? L.currentVisibleKeys.size : -1,
        loaded: L.loadedTiles ? L.loadedTiles.size : -1,
        pending: L.pending ? L.pending.length : -1,
        loading: L.loading ? L.loading.size : -1,
        traversal: L.traversalDebug ? JSON.stringify(L.traversalDebug) : "",
      };
    });
  const cx = 640;
  const cy = 430;
  for (let i = 0; i < 40; i++) {
    if (typeof (await state()) !== "string") break;
    await sleep(1000);
  }
  console.log("[初始]", JSON.stringify(await state()));
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(240);
    if (i % 5 === 0) console.log(`[轮次${i}]`, JSON.stringify(await state()));
  }
  await sleep(6000);
  console.log("[缩放后]", JSON.stringify(await state()));
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "guard-crash.png") });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

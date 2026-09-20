/** 打印当前可见瓦片的细分判据数值（含 containsCamera 校准） */
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
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 800)));
  await page.goto("http://localhost:12345/examples/cesium-terrain/fullscreen/", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  for (let i = 0; i < 90; i++) {
    const ok = await page.evaluate(
      () =>
        Boolean(
          globalThis.__terrainDebug &&
            globalThis.__terrainDebug.currentCamera &&
            globalThis.__terrainDebug.currentVisibleKeys.size > 0,
        ),
    );
    if (ok) break;
    await sleep(1000);
  }
  await sleep(3000);

  const dumpVis = async (label) => {
    const r = await page.evaluate(() => {
      const L = globalThis.__terrainDebug;
      const cam = L && L.currentCamera;
      if (!cam) return ["camera null"];
      const out = [];
      const V = cam.position.constructor;
      const camLngLat = null;
      out.push(`camWorld=(${cam.position.x.toFixed(0)}, ${cam.position.y.toFixed(0)}, ${cam.position.z.toFixed(0)}) minZoom=${L.minZoom} maxZoom=${L.maxZoom}`);
      for (const key of L.currentVisibleKeys) {
        const [x, y, z] = key.split(",").map(Number);
        const p = L.getTerrainTileProjection(x, y, z, cam);
        // 手工复算足迹包围盒（含四角世界坐标）用于判定
        const b = L.constructor ? null : null;
        out.push(
          `${key}: px=${Math.round(p.pixelSize)} vis=${Math.round(p.visiblePixelSize)} sse=${p.screenSpaceError.toFixed(1)} dist=${Math.round(p.distance)} inCam=${p.containsCamera} avail=${L.isTileAvailable(x, y, z)}`,
        );
        void V; void b; void camLngLat;
      }
      return out;
    });
    console.log(`\n--- ${label} ---`);
    for (const l of r) console.log(l);
  };

  await dumpVis("初始");
  const cx = 640;
  const cy = 430;
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(240);
    if (i % 5 === 0) {
      await sleep(1500);
      await dumpVis(`缩放第${i}步`);
    }
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

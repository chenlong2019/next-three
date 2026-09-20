/**
 * 细分判据归因探针：对当前视野中心瓦片逐层下钻，打印
 * pixelSize / visiblePixelSize / sse / containsCamera / guard 结果，
 * 定位"应该细分却没细分"的条件。
 */
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
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
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
  await sleep(6000);

  const cx = 640;
  const cy = 430;
  for (let i = 0; i < 26; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(240);
  }
  await sleep(8000);

  const report = await page.evaluate(() => {
    const L = globalThis.__terrainDebug;
    const cam = L && L.currentCamera;
    if (!cam) return ["currentCamera 为空（层可能刚被重建）"];
    const lines = [];
    let finest = null;
    for (const key of L.currentVisibleKeys) {
      const z = +key.slice(key.lastIndexOf(",") + 1);
      if (!finest || z > finest.z) finest = { key, z, parts: key.split(",").map(Number) };
    }
    lines.push(`最细正选: ${finest.key}  可见集=${L.currentVisibleKeys.size}`);
    lines.push(`maxZoom=${L.maxZoom} availability=${Boolean(L.terrainAvailability)} subdivisionMax=${L.terrainSubdivisionMaxZoom} maxTiles=${L.maxTilesPerView} traversal=${JSON.stringify(L.traversalDebug)}`);

    const [fx, fy] = finest.parts;
    for (let z = 3; z <= Math.min(finest.z + 2, 21); z++) {
      const scale = Math.pow(2, z - finest.z);
      const x = Math.floor(fx * scale);
      const y = Math.floor(fy * scale);
      let p;
      try {
        p = L.getTerrainTileProjection(x, y, z, cam);
      } catch (e) {
        lines.push(`z${z} ${x},${y}: projection ERR ${e.message}`);
        continue;
      }
      const available = L.isTileAvailable(x, y, z);
      const guard = p.containsCamera || p.visiblePixelSize > 512;
      const want = p.screenSpaceError > 2 || p.pixelSize > 512;
      lines.push(
        `z${z} ${x},${y}: px=${Math.round(p.pixelSize)} vis=${Math.round(p.visiblePixelSize)} sse=${p.screenSpaceError.toFixed(1)} inCam=${p.containsCamera} avail=${available} guard=${guard ? "pass" : "BLOCK"} wantSub=${want}`,
      );
    }
    return lines;
  });
  for (const l of report) console.log(l);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

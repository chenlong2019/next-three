/** 完整用户行为复现：拉近→压低→多轮朝相机拖动，截图+逐瓦片明细 */
const path = require("path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "artifacts";
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
  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => !!(globalThis.__terrainDebug && globalThis.__terrainDebug.currentCamera))) return true;
      await sleep(1000);
    }
    return false;
  }
  await waitReady();
  await sleep(8000);

  async function snapshot(label) {
    if (!(await waitReady())) { console.log(`[${label}] NOT READY`); return; }
    const s = await page.evaluate(() => {
      const layer = globalThis.__terrainDebug;
      const camera = layer.currentCamera;
      const visZoom = {};
      for (const k of layer.currentVisibleKeys) { const z = +k.split(",")[2]; visZoom[z] = (visZoom[z] || 0) + 1; }
      const cs = layer.getCacheStats ? layer.getCacheStats() : {};
      // 渲染中瓦片按 zoom 分组统计 + 是否存在 depthW=1 的粗瓦片压着细瓦片
      const byZoom = {};
      let coarseDW1 = 0, fineReady = 0, coarseMaxZ = -1, fineMinZ = 99;
      for (const [key, entry] of layer.loadedTiles) {
        if (!entry.mesh?.visible) continue;
        const z = +key.split(",")[2];
        const mat = entry.mesh.material;
        byZoom[z] = byZoom[z] || { total: 0, op1: 0, dw1: 0, ready: 0 };
        byZoom[z].total++;
        if ((mat?.opacity ?? 0) > 0.99) byZoom[z].op1++;
        if (mat?.depthWrite) { byZoom[z].dw1++; if (z > coarseMaxZ) coarseMaxZ = z; }
        if (entry.imageryReady && (mat?.opacity ?? 0) > 0.99) { byZoom[z].ready++; if (z < fineMinZ) fineMinZ = z; }
      }
      for (const z of Object.keys(byZoom)) if (byZoom[z].dw1 && +z < fineMinZ) coarseDW1++;
      return {
        camH: Math.round(camera.position.length()),
        visSize: layer.currentVisibleKeys.size, visZoom,
        stitch: `${cs.stitchPending ?? "?"}+${cs.stitchInFlight ?? "?"}`,
        byZoom, coarseDW1,
      };
    });
    await page.screenshot({ path: `${OUT}/cf-${label}.png` });
    if (!s) return;
    console.log(`\n===== ${label} ===== camH=${s.camH}m 可见集=${s.visSize} ${JSON.stringify(s.visZoom)} stitch=${s.stitch} 危险粗瓦片(深度写且比最细就绪更粗)=${s.coarseDW1}`);
    for (const [z, v] of Object.entries(s.byZoom))
      console.log(`  z${z}: 总${v.total} op=1:${v.op1} ready:${v.ready} depthW=1:${v.dw1}`);
  }

  const cx = 640, cy = 430;
  for (let i = 0; i < 30; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await sleep(300); }
  await sleep(12000);
  await snapshot("1-拉近");

  // 左键拖拽压低视角（俯视）
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  for (let i = 0; i < 6; i++) { await page.mouse.move(cx, cy - 50, { steps: 4 }); await sleep(60); }
  await page.mouse.up({ button: "left" });
  await sleep(6000);
  await snapshot("2-压低视角");

  // 三轮"朝相机拖动"
  for (let round = 1; round <= 3; round++) {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    for (let i = 0; i < 12; i++) { await page.mouse.move(cx, cy + 45, { steps: 4 }); await sleep(70); }
    await page.mouse.up({ button: "right" });
    await sleep(4000);
    await snapshot(`3-拖近第${round}轮-4s`);
    await sleep(10000);
    await snapshot(`3-拖近第${round}轮-14s`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

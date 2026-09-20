/**
 * 探针：删除 AABB 预剪枝后可见集是否被粗/远瓦片淹没。
 * 采样：可见集 zoom 直方图、遍历停止原因（复刻）、屏幕中心/底部瓦片层级。
 */
const path = require("path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = process.env.REPRO_URL || "http://localhost:12345/examples/cesium-terrain/fullscreen/";

(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => document.querySelectorAll("canvas").length > 0)) break;
    await sleep(1000);
  }
  // 等 metadata 就绪（currentCamera 赋值）
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!globalThis.__terrainDebug?.currentCamera)) break;
    await sleep(1000);
  }
  await sleep(15000); // 初始加载稳定

  /** 页面内采样：可见集构成 + 遍历复刻（无 AABB 剪枝，与引擎新逻辑一致） */
  async function sample(label) {
    const s = await page.evaluate(() => {
      const layer = globalThis.__terrainDebug;
      if (!layer || !layer.currentCamera)
        return { err: "not ready", dbg: !!layer, cam: !!(layer && layer.currentCamera), canvas: document.querySelectorAll("canvas").length, body: document.body.innerText.slice(0, 120) };
      const camera = layer.currentCamera;
      const vis = layer.currentVisibleKeys;
      const zoomHist = {};
      let maxZ = -1, minZ = 99;
      for (const k of vis) {
        const z = +k.split(",")[2];
        zoomHist[z] = (zoomHist[z] || 0) + 1;
        if (z > maxZ) maxZ = z;
        if (z < minZ) minZ = z;
      }
      // 复刻遍历太脆弱（gis 逆变换签名不一致），直接读引擎已算好的可见集构成
      let visited = 0, admitted = 0, leaves = 0, stoppedBy = "-";
      // loadedTiles 构成
      const loadHist = {};
      for (const [, e] of layer.loadedTiles) {
        const z = +e.key.split(",")[2] ?? 0;
        loadHist[z] = (loadHist[z] || 0) + 1;
      }
      const cs = layer.getCacheStats ? layer.getCacheStats() : {};
      // 可见集中已就绪（有 mesh 且影像就绪）的数量
      let ready = 0, inLoad = 0;
      for (const k of vis) {
        const e = layer.loadedTiles.get(k);
        if (!e) inLoad++;
        else if (e.mesh && (e.imageryReady || (e.mesh.material && e.mesh.material.opacity >= 0.99))) ready++;
      }
      return {
        visSize: vis.size, zoomHist, minZ, maxZ,
        maxTiles: layer.maxTilesPerView,
        camH: Math.round(camera.position.length()),
        ready, inLoad,
        loadHist, loadTotal: layer.loadedTiles.size,
        stitchPending: cs.stitchPending, stitchInFlight: cs.stitchInFlight,
        pending: cs.pending ?? cs.terrainPending,
      };
    });
    console.log(`\n===== ${label} =====`);
    if (s.err) { console.log("ERR:", JSON.stringify(s.err)); return; }
    console.log(`可见集=${s.visSize}/${s.maxTiles} zoom分布=${JSON.stringify(s.zoomHist)} (z${s.minZ}~z${s.maxZ}) 就绪=${s.ready} 未加载=${s.inLoad}`);
    console.log(`相机高度≈${s.camH} loadedTiles=${s.loadTotal} 分布=${JSON.stringify(s.loadHist)}`);
    console.log(`stitch: pending=${s.stitchPending} inFlight=${s.stitchInFlight} | 地形队列=${s.pending}`);
  }

  await sample("初始加载后");

  // 模拟用户场景：拉近若干次
  const cx = 640, cy = 430;
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(350);
  }
  await sleep(15000);
  await sample("拉近 6 次后");

  // 朝相机方向拖动（右键向下）
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  for (let i = 0; i < 10; i++) { await page.mouse.move(cx, cy + 40, { steps: 4 }); await sleep(80); }
  await page.mouse.up({ button: "right" });
  await sleep(4000);
  await sample("朝相机拖动后");
  await sleep(12000);
  await sample("松手静置 12s");

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

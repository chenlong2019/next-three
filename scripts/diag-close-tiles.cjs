/** 近距离复现 v2：z18 已请求但显示仍是模糊瓦片 —— 逐瓦片明细定位谁在渲染 */
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

  /** 就绪等待（HMR 全量刷新会清全局，采样前重查） */
  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => !!(globalThis.__terrainDebug && globalThis.__terrainDebug.currentCamera))) return true;
      await sleep(1000);
    }
    return false;
  }
  await waitReady();
  await sleep(10000);

  /** 屏幕区域内渲染瓦片明细（mesh 世界包围盒投影） */
  async function dumpTiles(label, yTopFrac, yBotFrac) {
    const s = await page.evaluate(({ yTopFrac, yBotFrac }) => {
      const layer = globalThis.__terrainDebug;
      if (!layer || !layer.currentCamera) return { err: "not ready" };
      const camera = layer.currentCamera;
      const H = layer.currentViewportHeight, W = layer.currentViewportWidth;
      const rows = [];
      for (const [key, entry] of layer.loadedTiles) {
        if (!entry.mesh?.visible) continue;
        entry.mesh.updateWorldMatrix(true, false);
        if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
        const box = entry.mesh.geometry.boundingBox.clone().applyMatrix4(entry.mesh.matrixWorld);
        const corners = [];
        for (let i = 0; i < 8; i++)
          corners.push(new (box.min.constructor)(
            (i & 1 ? box.max.x : box.min.x),
            (i & 2 ? box.max.y : box.min.y),
            (i & 4 ? box.max.z : box.min.z)));
        let minY = 1e9, maxY = -1e9, zOK = 0;
        for (const p of corners) {
          const d = p.clone().project(camera);
          if (d.z >= -1 && d.z <= 1) zOK++;
          const sy = ((1 - d.y) / 2) * H;
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
        if (!Number.isFinite(minY)) continue;
        if (maxY < H * yTopFrac || minY > H * yBotFrac) continue; // 不在目标带
        const mat = entry.mesh.material;
        const z = +key.split(",")[2];
        rows.push({
          key, zoom: z,
          op: +(mat?.opacity ?? 0).toFixed(2),
          depthWrite: mat?.depthWrite ? 1 : 0,
          renderOrder: entry.mesh.renderOrder,
          imgZ: entry.imageryZoom,
          imgReady: !!entry.imageryReady,
          pend: entry.pendingImageryZoom ?? null,
          reveal: !!entry.revealPending,
          inVis: layer.currentVisibleKeys.has(key),
          band: `${minY.toFixed(0)}-${maxY.toFixed(0)}`,
        });
      }
      rows.sort((a, b) => (b.zoom - a.zoom) || a.key.localeCompare(b.key));
      const td = layer.traversalDebug || {};
      const cs = layer.getCacheStats ? layer.getCacheStats() : {};
      const visZoom = {};
      for (const k of layer.currentVisibleKeys) { const z = +k.split(",")[2]; visZoom[z] = (visZoom[z] || 0) + 1; }
      return {
        camH: Math.round(camera.position.length()),
        visSize: layer.currentVisibleKeys.size, visZoom,
        traversal: td, stitch: `${cs.stitchPending ?? "?"}+${cs.stitchInFlight ?? "?"}`,
        H, rows: rows.slice(0, 24),
      };
    }, { yTopFrac, yBotFrac });
    console.log(`\n===== ${label} =====`);
    if (s.err) { console.log("ERR:", JSON.stringify(s.err)); return; }
    console.log(`相机高=${s.camH}m 可见集=${s.visSize} zoom分布=${JSON.stringify(s.visZoom)} stitch=${s.stitch}`);
    console.log(`traversal: visited=${s.traversal.visisted ?? s.traversal.visited}/${s.traversal.maxVisited} accepted=${s.traversal.accepted} stoppedBy=${s.traversal.stoppedBy || "-"}`);
    console.log(`屏幕带 y∈[${(s.H * yTopFrac).toFixed(0)},${(s.H * yBotFrac).toFixed(0)}] 渲染中瓦片:`);
    for (const r of s.rows)
      console.log(`  ${r.key.padEnd(16)} z${r.zoom} op=${r.op} depthW=${r.depthWrite} ro=${r.renderOrder} img=${r.imgZ}${r.imgReady ? "✓" : "✗"} pend=${r.pend} 候场=${r.reveal ? 1 : 0} 可见集=${r.inVis ? 1 : 0} y=${r.band}`);
  }

  const cx = 640, cy = 430;
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(400);
  }
  await sleep(20000);
  if (!(await waitReady())) { console.log("NEVER READY"); await browser.close(); return; }
  await dumpTiles("拉近30次后(≈1km) 中央带", 0.2, 0.8);
  await dumpTiles("拉近30次后 底部带", 0.75, 1.01);

  // 朝相机方向拖动
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  for (let i = 0; i < 12; i++) { await page.mouse.move(cx, cy + 45, { steps: 4 }); await sleep(80); }
  await page.mouse.up({ button: "right" });
  await sleep(4000);
  if (!(await waitReady())) { console.log("NEVER READY2"); await browser.close(); return; }
  await dumpTiles("朝相机拖动后4s 中央带", 0.2, 0.8);
  await sleep(15000);
  if (!(await waitReady())) { console.log("NEVER READY3"); await browser.close(); return; }
  await dumpTiles("静置15s后 中央带", 0.2, 0.8);
  await dumpTiles("静置15s后 底部带", 0.75, 1.01);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

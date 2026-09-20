/**
 * 山顶复现：找视野内最高瓦片 → 拖到屏幕中央 → 降到低空 → 朝相机方向平移
 * （此时地形抬升、相机贴/进山体），采样：
 *  - 相机是否陷入山体
 *  - 底部带瓦片状态 + 其粗祖先的 depthWrite（验证遮挡修复）
 * 运行：node scripts/diag-pan-peak.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12345";
const URL = process.env.REPRO_URL ?? `http://localhost:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function samplePeak() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const camera = layer.currentCamera;
    const H = layer.currentViewportHeight;
    const W = layer.currentViewportWidth;
    const [lng, lat, alt] = layer.gis.threeToLngLat(camera.position);
    let underH = null;
    for (const [key, entry] of layer.loadedTiles) {
      const [x, y, zoom] = key.split(",").map(Number);
      const n = Math.pow(2, zoom);
      const west = (x / (2 * n)) * 360 - 180, east = ((x + 1) / (2 * n)) * 360 - 180;
      const south = (y / n) * 180 - 90, north = ((y + 1) / n) * 180 - 90;
      if (lng >= west && lng < east && lat >= south && lat < north) {
        if (underH === null || entry.surfaceHeight > underH) underH = entry.surfaceHeight;
      }
    }
    // 找视野内最高瓦片的屏幕位置（用于拖拽导向）
    let peak = null;
    for (const [key, entry] of layer.loadedTiles) {
      if (!entry.mesh?.visible) continue;
      entry.mesh.updateWorldMatrix(true, false);
      if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
      const box = entry.mesh.geometry.boundingBox.clone().applyMatrix4(entry.mesh.matrixWorld);
      const v = camera.position.clone();
      let sx = 0, sy = 0, cnt = 0, inF = false;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(camera);
        if (v.z < -1 || v.z > 1) continue;
        inF = true;
        sx += ((v.x + 1) / 2) * W; sy += ((1 - v.y) / 2) * H; cnt++;
      }
      if (!inF) continue;
      if (!peak || entry.surfaceHeight > peak.h) {
        peak = { key, h: entry.surfaceHeight, sx: sx / cnt, sy: sy / cnt, zoom: +key.split(",")[2] };
      }
    }
    // 底部带瓦片 + 其 z-3 祖先的 depthWrite
    const rows = [];
    for (const [key, entry] of layer.loadedTiles) {
      if (!entry.mesh?.visible) continue;
      entry.mesh.updateWorldMatrix(true, false);
      if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
      const box = entry.mesh.geometry.boundingBox.clone().applyMatrix4(entry.mesh.matrixWorld);
      const v = camera.position.clone();
      let minY = 1e9, maxY = -1e9;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const sy2 = ((1 - v.y) / 2) * H;
        minY = Math.min(minY, sy2); maxY = Math.max(maxY, sy2);
      }
      if (!Number.isFinite(minY) || maxY < H * 0.55) continue;
      const [x, y, zoom] = key.split(",").map(Number);
      const ancKey = `${Math.floor(x / 8)},${Math.floor(y / 8)},${zoom - 3}`;
      const anc = layer.loadedTiles.get(ancKey);
      rows.push({
        key, zoom, h: Math.round(entry.surfaceHeight),
        img: entry.imageryZoom, ready: !!entry.imageryReady,
        pend: entry.pendingImageryZoom, op: +(entry.mesh.material?.opacity ?? 0).toFixed(2),
        inVis: layer.currentVisibleKeys.has(key),
        ancDW: anc ? !!anc.mesh.material.depthWrite : null,
        ancVis: anc ? !!(anc.mesh.visible && +(anc.mesh.material?.opacity ?? 0).toFixed(2) > 0) : null,
      });
    }
    rows.sort((a, b) => a.zoom - b.zoom || b.h - a.h);
    const s = layer.getCacheStats();
    return {
      cam: { lng: +lng.toFixed(5), lat: +lat.toFixed(5), alt: Math.round(alt) },
      underH: underH === null ? null : Math.round(underH),
      inMountain: underH !== null && alt < underH,
      peak: peak ? { key: peak.key, h: Math.round(peak.h), sx: Math.round(peak.sx), sy: Math.round(peak.sy), zoom: peak.zoom } : null,
      stitch: `${s.stitchPending}+${s.stitchInFlight}`,
      rows: rows.slice(0, 12),
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
    console.log(
      `\n== ${label} == 相机(${s.cam.lng},${s.cam.lat}) alt=${s.cam.alt}m 脚下高程=${s.underH}m` +
      ` 陷入山体=${s.inMountain ? "是!!!" : "否"} stitch=${s.stitch}` +
      (s.peak ? ` 峰=${s.peak.key}(${s.peak.h}m)@屏幕(${s.peak.sx},${s.peak.sy})` : " 峰=无"),
    );
    for (const r of s.rows) {
      console.log(
        `  ${r.key.padEnd(16)} z${String(r.zoom).padStart(2)} 高程=${String(r.h).padStart(5)}m img=z${r.img}${r.ready ? "" : "(未就绪)"}${r.pend != null ? "->z" + r.pend : ""}` +
          ` op=${r.op} 可见集=${r.inVis ? 1 : 0}` +
          (r.ancDW !== null ? ` 祖(z-3)DW=${r.ancDW ? 1 : 0}${r.ancVis ? "/可见" : ""}` : ""),
      );
    }
  };
  const sample = (label) => page.evaluate(samplePeak).then((s) => dump(label, s));

  await sample("初始");
  // 1) 压低视角
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  // 2) 拉近
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(10000);
  await sample("拉近后");

  // 3) 三次"把最高峰拖向屏幕中心 + 朝相机平移"循环
  for (let round = 1; round <= 3; round++) {
    const s = await page.evaluate(samplePeak);
    if (s.peak && s.peak.h > 400 && (Math.abs(s.peak.sx - cx) > 60 || Math.abs(s.peak.sy - cy) > 60)) {
      // 抓住峰所在位置，拖到中心（右键平移：地形跟随鼠标）
      const steps = 20;
      await page.mouse.move(s.peak.sx, s.peak.sy);
      await page.mouse.down({ button: "right" });
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(s.peak.sx + ((cx - s.peak.sx) * i) / steps, s.peak.sy + ((cy - s.peak.sy) * i) / steps);
        await sleep(30);
      }
      await page.mouse.up({ button: "right" });
      await sleep(2000);
    }
    // 拉近一点，贴近山体
    await page.mouse.move(cx, cy); await page.mouse.wheel(0, -480); await sleep(400);
    await page.mouse.move(cx, cy); await page.mouse.wheel(0, -480); await sleep(400);
    await sleep(6000);
    // 朝相机方向平移 2 次
    for (let k = 0; k < 2; k++) {
      await page.mouse.move(cx, box.y + box.h * 0.35);
      await page.mouse.down({ button: "right" });
      for (let i = 1; i <= 60; i++) { await page.mouse.move(cx, box.y + box.h * 0.35 + (box.h * 0.7 * i) / 60); await sleep(25); }
      await page.mouse.up({ button: "right" });
      await sleep(1500);
    }
    await sleep(4000);
    await sample(`第${round}轮后`);
  }
  await sleep(8000);
  await sample("最终(静置8s)");
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "peak-settled.png") });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * 山坡专项诊断：连续朝相机方向平移，验证
 *  ① 相机是否陷入山体（相机海拔 < 脚下瓦片 surfaceHeight）
 *  ② 近处山坡瓦片是否落选视野包围盒（屏幕上可见但不在 currentVisibleKeys 且影像停滞）
 *  ③ 高层级影像子块 404 永久失败（failedImagery.permanent）
 * 运行：node scripts/diag-pan-mountain.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12345";
const URL = process.env.REPRO_URL ?? `http://localhost:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sampleMountain() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const camera = layer.currentCamera;
    const H = layer.currentViewportHeight;
    const [lng, lat, alt] = layer.gis.threeToLngLat(camera.position);
    // 脚下瓦片的最高高程（surfaceHeight = 瓦片内最大高程，近似山体高度）
    let underH = null, underKey = null;
    for (const [key, entry] of layer.loadedTiles) {
      const [x, y, zoom] = key.split(",").map(Number);
      const n = Math.pow(2, zoom);
      const west = (x / (2 * n)) * 360 - 180, east = ((x + 1) / (2 * n)) * 360 - 180;
      const south = (y / n) * 180 - 90, north = ((y + 1) / n) * 180 - 90;
      if (lng >= west && lng < east && lat >= south && lat < north) {
        if (underH === null || zoom > +underKey.split(",")[2]) {
          underH = entry.surfaceHeight; underKey = key;
        }
      }
    }
    const maxRelief = layer.getMaxObservedSurfaceHeight ? layer.getMaxObservedSurfaceHeight() : null;
    // 底部 40% 屏幕的渲染中瓦片
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
        const sy = ((1 - v.y) / 2) * H;
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (!Number.isFinite(minY)) continue;
      if (maxY < H * 0.6) continue;
      rows.push({
        key, zoom: +key.split(",")[2],
        h: Math.round(entry.surfaceHeight),
        img: entry.imageryZoom, ready: !!entry.imageryReady,
        pend: entry.pendingImageryZoom, op: +(entry.mesh.material?.opacity ?? 0).toFixed(2),
        inVis: layer.currentVisibleKeys.has(key),
      });
    }
    rows.sort((a, b) => b.h - a.h);
    // 永久失败的影像子块
    const fi = layer.failedImagery;
    let perm = 0, temp = 0;
    const permSamples = [];
    if (fi) {
      for (const [k, f] of fi) {
        if (f.permanent) { perm++; if (permSamples.length <= 6) permSamples.push(k); }
        else temp++;
      }
    }
    const s = layer.getCacheStats();
    return {
      cam: { lng: +lng.toFixed(5), lat: +lat.toFixed(5), alt: Math.round(alt) },
      underKey, underH: underH === null ? null : Math.round(underH),
      inMountain: underH !== null && alt < underH,
      maxRelief: maxRelief === null ? null : Math.round(maxRelief),
      failedPerm: perm, failedTemp: temp, permSamples,
      stitch: `${s.stitchPending}+${s.stitchInFlight}`,
      rows: rows.slice(0, 14),
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
  await sleep(8000);
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  const dump = (label, s) => {
    if (s.err) { console.log(`\n== ${label} == ${s.err}`); return; }
    console.log(
      `\n== ${label} == 相机(${s.cam.lng},${s.cam.lat}) alt=${s.cam.alt}m 脚下瓦片=${s.underKey} 高程=${s.underH}m` +
      ` 陷入山体=${s.inMountain ? "是!!!" : "否"} maxRelief=${s.maxRelief}m stitch=${s.stitch}` +
      ` 永久失败子块=${s.failedPerm} 暂时失败=${s.failedTemp}${s.failedPerm ? " [" + s.permSamples.join(" ") + "]" : ""}`,
    );
    for (const r of s.rows) {
      console.log(
        `  ${r.key.padEnd(16)} z${String(r.zoom).padStart(2)} 高程=${String(r.h).padStart(5)}m img=z${r.img}${r.ready ? "" : "(未就绪)"}${r.pend != null ? "->z" + r.pend : ""}` +
          ` op=${r.op} 可见集=${r.inVis ? 1 : 0}`,
      );
    }
  };
  const sample = (label) => page.evaluate(sampleMountain).then((s) => dump(label, s));

  await sample("初始");
  // 压低视角 + 拉近
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(12000);
  await sample("拉近后");

  // 连续 4 轮"朝相机方向"长距离平移，每轮后静置采样
  for (let round = 1; round <= 4; round++) {
    await page.mouse.move(cx, box.y + box.h * 0.55);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 90; i++) {
      await page.mouse.move(cx, box.y + box.h * 0.55 + (box.h * 0.75 * i) / 90);
      await sleep(25);
    }
    await page.mouse.up({ button: "right" });
    await sleep(2500);
    await sample(`第${round}轮平移后`);
  }
  await sleep(6000);
  await sample("最终(静置6s)");
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "mountain-settled.png") });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

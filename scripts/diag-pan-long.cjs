/**
 * 长时程复现：朝相机方向（右键向下）拖动 6s，逐秒采样底部带瓦片状态，
 * 松手后再跟踪 15s —— 观察是否有瓦片影像长期停滞（不升级/卡 pending）。
 *
 * 运行：node scripts/diag-pan-long.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12400";
const URL = process.env.REPRO_URL ?? `http://127.0.0.1:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 底部带瓦片状态 + 队列统计；必须是真实函数传给 page.evaluate */
function sampleBand() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer) return { err: "no layer" };
    const camera = layer.currentCamera;
    if (!camera) return { err: "no camera" };
    const H = layer.currentViewportHeight;
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
      if (maxY < H * 0.75) continue; // 底部 25%
      rows.push({
        key,
        zoom: +key.split(",")[2],
        op: +(entry.mesh.material?.opacity ?? 0).toFixed(2),
        img: entry.imageryZoom,
        ready: !!entry.imageryReady,
        pend: entry.pendingImageryZoom,
        cap: entry.imageryZoomCap,
        fail: entry.imageryFailures,
        retryAt: entry.imageryRetryAt > 0 ? Math.max(0, Math.round((entry.imageryRetryAt - performance.now()) / 1000)) : 0,
        inVis: layer.currentVisibleKeys.has(key),
      });
    }
    rows.sort((a, b) => a.zoom - b.zoom || a.key.localeCompare(b.key));
    const s = layer.getCacheStats();
    return {
      H,
      stitch: `${s.stitchPending}+${s.stitchInFlight}`,
      interacting: layer.cameraInteracting,
      rows: rows.slice(0, 16),
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
  // 等图层元数据就绪（currentCamera 在 metadataReady 后才会被赋值）
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => !!globalThis.__terrainDebug?.currentCamera)) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) {
    const st = await page.evaluate(() => ({
      hasLayer: !!globalThis.__terrainDebug,
      meta: !!globalThis.__terrainDebug?.metadataReady,
      body: document.body.innerText.slice(0, 200),
    }));
    console.error("图层未就绪:", JSON.stringify(st));
    await browser.close();
    process.exit(2);
  }
  await sleep(8000);
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  const dump = (label, s) => {
    if (s.err) { console.log(`\n== ${label} == 采样失败: ${s.err}`); return; }
    console.log(`\n== ${label} == stitch=${s.stitch} interacting=${s.interacting}`);
    for (const r of s.rows) {
      console.log(
        `  ${r.key.padEnd(16)} z${String(r.zoom).padStart(2)} img=z${r.img}${r.ready ? "" : "(未就绪)"}${r.pend != null ? "->z" + r.pend : ""}` +
          ` cap=${r.cap} fail=${r.fail}${r.retryAt ? ` 重试${r.retryAt}s后` : ""}` +
          ` op=${r.op} 可见集=${r.inVis ? 1 : 0}`,
      );
    }
  };
  const sample = (label) => page.evaluate(sampleBand).then((s) => dump(label, s));

  // 准备：压低视角 + 拉近
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(12000);
  await sample("拖动前");

  // 朝相机方向拖动 6s（右键向下）
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  const steps = 180; // 6s
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx, cy + (box.h * 0.5 * i) / steps);
    await sleep(33);
    if (i % 54 === 0) await sample(`拖动中 ${(i * 33 / 1000).toFixed(1)}s`);
  }
  await page.mouse.up({ button: "right" });
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "panlong-justafter.png") });

  // 松手后跟踪 15s：重点看哪些瓦片迟迟不升级
  for (let t = 1; t <= 15; t += 3) {
    await sleep(3000);
    await sample(`松手 ${t}s`);
  }
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "panlong-settled.png") });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

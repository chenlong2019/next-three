/**
 * 拖动时「屏幕底部带」里到底是哪些瓦片在渲染：逐瓦片列出
 * key / zoom / imageryZoom / imageryReady / opacity / 是否在可见集。
 *
 * 运行：node scripts/diag-pan-band.cjs
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12400";
const URL = process.env.REPRO_URL ?? `http://127.0.0.1:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内：找出屏幕底部 18% 区域内渲染中的瓦片。
 *  用 mesh 世界包围盒 8 角投影（gis 重投影坐标系不一致，弃用）。
 *  注意：必须是真实函数传给 page.evaluate；字符串箭头函数会返回 undefined。 */
function sampleBand() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer) return { err: "no layer" };
    const camera = layer.currentCamera;
    if (!camera) return { err: "no camera" };
    const H = layer.currentViewportHeight;
    const v = camera.position.clone();
    const rows = [];
    for (const [key, entry] of layer.loadedTiles) {
      if (!entry.mesh?.visible) continue;
      entry.mesh.updateWorldMatrix(true, false);
      if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
      const box = entry.mesh.geometry.boundingBox.clone().applyMatrix4(entry.mesh.matrixWorld);
      let minY = 1e9, maxY = -1e9, behind = 0;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        v.project(camera);
        if (v.z < -1 || v.z > 1) { behind++; continue; }
        const sy = ((1 - v.y) / 2) * H;
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
      if (!Number.isFinite(minY)) continue;
      if (maxY < H * 0.82) continue; // 不在底部带
      const mat = entry.mesh.material;
      rows.push({
        key, zoom: entry.zoom ?? +key.split(",")[2],
        visible: entry.mesh.visible,
        opacity: +(mat?.opacity ?? 0).toFixed(2),
        imageryZoom: entry.imageryZoom,
        imageryReady: !!entry.imageryReady,
        pendingZoom: entry.pendingImageryZoom,
        inVis: layer.currentVisibleKeys.has(key),
        revealPending: !!entry.revealPending,
        behind,
        band: minY.toFixed(0) + "-" + maxY.toFixed(0),
      });
    }
    rows.sort((a, b) => a.zoom - b.zoom);
    const s = layer.getCacheStats();
    return { H, stitchPending: s.stitchPending, stitchInFlight: s.stitchInFlight, rows: rows.slice(0, 14) };
  } catch (e) { return { err: String((e && e.message) || e) }; }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate(() => document.querySelectorAll("canvas").length);
    if (st > 0) break;
    await sleep(1000);
  }
  await sleep(12000);
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const drag = async ({ button, fromY, toY, ms }) => {
    await page.mouse.move(cx, fromY);
    await page.mouse.down({ button });
    const steps = Math.max(8, Math.round(ms / 33));
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(cx, fromY + ((toY - fromY) * i) / steps);
      await sleep(33);
    }
    await page.mouse.up({ button });
  };

  await drag({ button: "left", fromY: box.y + box.h * 0.65, toY: box.y + box.h * 0.28, ms: 800 });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(12000);

  const dump = async (label) => {
    const s = await page.evaluate(sampleBand);
    if (s.err) { console.log(`\n== ${label} == 采样失败: ${s.err}`); return; }
    console.log(`\n== ${label} == stitch=${s.stitchPending}+${s.stitchInFlight}`);
    for (const r of s.rows ?? []) {
      console.log(
        `  ${r.key.padEnd(16)} z${String(r.zoom).padStart(2)} img=z${r.imageryZoom}${r.imageryReady ? "" : "(未就绪)"}${r.pendingZoom != null ? "->z" + r.pendingZoom : ""}` +
          ` op=${r.opacity} vis=${r.visible ? 1 : 0} 可见集=${r.inVis ? 1 : 0} 候场=${r.revealPending ? 1 : 0} 裁剪角=${r.behind} 屏幕 ${r.band}`,
      );
    }
  };

  await dump("拖动前");
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 44; i++) {
    await page.mouse.move(cx, cy + (box.h * 0.42 * i) / 44);
    await sleep(33);
    if (i === 14 || i === 28 || i === 42) await dump(`拖动中 ${(i * 33) / 1000}s`);
  }
  await page.mouse.up({ button: "right" });
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "band-A-justafter.png") });
  await sleep(800);
  await dump("刚松手");
  await sleep(6000);
  await dump("松手 6s");
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "band-A-settled.png") });
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

/**
 * 真实浏览器 + 图层内部状态：定位「往相机近端拖动时瓦片几乎不更新」卡在哪一环。
 *
 * 每 400ms 采样一次图层内部状态（traversal / pending / loading / reveal / 可见集
 * 未加载缺口），同时驱动右键向下 / 向上拖动，输出时间轴对照。
 *
 * 运行：node scripts/diag-pan-state.cjs
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));

const PORT = process.env.PORT ?? "12400";
const URL = process.env.REPRO_URL ?? `http://127.0.0.1:${PORT}/examples/cesium-terrain/fullscreen/`;
const OUT_DIR = path.join(__dirname, "..", "artifacts");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate(() => ({
      canvases: document.querySelectorAll("canvas").length,
      status: [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join("|"),
    }));
    if (st.canvases > 0 && st.status.includes("就绪")) break;
    await sleep(1000);
  }
  await sleep(8000);

  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

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
  for (let i = 0; i < 7; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await sleep(350);
  }
  console.log("视角就绪，等待瓦片稳定…");
  await sleep(12000);

  // 采样器：读图层内部状态
  const sample = () =>
    page.evaluate(() => {
      const layer = globalThis.__terrainDebug;
      if (!layer) return { err: "no layer" };
      const stats = layer.getCacheStats();
      const visible = layer.currentVisibleKeys ?? new Set();
      const loaded = layer.loadedTiles ?? new Map();
      let miss = 0;
      const missKeys = [];
      for (const key of visible) {
        if (!loaded.has(key)) {
          miss++;
          if (missKeys.length < 8) missKeys.push(key);
        }
      }
      const zoomHist = {};
      for (const key of visible) {
        const z = key.split(",")[2];
        zoomHist[z] = (zoomHist[z] ?? 0) + 1;
      }
      const missZoomHist = {};
      for (const key of missKeys) {
        const z = key.split(",")[2];
        missZoomHist[z] = (missZoomHist[z] ?? 0) + 1;
      }
      // 渲染中（可见且 opacity>0.01）的瓦片数
      let rendered = 0;
      let reveal = 0;
      for (const [, entry] of loaded) {
        if (!entry.mesh.visible) continue;
        if ((entry.mesh.material?.opacity ?? 0) > 0.01) rendered++;
        if (entry.revealPending) reveal++;
      }
      return {
        vis: visible.size,
        loaded: loaded.size,
        miss,
        rendered,
        reveal,
        pending: (layer.pending ?? []).length,
        loading: (layer.loading ?? new Map()).size,
        stitchPending: stats.stitchPending,
        stitchInFlight: stats.stitchInFlight,
        revealPendingQ: stats.revealPending,
        stoppedBy: stats.traversal?.stoppedBy ?? "",
        visited: stats.traversal?.visited ?? 0,
        zoomHist: JSON.stringify(zoomHist),
        missKeys: missKeys.join(" | "),
      };
    });

  async function runPan({ label, sign, tag }) {
    console.log(`\n===== ${label} =====`);
    console.log("  时刻  vis/loaded/miss/渲染 | reveal渲染中 | pending/loading | stitch | 遍历 | 可见z分布 | miss样例");
    const t0 = Date.now();
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    const steps = 60;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(cx, cy + (sign * box.h * 0.42 * i) / steps);
      if (i % 4 === 0) {
        const s = await sample();
        const dt = Date.now() - t0;
        if (s.err) { console.log(`  ${dt}ms ${s.err}`); continue; }
        console.log(
          `  ${String(dt).padStart(5)}ms ${String(s.vis).padStart(3)}/${String(s.loaded).padStart(3)}/${String(s.miss).padStart(2)}/${String(s.rendered).padStart(3)}` +
            ` | r:${s.reveal} q:${s.revealPendingQ} | ${s.pending}/${s.loading} | st:${s.stitchPending}+${s.stitchInFlight}` +
            ` | ${s.visited}${s.stoppedBy ? "," + s.stoppedBy : ""} | z${s.zoomHist} | ${s.missKeys}`,
        );
      }
      await sleep(33);
    }
    await page.mouse.up({ button: "right" });
    await page.screenshot({ path: path.join(OUT_DIR, `panstate-${tag}-justafter.png`) });
    await sleep(6000);
    const s = await sample();
    console.log(`  [松手 6s] vis=${s.vis} loaded=${s.loaded} miss=${s.miss} rendered=${s.rendered} pending=${s.pending} loading=${s.loading}`);
    await page.screenshot({ path: path.join(OUT_DIR, `panstate-${tag}-settled.png`) });
  }

  await runPan({ label: "A 右键向下拖（内容往相机近端）", sign: +1, tag: "A" });
  console.log("等待回稳…");
  await sleep(8000);
  await runPan({ label: "B 右键向上拖（内容往远端）", sign: -1, tag: "B" });

  console.log("\npageerror:", errors.slice(0, 5).join(" || ") || "（无）");
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

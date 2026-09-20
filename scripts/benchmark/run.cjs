#!/usr/bin/env node
/**
 * 地形瓦片渲染量化基准测试
 * ------------------------------------------------------------------
 * 把"糊斑 / 不刷新 / 卡顿"这类主观观感翻译成图层内部可计算的硬指标，
 * 按 spec.json 的场景跑一遍，输出「实测 vs 期望 vs 基线」差异表。
 *
 * 用法：
 *   node scripts/benchmark/run.cjs                        # 跑全部场景
 *   node scripts/benchmark/run.cjs --scenarios=pan-near   # 只跑部分场景
 *   node scripts/benchmark/run.cjs --update-baseline      # 把本次结果写成新基线
 *   node scripts/benchmark/run.cjs --url=http://localhost:12345/xxx/
 *
 * 退出码：0 = 全部期望通过；1 = 有指标越界（可用于 CI / 提交前自检）。
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = process.cwd();
const SPEC_PATH = process.argv.find((a) => a.startsWith("--spec="))?.slice(7)
  || path.join(ROOT, "scripts", "benchmark", "spec.json");
const BASELINE_PATH = path.join(ROOT, "scripts", "benchmark", "baseline.json");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");
const ONLY = (process.argv.find((a) => a.startsWith("--scenarios="))?.slice(12) || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const URL_OVERRIDE = process.argv.find((a) => a.startsWith("--url="))?.slice(6);

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
const D = spec.defaults;
const URL = URL_OVERRIDE || spec.url;
const VP = spec.viewport || { width: 1280, height: 860 };

const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = path.join(ROOT, "artifacts", "benchmark", runId);
fs.mkdirSync(OUT_DIR, { recursive: true });

/** expect 里的指标名 → 场景聚合后的"最差值"字段名 */
const AGG_KEY = {
  blurRatioPeak: "blurRatioPeak",
  blurRatioFinal: "blurRatioFinal",
  uncoveredRatioPeak: "uncoveredRatioPeak",
  uncoveredRatioFinal: "uncoveredRatioFinal",
  dangerCoarse: "dangerCoarseMax",
  notReadyVisible: "notReadyVisibleMax",
  visSize: "visSizeMax",
  settleSeconds: "settleSeconds",
  dupTileRatio: "dupTileRatio",
  fpsMin: "fpsMin",
  interactingStuck: "interactingStuck",
};

/* ------------------------------------------------------------------ *
 * 页面内指标采集（必须是真实函数传给 page.evaluate，字符串会返回 undefined）
 * ------------------------------------------------------------------ */
function collectMetrics(cfg) {
  const L = globalThis.__terrainDebug;
  if (!L || !L.currentCamera) return { err: "not-ready" };
  const camera = L.currentCamera;
  const W = L.currentViewportWidth || window.innerWidth;
  const H = L.currentViewportHeight || window.innerHeight;
  const req = globalThis.__reqLog || { total: 0, inflight: 0, tileTotal: 0, tileUnique: 0 };

  // 候选：可见、已完全不透明、有纹理的瓦片
  const cands = [];
  let dangerCoarse = 0;
  let finestReadyZoom = 99;
  let notReadyVisible = 0;
  const Vec = camera.position.constructor;
  const v = new Vec();
  for (const [key, e] of L.loadedTiles) {
    if (!e.mesh || !e.mesh.visible) continue;
    const mat = e.mesh.material;
    const op = mat?.opacity ?? 0;
    if (op <= 0.99) { notReadyVisible++; continue; }
    const map = mat.map;
    const [x, y, z] = key.split(",").map(Number);
    if (map && map.image && e.imageryReady && z < finestReadyZoom) finestReadyZoom = z;
    if (!map || !map.image) continue;
    if (mat.depthWrite && z < finestReadyZoom) dangerCoarse++;

    const geo = e.mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    e.mesh.updateWorldMatrix(true, false);
    const bb = geo.boundingBox;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
      v.applyMatrix4(e.mesh.matrixWorld).project(camera);
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    const sx0 = (minX * 0.5 + 0.5) * W, sx1 = (maxX * 0.5 + 0.5) * W;
    const sy0 = (1 - (maxY * 0.5 + 0.5)) * H, sy1 = (1 - (minY * 0.5 + 0.5)) * H;
    if (sx1 < 0 || sy1 < 0 || sx0 > W || sy0 > H) continue;
    const texW = map.image.width || 0;
    let projPx = Math.max(sx1 - sx0, sy1 - sy0);
    try {
      const p = L.getTerrainTileProjection(x, y, z, camera);
      if (p && p.visiblePixelSize > 0) projPx = p.visiblePixelSize;
    } catch { /* 保持包围盒估计 */ }
    cands.push({ x, y, z, sx0, sx1, sy0, sy1, texW, ratio: texW > 0 ? projPx / texW : 99 });
  }

  // 屏幕网格采样：每点选"覆盖它的最细瓦片"（等价于精细瓦片后绘制且粗瓦片不写深度的观感）
  const cols = cfg.grid.cols, rows = cfg.grid.rows;
  const total = cols * rows;
  let sharp = 0, blur = 0, uncovered = 0;
  const winZoom = {};
  const blurSamples = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const px = ((gx + 0.5) / cols) * W, py = ((gy + 0.5) / rows) * H;
      let best = null;
      for (const c of cands) {
        if (px < c.sx0 || px > c.sx1 || py < c.sy0 || py > c.sy1) continue;
        if (!best || c.z > best.z || (c.z === best.z && (c.sx1 - c.sx0) < (best.sx1 - best.sx0))) best = c;
      }
      if (!best) { uncovered++; continue; }
      winZoom[best.z] = (winZoom[best.z] || 0) + 1;
      if (best.ratio <= cfg.sharpPixelRatio) sharp++;
      else {
        blur++;
        if (blurSamples.length < 8) blurSamples.push(`${best.x},${best.y},${best.z}(比${best.ratio.toFixed(1)})`);
      }
    }
  }

  const cs = L.getCacheStats ? L.getCacheStats() : {};
  const visZoom = {};
  for (const k of L.currentVisibleKeys) { const z = +k.split(",")[2]; visZoom[z] = (visZoom[z] || 0) + 1; }
  let fps = 0;
  const fpsEl = document.body.innerText.match(/FPS\s+(\d+)/);
  if (fpsEl) fps = +fpsEl[1];

  return {
    camH: Math.round(camera.position.length()),
    pose: [camera.position.x, camera.position.y, camera.position.z, camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w].map((n) => +n.toFixed(3)),
    interacting: !!L.cameraInteracting,
    visSize: L.currentVisibleKeys.size,
    visZoom,
    winZoom,
    blurRatio: +(blur / total).toFixed(4),
    uncoveredRatio: +(uncovered / total).toFixed(4),
    sharpRatio: +(sharp / total).toFixed(4),
    blurSamples,
    dangerCoarse,
    finestReadyZoom: finestReadyZoom === 99 ? null : finestReadyZoom,
    notReadyVisible,
    stitchPending: cs.stitchPending ?? 0,
    stitchInFlight: cs.stitchInFlight ?? 0,
    revealPending: cs.revealPending ?? 0,
    traversal: cs.traversal || null,
    reqInflight: req.inflight,
    reqTileTotal: req.tileTotal,
    dupTileRatio: req.tileTotal > 0 ? +((1 - req.tileUnique / req.tileTotal)).toFixed(4) : 0,
    fps,
  };
}

/* ------------------------------------------------------------------ *
 * 浏览器与页面准备
 * ------------------------------------------------------------------ */
async function launch() {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: VP });
  // fetch 计数：瓦片 URL（…/z/x/y.…）的总量、唯一量与在途量
  await page.addInitScript(() => {
    const orig = window.fetch;
    const L = { total: 0, inflight: 0, tileTotal: 0, tileUnique: 0, seen: {} };
    window.__reqLog = L;
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      L.total++;
      L.inflight++;
      const m = /(\d+)\/(\d+)\/(\d+)[./]/.exec(url);
      if (m) {
        L.tileTotal++;
        const key = url.split("?")[0];
        if (!L.seen[key]) { L.seen[key] = 1; L.tileUnique++; }
      }
      return orig.apply(this, args).finally(() => { L.inflight--; });
    };
  });
  page.on("pageerror", (e) => console.log(`   [pageerror] ${String(e).slice(0, 200)}`));
  return { browser, page };
}

async function waitReady(page, maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    const ok = await page.evaluate(() =>
      document.querySelectorAll("canvas").length > 0 &&
      !!(globalThis.__terrainDebug && globalThis.__terrainDebug.currentCamera));
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

async function sample(page) {
  return page.evaluate(collectMetrics, { grid: D.grid, sharpPixelRatio: D.sharpPixelRatio });
}

/* ------------------------------------------------------------------ *
 * 操作原语
 * ------------------------------------------------------------------ */
async function runOp(page, op, cx, cy, onRound) {
  switch (op.op) {
    case "zoomIn":
      for (let i = 0; i < op.steps; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -240); await sleep(op.intervalMs ?? 250); }
      break;
    case "zoomOut":
      for (let i = 0; i < op.steps; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, 240); await sleep(op.intervalMs ?? 250); }
      break;
    case "tilt":
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "left" });
      for (let i = 0; i < op.steps; i++) { await page.mouse.move(cx, cy + op.dy, { steps: 4 }); await sleep(60); }
      await page.mouse.up({ button: "left" });
      break;
    case "rotate":
      for (let r = 1; r <= op.rounds; r++) {
        const dir = r % 2 === 1 ? 1 : -1;
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: "left" });
        for (let i = 0; i < 8; i++) { await page.mouse.move(cx + dir * op.dx, cy, { steps: 4 }); await sleep(70); }
        await page.mouse.up({ button: "left" });
        await sleep(1000);
        if (onRound) await onRound(r, `${op.op}R${r}`);
        await sleep(1000);
      }
      break;
    case "pan": {
      const sign = op.dir === "far" ? -1 : 1;
      for (let r = 1; r <= op.rounds; r++) {
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: "right" });
        for (let i = 0; i < 8; i++) { await page.mouse.move(cx, cy + sign * op.dy, { steps: 4 }); await sleep(70); }
        await page.mouse.up({ button: "right" });
        await sleep(1000);
        if (onRound) await onRound(r, `${op.op}-${op.dir}R${r}`);
        await sleep(1000);
      }
      break;
    }
    default:
      throw new Error(`未知操作: ${op.op}`);
  }
}

/** 静置：等到队列/请求/候场全部排空且糊斑不再改善 */
async function settle(page, label) {
  const t0 = Date.now();
  let quiet = 0, last = null, seconds = 0;
  while (seconds < D.settleMaxSeconds) {
    last = await sample(page);
    if (last.err) { await sleep(D.sampleIntervalMs); seconds = (Date.now() - t0) / 1000; continue; }
    const drained = last.stitchPending + last.stitchInFlight + last.revealPending === 0 && last.reqInflight === 0;
    if (drained && last.notReadyVisible === 0 && last.blurRatio <= 0.02) quiet++;
    else quiet = 0;
    if (quiet >= D.settleQuietSamples) break;
    await sleep(D.sampleIntervalMs);
    seconds = (Date.now() - t0) / 1000;
  }
  seconds = (Date.now() - t0) / 1000;
  console.log(`   [${label}] 静置 ${seconds.toFixed(1)}s ${quiet >= D.settleQuietSamples ? "已收敛" : "未收敛(超时)"} → 糊斑=${(last?.blurRatio ?? -1) * 100}% 队列=${last?.stitchPending}+${last?.stitchInFlight} 在途=${last?.reqInflight}`);
  return { seconds: +seconds.toFixed(1), settled: quiet >= D.settleQuietSamples, last };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
(async () => {
  const scenarios = spec.scenarios.filter((s) => ONLY.length === 0 || ONLY.includes(s.id));
  const baseline = fs.existsSync(BASELINE_PATH) && !UPDATE_BASELINE
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
    : null;

  const { browser, page } = await launch();
  const cx = Math.round(VP.width / 2), cy = Math.round(VP.height * 0.5);
  const report = { runId, url: URL, spec: path.basename(SPEC_PATH), scenarios: [], failures: [] };

  for (const sc of scenarios) {
    console.log(`\n=== 场景 ${sc.id}：${sc.title} ===`);
    const t0 = Date.now();
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    if (!(await waitReady(page, D.readyTimeoutSeconds))) {
      console.log("   ✗ 页面/图层未就绪，跳过");
      report.scenarios.push({ id: sc.id, title: sc.title, error: "not-ready" });
      report.failures.push(`${sc.id}: 页面未就绪`);
      continue;
    }
    await sleep(8000); // Ion 凭据交换 + 首批瓦片

    const samples = [];
    let settleSeconds = null, settled = null;
    let prevPose = null, stuckCount = 0;

    const takeSample = async (tag) => {
      const s = await sample(page);
      if (s.err) return null;
      if (s.interacting && prevPose && s.pose.every((n, i) => Math.abs(n - prevPose[i]) < 1e-3)) stuckCount++;
      prevPose = s.pose;
      samples.push({ tag, ...s });
      console.log(`   [${tag}] camH=${s.camH} 糊斑=${(s.blurRatio * 100).toFixed(1)}% 空洞=${(s.uncoveredRatio * 100).toFixed(1)}% 危险粗=${s.dangerCoarse} 可见集=${s.visSize} 队列=${s.stitchPending}+${s.stitchInFlight} 在途=${s.reqInflight}`);
      return s;
    };

    let stepIdx = 0;
    for (const op of sc.steps) {
      stepIdx++;
      if (op.op === "settle") {
        const r = await settle(page, `${sc.id}#${stepIdx}`);
        settleSeconds = r.seconds; settled = r.settled;
        await takeSample(`${stepIdx}-settle`);
      } else {
        console.log(`   · 执行 ${op.op}${op.steps ? ` x${op.steps}` : ""}${op.rounds ? ` x${op.rounds}轮` : ""}`);
        // 转动/平移逐轮采样：糊斑峰值出现在交互过程中，只在操作结束后采会漏掉
        await runOp(page, op, cx, cy, async (round, tag) => { await takeSample(`${stepIdx}-${tag}`); });
        await sleep(1500);
        await takeSample(`${stepIdx}-${op.op}`);
      }
      await page.screenshot({ path: path.join(OUT_DIR, `${sc.id}-${stepIdx}-${op.op}.png`) });
    }

    // 场景聚合（取最差；final = 收敛后的最终画面）
    const last = samples[samples.length - 1] || {};
    const agg = {
      blurRatioPeak: Math.max(...samples.map((s) => s.blurRatio)),
      blurRatioFinal: last.blurRatio ?? null,
      uncoveredRatioPeak: Math.max(...samples.map((s) => s.uncoveredRatio)),
      uncoveredRatioFinal: last.uncoveredRatio ?? null,
      dangerCoarseMax: Math.max(...samples.map((s) => s.dangerCoarse)),
      notReadyVisibleMax: Math.max(...samples.map((s) => s.notReadyVisible)),
      visSizeMax: Math.max(...samples.map((s) => s.visSize)),
      dupTileRatio: last.dupTileRatio ?? 0,
      reqTileTotal: last.reqTileTotal ?? 0,
      fpsMin: samples.length ? Math.min(...samples.map((s) => s.fps)) : 0,
      interactingStuck: stuckCount,
      settleSeconds,
      settled,
    };

    // 期望比对
    const checks = [];
    for (const [metric, rule] of Object.entries(sc.expect || {})) {
      const actual = agg[AGG_KEY[metric] || metric];
      if (actual === null || actual === undefined) { checks.push({ metric, actual, rule, pass: null }); continue; }
      const pass = rule.max !== undefined ? actual <= rule.max : rule.min !== undefined ? actual >= rule.min : null;
      checks.push({ metric, actual, rule, pass });
      if (pass === false) report.failures.push(`${sc.id}.${metric}: 实测 ${actual}，期望 ${rule.max !== undefined ? `<= ${rule.max}` : `>= ${rule.min}`}`);
    }
    report.scenarios.push({
      id: sc.id, title: sc.title, elapsedSeconds: +((Date.now() - t0) / 1000).toFixed(1),
      agg, checks, settled, stuckPoseSamples: stuckCount,
      checkpoints: samples.map((s) => ({ tag: s.tag, camH: s.camH, blurRatio: s.blurRatio, uncoveredRatio: s.uncoveredRatio, dangerCoarse: s.dangerCoarse, visSize: s.visSize, stitch: [s.stitchPending, s.stitchInFlight], reqInflight: s.reqInflight, fps: s.fps, visZoom: s.visZoom, blurSamples: s.blurSamples })),
    });
  }

  await browser.close();

  // ---------------- 报告 ----------------
  const md = [];
  md.push(`# 地形瓦片渲染基准报告`);
  md.push("");
  md.push(`- 运行时间：${new Date().toLocaleString("zh-CN")}`);
  md.push(`- 目标页面：${URL}`);
  md.push(`- 场景数：${report.scenarios.length}　失败项：${report.failures.length}`);
  md.push("");
  md.push(`| 场景 | 糊斑峰值 | 糊斑最终 | 空洞最终 | 危险粗瓦片 | 收敛(s) | 重复请求率 | 最低FPS | 手势卡死 | 结论 |`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of report.scenarios) {
    if (s.error) { md.push(`| ${s.id} | - | - | - | - | - | - | - | - | ✗ ${s.error} |`); continue; }
    const a = s.agg;
    md.push(`| ${s.id} | ${(a.blurRatioPeak * 100).toFixed(1)}% | ${a.blurRatioFinal === null ? "-" : (a.blurRatioFinal * 100).toFixed(1) + "%"} | ${a.uncoveredRatioFinal === null ? "-" : (a.uncoveredRatioFinal * 100).toFixed(1) + "%"} | ${a.dangerCoarseMax} | ${a.settleSeconds ?? "-"} | ${(a.dupTileRatio * 100).toFixed(0)}% | ${a.fpsMin} | ${a.interactingStuck} | ${s.checks.every((c) => c.pass !== false) ? "PASS" : "FAIL"} |`);
  }
  md.push("");
  md.push(`## 期望比对明细`);
  md.push("");
  md.push(`| 场景 | 指标 | 实测 | 期望 | 结果 | 基线 | 变化 |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const s of report.scenarios) {
    for (const c of s.checks) {
      const key = AGG_KEY[c.metric] || c.metric;
      const bl = baseline?.scenarios?.[s.id]?.agg?.[key];
      const fmt = (v) => (v === null || v === undefined ? "-" : typeof v === "number" ? +v.toFixed(4) : v);
      let delta = "-";
      if (typeof c.actual === "number" && typeof bl === "number") {
        const d = c.actual - bl;
        delta = `${d >= 0 ? "+" : ""}${+d.toFixed(4)}`;
      }
      const want = c.rule.max !== undefined ? `<= ${c.rule.max}` : `>= ${c.rule.min}`;
      md.push(`| ${s.id} | ${c.metric} | ${fmt(c.actual)} | ${want} | ${c.pass === false ? "FAIL" : c.pass === null ? "?" : "PASS"} | ${fmt(bl)} | ${delta} |`);
    }
  }
  if (report.failures.length) {
    md.push("");
    md.push(`## 失败项`);
    for (const f of report.failures) md.push(`- ${f}`);
  }
  md.push("");
  md.push(`截图：\`artifacts/benchmark/${runId}/\``);

  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "report.md"), md.join("\n"));
  fs.writeFileSync(path.join(ROOT, "artifacts", "benchmark", "latest.md"), md.join("\n"));

  if (UPDATE_BASELINE) {
    const bl = { generatedAt: new Date().toISOString(), url: URL, scenarios: {} };
    for (const s of report.scenarios) if (s.agg) bl.scenarios[s.id] = { agg: s.agg };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(bl, null, 2));
    console.log(`\n基线已更新：${path.relative(ROOT, BASELINE_PATH)}`);
  }

  console.log(`\n${md.join("\n")}`);
  console.log(`\n报告：artifacts/benchmark/${runId}/report.md`);
  process.exit(report.failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

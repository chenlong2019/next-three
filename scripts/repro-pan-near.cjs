/**
 * 真实浏览器复现（v2）：低空平移拖动时瓦片请求流是否中断，并对比两个拖动方向。
 *
 * 流程：
 *   1. 打开 demo，等瓦片稳定；
 *   2. 左键拖拽压低视角 → 滚轮拉近到低空；
 *   3. 右键向下拖（内容朝相机近端滑动）：逐秒统计 .terrain / 影像请求数 + 截图 + HUD；
 *   4. 反向再拖一次；
 *   5. 对照输出。
 *
 * 运行：node scripts/repro-pan-near.cjs
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));

const PORT = process.env.PORT ?? "12400";
const URL = process.env.REPRO_URL ?? `http://127.0.0.1:${PORT}/examples/cesium-terrain/fullscreen/`;
const OUT_DIR = path.join(__dirname, "..", "artifacts");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WIDTH = 1280;
const HEIGHT = 860;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TERRAIN_RE = /\.terrain(\?|$)/;
const IMAGERY_RE = /(mt\d\.google\.com|googleapis\.com|lyrs=)/;
const classify = (url) => (TERRAIN_RE.test(url) ? "terrain" : IMAGERY_RE.test(url) ? "imagery" : null);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const logs = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 300)}`));

  const events = [];
  const seen = new Set();
  page.on("request", (req) => {
    const kind = classify(req.url());
    if (!kind) return;
    events.push({ t: Date.now(), kind, fresh: !seen.has(req.url()) });
    seen.add(req.url());
  });
  page.on("requestfailed", (r) => {
    const kind = classify(r.url());
    if (kind) events.push({ t: Date.now(), kind, fresh: false, failed: true });
  });

  console.log(`打开 ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });

  let ready = false;
  for (let i = 0; i < 90; i++) {
    const st = await page.evaluate(() => ({
      canvases: document.querySelectorAll("canvas").length,
      status: [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join("|"),
    }));
    if (st.canvases > 0 && st.status.includes("就绪")) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) { console.log("场景未就绪\n" + logs.slice(-10).join("\n")); await browser.close(); return; }

  // 等初始瓦片稳定
  for (let i = 0; i < 120; i++) {
    const t = events.filter((e) => e.kind === "terrain").length;
    const last = events.length ? events[events.length - 1].t : 0;
    if (t >= 40 && Date.now() - last > 2500) break;
    await sleep(1000);
  }
  console.log(`初始稳定：terrain=${events.filter((e) => e.kind === "terrain").length} imagery=${events.filter((e) => e.kind === "imagery").length}`);

  const box = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const hud = async () =>
    (await page.evaluate(() => {
      const hudEl = [...document.querySelectorAll("div")].find((d) => d.textContent?.startsWith("FPS "));
      return hudEl ? hudEl.textContent.replace(/\s+/g, " ").slice(0, 160) : "(no hud)";
    })) ?? "";

  const drag = async ({ button, x, fromY, toY, ms, onStep }) => {
    await page.mouse.move(x, fromY);
    await page.mouse.down({ button });
    const steps = Math.max(8, Math.round(ms / 33));
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(x, fromY + ((toY - fromY) * i) / steps);
      await sleep(33);
      if (onStep) await onStep(i, steps);
    }
    await page.mouse.up({ button });
  };

  // 1) 压低视角
  await drag({ button: "left", x: cx, fromY: box.y + box.h * 0.65, toY: box.y + box.h * 0.28, ms: 800 });
  await sleep(4000);
  // 2) 滚轮拉近（zoomToCursor 朝光标缩放）
  for (let i = 0; i < 7; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -400);
    await sleep(350);
  }
  console.log("已压低并拉近，等待瓦片…");
  for (let i = 0; i < 60; i++) {
    const last = events.length ? events[events.length - 1].t : 0;
    if (Date.now() - last > 2500) break;
    await sleep(1000);
  }
  const preA = { terrain: events.filter((e) => e.kind === "terrain").length, imagery: events.filter((e) => e.kind === "imagery").length };
  console.log(`拉近后稳定：terrain=${preA.terrain} imagery=${preA.imagery} | HUD: ${await hud()}`);
  await page.screenshot({ path: path.join(OUT_DIR, "pan2-00-low.png") });

  async function panTest({ label, sign, tag }) {
    for (let i = 0; i < 30; i++) {
      const last = events.length ? events[events.length - 1].t : 0;
      if (Date.now() - last > 2500) break;
      await sleep(1000);
    }
    await page.screenshot({ path: path.join(OUT_DIR, `pan2-${tag}-before.png`) });
    const t0 = Date.now();
    const perSec = [];
    let sec = Math.floor(t0 / 1000);
    let bucket = { terrain: 0, imagery: 0 };
    const shots = [];
    await drag({
      button: "right",
      x: cx,
      fromY: cy,
      toY: cy + sign * box.h * 0.42,
      ms: 2400,
      onStep: async (i) => {
        const now = Date.now();
        const s = Math.floor(now / 1000);
        while (s > sec) { perSec.push({ ...bucket }); bucket = { terrain: 0, imagery: 0 }; sec++; }
        if (i % 8 === 0) {
          const name = `pan2-${tag}-d${String(shots.length).padStart(2, "0")}.png`;
          shots.push(name);
          await page.screenshot({ path: path.join(OUT_DIR, name) });
        }
      },
    });
    const t1 = Date.now();
    while (Math.floor(t1 / 1000) >= sec) { perSec.push({ ...bucket }); bucket = { terrain: 0, imagery: 0 }; sec++; }
    await page.screenshot({ path: path.join(OUT_DIR, `pan2-${tag}-justafter.png`) });
    await sleep(1500);
    const t2 = Date.now();
    await sleep(4000);
    const after = { terrain: 0, imagery: 0 };
    for (const e of events) if (e.t >= t2) after[e.kind]++;
    await page.screenshot({ path: path.join(OUT_DIR, `pan2-${tag}-settled.png`) });

    const total = { terrain: 0, imagery: 0 };
    for (const e of events) if (e.t >= t0 && e.t <= t1) total[e.kind]++;
    console.log(`\n[${label}] 拖动 ${((t1 - t0) / 1000).toFixed(1)}s 逐秒 terrain/imagery：` +
      perSec.map((b) => `${b.terrain}/${b.imagery}`).join(" "));
    console.log(`   合计 terrain=${total.terrain} imagery=${total.imagery}；松手 4s 后 terrain=${after.terrain} imagery=${after.imagery}`);
    console.log(`   HUD: ${await hud()}`);
    return { total, after, perSec };
  }

  const A = await panTest({ label: "A 右键向下拖（内容往相机近端）", sign: +1, tag: "A-down" });
  const B = await panTest({ label: "B 右键向上拖（内容往远端）", sign: -1, tag: "B-up" });

  console.log("\n=== 对照（拖动期间请求数）===");
  console.log(`向下拖：terrain=${A.total.terrain} imagery=${A.total.imagery}`);
  console.log(`向上拖：terrain=${B.total.terrain} imagery=${B.total.imagery}`);
  const errs = logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(0, 20);
  console.log("\n=== 控制台错误 ===\n" + (errs.join("\n") || "（无）"));
  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

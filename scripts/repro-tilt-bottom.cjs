/**
 * 在真实浏览器里复现：倾斜视角后，屏幕最下方一条瓦片的状态。
 *
 * 用项目内的 playwright + 系统 Chrome（不下载 Chromium）。
 * 流程：打开 Cesium 地形 demo → 等瓦片稳定 → 截图 → 拖拽俯仰 → 等稳定 → 截图。
 * 同时把控制台报错、HUD 文本、以及页面内注入的诊断（每帧统计"底部带"覆盖瓦片）
 * 一起输出。
 *
 * 运行：node scripts/repro-tilt-bottom.cjs
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));

const URL = process.env.REPRO_URL ?? "http://127.0.0.1:12345/examples/cesium-terrain";
const OUT_DIR = path.join(__dirname, "..", "artifacts");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WIDTH = 1280;
const HEIGHT = 860;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-webgl",
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  console.log(`打开 ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(12000);
  dumpLogs("页面加载后");
  await sleep(8000);
  dumpLogs("20s 后");
  await sleep(10000);
  dumpLogs("30s 后");

  function dumpLogs(tag) {
    console.log(`\n=== 控制台 @ ${tag} ===`);
    console.log(
      logs
        .slice(-30)
        .map((l) => "  " + l.slice(0, 300))
        .join("\n") || "  （无）",
    );
  }

  // 等 WebGL / 画布就绪
  const webgl = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return "no-canvas";
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    return gl ? "ok" : "no-gl";
  });
  console.log(`WebGL 状态: ${webgl}`);
  console.log(`画布尺寸: ${JSON.stringify(await page.evaluate(() => {
    const c = document.querySelector("canvas");
    return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null;
  }))}`);

  // 让瓦片加载稳定
  await sleep(20000);
  await page.screenshot({ path: path.join(OUT_DIR, "repro-tilt-01-before.png") });
  console.log("已保存 before 截图（俯视稳定）");
  console.log("HUD: " + (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1200))));

  const box = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  // 拖拽俯仰：从画布偏下往上拖（OrbitControls 向上拖 = 抬高视线/减小俯仰）
  const cx = box.x + box.w * 0.62;
  const startY = box.y + box.h * 0.62;
  const endY = box.y + box.h * 0.34;
  await page.mouse.move(cx, startY);
  await page.mouse.down();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx, startY + ((endY - startY) * i) / steps);
    await sleep(16);
  }
  await page.mouse.up();
  console.log("拖拽完成，等待稳定");
  await sleep(6000);
  await page.screenshot({ path: path.join(OUT_DIR, "repro-tilt-02-after.png") });
  console.log("已保存 after 截图（倾斜）");
  console.log("HUD: " + (await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1200))));

  await sleep(8000);
  await page.screenshot({ path: path.join(OUT_DIR, "repro-tilt-03-settled.png") });
  console.log("已保存 settled 截图（倾斜后 8s）");

  const errs = logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]")).slice(0, 40);
  console.log("\n=== 控制台错误（前 40）===");
  console.log(errs.join("\n") || "  （无）");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ORIGIN = "http://localhost:12345";
const OUT = path.resolve("artifacts/dev-health");
fs.mkdirSync(OUT, { recursive: true });

const cases = [
  { url: "/", name: "home", shot: "home.png" },
  { url: "/examples/", name: "examples", shot: "examples.png" },
  { url: "/examples/cesium-terrain/", name: "cesium", shot: "cesium.png" },
  { url: "/examples/xiamen-daylight/", name: "daylight", shot: "daylight.png" },
  { url: "/examples/xiamen-daylight/fullscreen/", name: "daylight-full", shot: "daylight-full.png" },
];

const IGNORE = [/favicon/i, /React DevTools/i, /NODE_TLS_REJECT_UNAUTHORIZED/i, /Slow filesystem/i];

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});

const results = [];

for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  let probe = null;
  try {
    await page.goto(ORIGIN + c.url, { waitUntil: "load", timeout: 60_000 });

    // 等 canvas 出现（软件渲染下 WebGL 初始化较慢）
    let gotCanvas = false;
    for (let i = 0; i < 30; i++) {
      gotCanvas = await page.evaluate(() => document.querySelector("canvas") !== null);
      if (gotCanvas) break;
      await page.waitForTimeout(1_000);
    }
    await page.waitForTimeout(3_000);

    probe = await page.evaluate(() => {
      let cssRules = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          cssRules += sheet.cssRules?.length ?? 0;
        } catch {
          /* cross-origin */
        }
      }
      const canvas = document.querySelector("canvas");
      const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
      const statusEl = document.querySelector('[role="status"]');
      // 真正的错误遮罩只会在报错时插入 dialog 节点
      const errorDialog = document.querySelector("nextjs-portal [data-nextjs-dialog]");
      return {
        cssRules,
        bodyMargin: getComputedStyle(document.body).margin,
        lucideSvgs: document.querySelectorAll("svg.lucide").length,
        // CSS Module 生效的证据：哈希化类名 + overlay 元素存在
        cssModuleApplied: document.querySelectorAll('[class*="overlay"]').length > 0,
        errorDialog: Boolean(errorDialog),
        status: statusEl?.textContent?.trim() ?? null,
        hasCanvas: Boolean(canvas),
        canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
        glLost: gl ? gl.isContextLost() : null,
        glVersion: gl ? gl.getParameter(gl.VERSION) : null,
      };
    });

    await page.screenshot({ path: path.join(OUT, c.shot) });
  } catch (error) {
    errors.push(`navigate: ${error.message}`);
  }

  const filtered = errors.filter((e) => !IGNORE.some((re) => re.test(e)));
  results.push({ ...c, errors: filtered, probe });
  await page.close();
}

await browser.close();

let failed = 0;
console.log("\n===== Dev 健康检查 =====\n");
for (const r of results) {
  const p = r.probe;
  const ok = Boolean(p) && p.cssRules > 100 && !p.errorDialog && r.errors.length === 0;
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${r.name.padEnd(14)} css=${p?.cssRules} margin=${p?.bodyMargin} lucide=${p?.lucideSvgs} cssMod=${p?.cssModuleApplied} 错误遮罩=${p?.errorDialog} canvas=${p?.canvasSize} glLost=${p?.glLost} status=${p?.status ?? "-"}`,
  );
  if (r.errors.length) console.log(`      错误: ${r.errors.slice(0, 4).join(" | ")}`);
}
console.log(`\n汇总: ${results.length - failed}/${results.length} 通过，截图目录 ${OUT}\n`);
process.exit(failed ? 1 : 0);

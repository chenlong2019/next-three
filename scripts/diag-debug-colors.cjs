/**
 * 层级着色验证模式（?debugColors=1）的自动化验证。
 *
 * 断言四件事：
 *   1. 模式已生效（isDebugColorMode() === true）；
 *   2. 该模式期间**没有任何影像网络请求**（拦截 fetch 计数）；
 *   3. 已上屏瓦片的材质全是"无色块纹理的层级纯色"（map === null）；
 *   4. 退出该模式后影像重新挂上（map !== null 的瓦片数回升）。
 * 同时按阶段输出图例（层级 → 颜色/正选数/上屏数）与截图，便于人眼比对。
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));

const URL =
  process.env.REPRO_URL ||
  "http://localhost:12345/examples/cesium-terrain/fullscreen/?debugColors=1";
const OUT_DIR = path.join(process.cwd(), "artifacts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(page, label) {
  for (let i = 0; i < 90; i++) {
    const ok = await page.evaluate(
      () => Boolean(globalThis.__terrainDebug && globalThis.__terrainDebug.currentCamera),
    );
    if (ok) return true;
    await sleep(1000);
  }
  console.log(`!! ${label}: 等待 __terrainDebug.currentCamera 超时`);
  return false;
}

async function sample(page) {
  return page.evaluate(() => {
    const L = globalThis.__terrainDebug;
    if (!L) return { err: "no layer" };
    let onScreen = 0;
    let withMap = 0;
    let withoutMap = 0;
    const colorByZoom = {};
    for (const [key, entry] of L.loadedTiles) {
      const mesh = entry.mesh;
      if (!mesh?.visible) continue;
      const mat = mesh.material;
      if ((mat?.opacity ?? 0) <= 0.5) continue;
      onScreen++;
      if (mat.map) withMap++;
      else withoutMap++;
      const zoom = Number(key.split(",")[2]);
      const hex = mat.color.getHexString();
      (colorByZoom[zoom] = colorByZoom[zoom] || new Set()).add(hex);
    }
    const colorSpread = {};
    for (const [zoom, set] of Object.entries(colorByZoom)) colorSpread[zoom] = set.size;
    const cs = L.getCacheStats ? L.getCacheStats() : {};
    return {
      debugMode: L.isDebugColorMode(),
      camH: Math.round(L.currentCamera.position.length()),
      onScreen,
      withMap,
      withoutMap,
      colorSpread,
      legend: L.getZoomColorLegend(),
      stitch: `${cs.stitchPending ?? "?"}+${cs.stitchInFlight ?? "?"}`,
      imgRequests: globalThis.__imgReq ?? -1,
    };
  });
}

async function dump(page, label, shotName) {
  const s = await sample(page);
  console.log(`\n===== ${label} =====`);
  if (s.err) {
    console.log("ERR:", s.err);
    return s;
  }
  console.log(
    `调试模式=${s.debugMode} 相机高度=${s.camH}m 上屏瓦片=${s.onScreen}（有纹理 ${s.withMap} / 纯色 ${s.withoutMap}）`,
  );
  console.log(`影像请求累计=${s.imgRequests} 拼接队列=${s.stitch}`);
  console.log(
    `图例: ${s.legend.map((r) => `z${r.zoom}${r.color}(选${r.visible}/屏${r.loaded})`).join(" ")}`,
  );
  const spread = Object.entries(s.colorSpread)
    .map(([z, n]) => `z${z}:${n}色`)
    .join(" ");
  console.log(`层内色数（>1 说明同层多块颜色可区分）: ${spread}`);
  if (shotName) {
    const file = path.join(OUT_DIR, shotName);
    await page.screenshot({ path: file });
    console.log(`截图 → ${path.relative(process.cwd(), file)}`);
  }
  return s;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.addInitScript(() => {
    globalThis.__imgReq = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (/mt\d\.google\.com|\/vt\//.test(url)) globalThis.__imgReq++;
      return orig.apply(this, arguments);
    };
  });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));

  console.log(`URL: ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page, "就绪"))) {
    await browser.close();
    process.exit(2);
  }
  await sleep(12000);
  const s1 = await dump(page, "1-就绪（层级着色）", "dc-1-就绪.png");

  // 拉近（24 步 ≈ 18km → 1km 级，观察层级色随距离细化）
  const cx = 640;
  const cy = 430;
  for (let i = 0; i < 24; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(280);
  }
  await sleep(6000);
  const s2 = await dump(page, "2-拉近", "dc-2-拉近.png");

  // 压低视角
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx, cy + 26, { steps: 4 });
    await sleep(60);
  }
  await page.mouse.up({ button: "left" });
  await sleep(6000);
  const s3 = await dump(page, "3-压低视角", "dc-3-压低视角.png");

  // 转动
  for (let r = 0; r < 2; r++) {
    const dir = r % 2 === 0 ? 1 : -1;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "left" });
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(cx + dir * 90, cy, { steps: 4 });
      await sleep(70);
    }
    await page.mouse.up({ button: "left" });
    await sleep(2500);
  }
  await sleep(6000);
  const s4 = await dump(page, "4-转动后", "dc-4-转动后.png");

  // 退出调试模式 → 影像应重新挂上
  await page.evaluate(() => globalThis.__terrainDebug.setDebugColorMode(false));
  const reqBeforeRestore = await page.evaluate(() => globalThis.__imgReq);
  for (const wait of [3000, 5000, 7000]) {
    await sleep(wait);
    const s = await sample(page);
    console.log(
      `  退出调试 +${wait}ms: 上屏=${s.onScreen} 有纹理=${s.withMap} 纯色=${s.withoutMap} 影像请求=${s.imgRequests}（退出后新增 ${s.imgRequests - reqBeforeRestore}）`,
    );
  }
  const s5 = await dump(page, "5-退出调试模式后", "dc-5-退出调试.png");

  // ─── 断言 ───
  const checks = [];
  const push = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  push("模式已生效", s1.debugMode === true, `isDebugColorMode=${s1.debugMode}`);
  push(
    "调试期间零影像请求",
    s4.imgRequests === 0,
    `累计 ${s4.imgRequests} 次（应恒为 0）`,
  );
  push(
    "上屏瓦片全部为纯色（无纹理）",
    s1.onScreen > 0 && s1.withMap === 0,
    `上屏 ${s1.onScreen}，其中有纹理 ${s1.withMap}`,
  );
  const zoomColors = s1.legend.map((r) => r.color);
  // 反查截图要求任意两级颜色距离 ≥60（供 analyze-shot-colors.cjs 判读层级）
  const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  let minColorDist = Infinity;
  let minPair = "";
  for (let i = 0; i < zoomColors.length; i++)
    for (let j = i + 1; j < zoomColors.length; j++) {
      const a = rgb(zoomColors[i]);
      const b = rgb(zoomColors[j]);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < minColorDist) {
        minColorDist = d;
        minPair = `${s1.legend[i].zoom}/${s1.legend[j].zoom}`;
      }
    }
  push(
    "各层级颜色可分辨（最小 RGB 距离 ≥60）",
    minColorDist >= 60 || !Number.isFinite(minColorDist),
    `最小间距 ${minColorDist.toFixed(1)}（z${minPair}）`,
  );
  push(
    "退出后影像恢复",
    s5.withMap > 0,
    `有纹理瓦片 ${s5.withMap} / 上屏 ${s5.onScreen}，新增影像请求 ${s5.imgRequests - reqBeforeRestore}`,
  );
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n结论：${checks.length - failed.length}/${checks.length} 通过`);

  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

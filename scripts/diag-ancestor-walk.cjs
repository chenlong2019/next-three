/**
 * 祖先回溯深度回归探针（对应 MAX_ANCESTOR_WALK 缺口）。
 *
 * 复现深层级差场景：先在 18km 等底图毯（z5~z9）加载完成，再快速拉近到
 * 数百米（精细瓦片到 z18~z20），此时"最细 − 最粗"层级差可超过旧的 12 层
 * 回溯上限 → 粗祖先未标记"已被覆盖"、保留 depthWrite=true，其巨大三角弦
 * 赢得深度测试，把精细瓦片盖掉（用户现象：高等级瓦片被低等级斑块覆盖）。
 *
 * 断言不变量：任何 depthWrite=true 且 zoom < targetZoom 的已加载瓦片，
 * 其地理范围内不得存在 zoom 更深的可渲染瓦片（否则它本该被标记覆盖、
 * 关掉深度写入）。
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));

const URL =
  process.env.REPRO_URL ||
  "http://localhost:12345/examples/cesium-terrain/fullscreen/?debugColors=1";
const OUT_DIR = path.join(process.cwd(), "artifacts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(page) {
  for (let i = 0; i < 90; i++) {
    const ok = await page.evaluate(
      () =>
        Boolean(
          globalThis.__terrainDebug &&
            globalThis.__terrainDebug.currentCamera &&
            globalThis.__terrainDebug.currentVisibleKeys.size > 0,
        ),
    );
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

/** 页面内：层级差统计 + depthWrite 不变量检查 */
function checkInvariants() {
  const L = globalThis.__terrainDebug;
  if (!L || !L.currentCamera) return { err: "not ready" };
  const yOrigin = L.tileYOrigin ?? "south";
  const boundsOf = (x, y, z) => {
    const nx = Math.pow(2, z + 1);
    const ny = Math.pow(2, z);
    const north = yOrigin === "north" ? 90 - (y / ny) * 180 : ((y + 1) / ny) * 180 - 90;
    const south = yOrigin === "north" ? 90 - ((y + 1) / ny) * 180 : (y / ny) * 180 - 90;
    return { west: (x / nx) * 360 - 180, east: ((x + 1) / nx) * 360 - 180, south, north };
  };

  let targetZoom = 0;
  for (const key of L.currentVisibleKeys) {
    const z = Number(key.split(",")[2]);
    if (z > targetZoom) targetZoom = z;
  }

  // 收集"可渲染瓦片"的 bounds（debug 模式下 imageryReady 恒为 true，直接看可见+不透明）
  const renderable = [];
  for (const [key, entry] of L.loadedTiles) {
    const mesh = entry.mesh;
    const mat = mesh && mesh.material;
    if (!mesh || !mesh.visible || (mat?.opacity ?? 0) <= 0.5) continue;
    const [x, y, z] = key.split(",").map(Number);
    renderable.push({ key, x, y, z, b: boundsOf(x, y, z), dw: Boolean(mat.depthWrite) });
  }

  const coarse = renderable.filter((t) => t.z < targetZoom);
  const fine = renderable.filter((t) => t.z >= targetZoom - 2);
  const stackDepth = fine.length && coarse.length ? Math.max(...fine.map((t) => t.z)) - Math.min(...coarse.map((t) => t.z)) : 0;

  const violations = [];
  const dwTrueCoarse = [];
  for (const c of coarse) {
    if (c.dw) {
      dwTrueCoarse.push(c);
      // 不变量：范围内不得存在更深的可渲染瓦片（粗祖先应被标记覆盖 → dw=false）
      const covering = renderable.filter(
        (f) =>
          f.z > c.z &&
          f.b.west >= c.b.west &&
          f.b.east <= c.b.east &&
          f.b.south >= c.b.south &&
          f.b.north <= c.b.north,
      );
      if (covering.length) {
        violations.push({
          coarse: `${c.key} (z${c.z})`,
          deepest: Math.max(...covering.map((f) => f.z)),
          count: covering.length,
        });
      }
    }
  }

  const zoomHist = {};
  for (const t of renderable) zoomHist[`z${t.z}`] = (zoomHist[`z${t.z}`] ?? 0) + 1;

  return {
    camH: Math.round(L.currentCamera.position.length()),
    targetZoom,
    visSize: L.currentVisibleKeys.size,
    maxTiles: L.maxTilesPerView,
    stackDepth,
    zoomHist,
    dwTrueCoarse: dwTrueCoarse.map((t) => `${t.key}(z${t.z})`).slice(0, 12),
    dwTrueCoarseTotal: dwTrueCoarse.length,
    violations: violations.slice(0, 10),
    violationTotal: violations.length,
  };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  console.log(`URL: ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page))) {
    await browser.close();
    process.exit(2);
  }

  // 阶段 1：18km 高空，等底图毯（z5~z9）加载完成
  await sleep(14000);
  const s1 = await page.evaluate(checkInvariants);
  console.log(`\n===== 阶段1 高空底图毯 =====`);
  if (s1.err) console.log("ERR:", s1.err);
  else {
    console.log(`相机高度=${s1.camH}m 可见集=${s1.visSize}/${s1.maxTiles} 层级分布=${JSON.stringify(s1.zoomHist)}`);
    console.log(`dw=true 的粗瓦片: ${s1.dwTrueCoarseTotal} 块 ${JSON.stringify(s1.dwTrueCoarse)}`);
  }

  // 阶段 2：快速拉近到数百米，造出深层级差（底图毯仍在缓存/场景里）
  const cx = 640;
  const cy = 430;
  for (let i = 0; i < 34; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(240);
  }
  await sleep(15000);
  const s2 = await page.evaluate(checkInvariants);
  console.log(`\n===== 阶段2 拉近后（深层级差） =====`);
  if (s2.err) console.log("ERR:", s2.err);
  else {
    console.log(
      `相机高度=${s2.camH}m targetZoom=z${s2.targetZoom} 可见集=${s2.visSize}/${s2.maxTiles} 层级分布=${JSON.stringify(s2.zoomHist)}`,
    );
    console.log(`最大层级差（最细正选 − 最粗上屏）=${s2.stackDepth} 级`);
    console.log(`dw=true 的粗瓦片=${s2.dwTrueCoarseTotal} 块 ${JSON.stringify(s2.dwTrueCoarse)}`);
    console.log(
      `不变量违规（dw=true 却有更深的可渲染后代）=${s2.violationTotal} 块`,
    );
    for (const v of s2.violations)
      console.log(`   ✗ ${v.coarse} 范围内存在 ${v.count} 块最深 z${v.deepest} 的可渲染瓦片`);
  }
  await page.screenshot({ path: path.join(OUT_DIR, "aw-1-拉近.png") });
  console.log("截图 → artifacts/aw-1-拉近.png");

  const failed = s2.err || s2.violationTotal > 0;
  console.log(`\n结论: ${failed ? "FAIL —— 存在未被标记覆盖、仍写深度的粗祖先" : "PASS —— 祖先回溯覆盖完整"}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

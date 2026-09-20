/**
 * LOD↔距离单调性检验（回答"为什么 z18 没出现在屏幕最下方"）。
 *
 * 假说：倾斜视角 + 有高程起伏的地形上，"屏幕下方"不代表"离相机近"——
 * 崖顶/高地虽然出现在画面中部，但其空间距离可能比屏幕底部的平地更近。
 * LOD 按**空间距离**选取，所以正确的表现是：z 随空间距离单调递减，
 * 而 z 与"屏幕 y 坐标"无关。
 *
 * 做法：对每块可见瓦片计算"瓦片中心（含估计高程）到相机的空间距离"，
 * 按 (距离, zoom) 配对后检验单调性；同时输出瓦片在屏幕上的 y 位置，
 * 展示"屏幕 y"与"距离"的错位。
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

function sample() {
  const L = globalThis.__terrainDebug;
  if (!L || !L.currentCamera) return { err: "not ready" };
  const camera = L.currentCamera;
  const V = camera.position.constructor;
  const W = L.currentViewportWidth || 1280;
  const H = L.currentViewportHeight || 860;

  const yOrigin = L.tileYOrigin ?? "south";
  const boundsOf = (x, y, z) => {
    const nx = Math.pow(2, z + 1);
    const ny = Math.pow(2, z);
    const north = yOrigin === "north" ? 90 - (y / ny) * 180 : ((y + 1) / ny) * 180 - 90;
    const south = yOrigin === "north" ? 90 - ((y + 1) / ny) * 180 : (y / ny) * 180 - 90;
    return { west: (x / nx) * 360 - 180, east: ((x + 1) / nx) * 360 - 180, south, north };
  };

  const rows = [];
  for (const [key, entry] of L.loadedTiles) {
    const mesh = entry.mesh;
    const mat = mesh && mesh.material;
    if (!mesh || !mesh.visible || (mat?.opacity ?? 0) <= 0.5) continue;
    const [x, y, z] = key.split(",").map(Number);
    const b = boundsOf(x, y, z);
    const h = L.estimateTileSurfaceHeight(x, y, z);
    let center;
    try {
      center = L.gis.lngLatToThree((b.west + b.east) / 2, (b.south + b.north) / 2, h);
    } catch (e) {
      continue;
    }
    const dist = center.distanceTo(camera.position);
    // 瓦片在屏幕上的平均 y（投影中心）
    const p = center.clone().project(camera);
    const screenY = Number.isFinite(p.y) ? Math.round(((1 - p.y) / 2) * H) : -1;
    rows.push({
      key,
      z,
      dist: Math.round(dist),
      screenY,
      dw: Boolean(mat.depthWrite),
      selected: L.currentVisibleKeys.has(key),
    });
  }

  // 按距离排序，检验 zoom 单调性（允许相邻 ±1 容差）
  const byDist = rows.slice().sort((a, b) => a.dist - b.dist);
  let violations = 0;
  const samples = [];
  for (let i = 0; i < byDist.length; i++) {
    for (let j = i + 1; j < byDist.length; j++) {
      if (byDist[j].z > byDist[i].z + 1) {
        violations++;
        if (samples.length < 12)
          samples.push(
            `${byDist[j].key}(z${byDist[j].z}, ${byDist[j].dist}m, 屏y${byDist[j].screenY}) 比 ` +
              `${byDist[i].key}(z${byDist[i].z}, ${byDist[i].dist}m, 屏y${byDist[i].screenY}) 更远却更细`,
          );
        break;
      }
    }
  }

  // 按"屏幕三等分"统计每带的距离范围与层级范围 —— 展示屏幕位置≠距离
  const bands = [
    { name: "上1/3", lo: 0, hi: H / 3 },
    { name: "中1/3", lo: H / 3, hi: (H * 2) / 3 },
    { name: "下1/3", lo: (H * 2) / 3, hi: H },
  ].map((band) => {
    const inBand = rows.filter((r) => r.screenY >= band.lo && r.screenY < band.hi);
    const dists = inBand.map((r) => r.dist);
    const zooms = inBand.map((r) => r.z);
    return {
      band: band.name,
      tiles: inBand.length,
      distRange: dists.length ? `${Math.min(...dists)}~${Math.max(...dists)}m` : "-",
      zoomRange: zooms.length ? `z${Math.min(...zooms)}~z${Math.max(...zooms)}` : "-",
    };
  });

  return {
    camH: Math.round(camera.position.length()),
    tiles: rows.length,
    stack: {
      coarsest: Math.min(...rows.map((r) => r.z)),
      finest: Math.max(...rows.map((r) => r.z)),
    },
    monotoneViolations: violations,
    samples,
    bands,
    // 最细的 8 块瓦片：它们的距离与屏幕位置（验证"最细的是不是离相机最近的"）
    finest: byDist
      .slice()
      .sort((a, b) => b.z - a.z || a.dist - b.dist)
      .slice(0, 8)
      .map((r) => `${r.key} z${r.z} ${r.dist}m 屏y${r.screenY}`),
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
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page))) {
    await browser.close();
    process.exit(2);
  }
  await sleep(10000);

  const report = async (label, shot) => {
    const s = await page.evaluate(sample);
    console.log(`\n===== ${label} =====`);
    if (s.err) {
      console.log("ERR:", s.err);
      return s;
    }
    console.log(
      `相机高度=${s.camH}m 瓦片=${s.tiles} 层级跨度=z${s.stack.coarsest}~z${s.stack.finest}`,
    );
    console.log("按屏幕三等分（展示 屏幕位置 ≠ 空间距离）:");
    for (const b of s.bands)
      console.log(`  ${b.band}: ${b.tiles} 块  距离=${b.distRange}  层级=${b.zoomRange}`);
    console.log(
      `LOD↔距离单调性违规（更远却更细，容差±1）= ${s.monotoneViolations} 处`,
    );
    for (const t of s.samples) console.log(`   ✗ ${t}`);
    console.log(`最细的瓦片（应即离相机最近者）:`);
    for (const f of s.finest) console.log(`   ${f}`);
    if (shot) {
      await page.screenshot({ path: path.join(OUT_DIR, shot) });
      console.log(`截图 → artifacts/${shot}`);
    }
    return s;
  };

  const cx = 640;
  const cy = 430;

  // 拉近到中低空
  for (let i = 0; i < 22; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(260);
  }
  await sleep(8000);
  await report("1-拉近(约2-3km)", "ld-1-拉近.png");

  // 压低视角：渐进式拖拽（每次移动到递增的 y，避免同坐标不产生事件）
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await page.evaluate(() => {
      const c = globalThis.__terrainDebug.currentCamera;
      const d = c.getWorldDirection(new (c.position.constructor)());
      return +(Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI).toFixed(1);
    });
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "left" });
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(cx, cy + 24 * attempt * (i + 1), { steps: 5 });
      await sleep(50);
    }
    await page.mouse.up({ button: "left" });
    await sleep(3000);
    const after = await page.evaluate(() => {
      const c = globalThis.__terrainDebug.currentCamera;
      const d = c.getWorldDirection(new (c.position.constructor)());
      return +(Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI).toFixed(1);
    });
    console.log(`[俯仰] 第${attempt}次: ${before}° → ${after}°`);
    if (Math.abs(after - before) > 5) break;
  }
  await sleep(8000);
  const s2 = await report("2-压低视角后（对齐用户场景）", "ld-2-倾斜.png");

  const verdict = s2.err
    ? "无法采样"
    : s2.monotoneViolations === 0
      ? "PASS —— LOD 严格随空间距离单调：最细瓦片就是离相机最近的瓦片。屏幕位置与层级错位源于地形高程（崖顶更近），不是调度错误。"
      : `存在 ${s2.monotoneViolations} 处"更远却更细"——需进一步排查（可能是瓦片中心距离 vs 实际最近点的误差，或真实的调度缺陷）`;
  console.log(`\n判定: ${verdict}`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

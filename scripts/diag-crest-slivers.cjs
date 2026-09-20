/**
 * 山脊碎色块归因探针（需在 ?debugColors=1 下运行）。
 *
 * 目的：回答"屏幕上那些更粗层级的碎色块到底是谁的问题"。
 * 做法：对屏幕做网格采样，对每个采样点用**瓦片真实网格顶点**（而不是包围盒）
 * 投影出屏幕凸包，判断该点被哪些瓦片覆盖；然后比较：
 *   P = 覆盖该点的最细"已加载且可见"瓦片（= 实际绘制者）
 *   S = 覆盖该点的最细"正选"瓦片（= 理论上应该绘制者）
 *
 * 归因分类：
 *   normal     P.zoom == S.zoom                      —— 正常
 *   geom       P.zoom <  S.zoom 且 S 已加载           —— 精细正选瓦片就绪且网格覆盖该点却没画 → 几何弦越界/遮挡
 *   loading    P.zoom <  S.zoom 且 S 未加载           —— 精细正选瓦片还在路上（瞬态）
 *   unselected 该点没有任何正选瓦片覆盖，只有非正选瓦片在画 —— 正选缺失
 *   hole       没有任何已加载瓦片覆盖                  —— 空洞
 *   finer      P.zoom >  S.zoom                      —— 更细的非正选瓦片在画（异常）
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

/** 页面内采样：真实网格顶点投影 → 凸包 → 逐点归因 */
function analyze() {
  const L = globalThis.__terrainDebug;
  if (!L || !L.currentCamera) return { err: "not ready" };
  const camera = L.currentCamera;
  const V = camera.position.constructor;
  const W = L.currentViewportWidth || 1280;
  const H = L.currentViewportHeight || 860;

  const numX = (z) => Math.pow(2, z + 1);
  const numY = (z) => Math.pow(2, z);
  const yOrigin = L.tileYOrigin ?? "south";
  const boundsOf = (x, y, z) => {
    const nx = numX(z);
    const ny = numY(z);
    const north = yOrigin === "north" ? 90 - (y / ny) * 180 : ((y + 1) / ny) * 180 - 90;
    const south = yOrigin === "north" ? 90 - ((y + 1) / ny) * 180 : (y / ny) * 180 - 90;
    return { west: (x / nx) * 360 - 180, east: ((x + 1) / nx) * 360 - 180, south, north };
  };

  const toScreen = (v) => {
    const p = v.clone().project(camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.z < -1 || p.z > 1) return null;
    return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H };
  };

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const hullOf = (pts) => {
    if (pts.length < 3) return pts.slice();
    const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const lower = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  };
  const insideConvex = (hull, px, py) => {
    if (hull.length < 3) return false;
    let neg = 0;
    let pos = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      const c = cross(a, b, { x: px, y: py });
      if (c < 0) neg++;
      else if (c > 0) pos++;
      if (neg > 0 && pos > 0) return false;
    }
    return true;
  };

  /** 凸包 + 包围盒 */
  const finish = (key, x, y, z, selected, loaded, pts, extra) => {
    if (pts.length < 3) return null;
    const hull = hullOf(pts);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { key, x, y, z, selected, loaded, hull, minX, maxX, minY, maxY, ...extra };
  };

  const footprints = [];
  const visibleNotSelected = new Map(); // zoom -> count

  // 1) 已加载且可见的瓦片：用真实网格顶点投影（= 真实绘制足迹）
  for (const [key, entry] of L.loadedTiles) {
    const mesh = entry.mesh;
    const mat = mesh && mesh.material;
    if (!mesh || !mesh.visible) continue;
    if ((mat?.opacity ?? 0) <= 0.5) continue;
    const parts = key.split(",");
    const x = +parts[0];
    const y = +parts[1];
    const z = +parts[2];
    const pos = mesh.geometry?.attributes?.position;
    if (!pos || pos.count < 3) continue;
    mesh.updateWorldMatrix(true, false);
    const step = Math.max(1, Math.floor(pos.count / 64));
    const pts = [];
    const v = new V();
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const s = toScreen(v);
      if (s) pts.push(s);
    }
    const selected = L.currentVisibleKeys.has(key);
    if (!selected) visibleNotSelected.set(z, (visibleNotSelected.get(z) ?? 0) + 1);
    const rec = finish(key, x, y, z, selected, true, pts, {
      depthWrite: Boolean(mat.depthWrite),
      opacity: +(mat.opacity ?? 1).toFixed(2),
      renderOrder: mesh.renderOrder ?? 0,
      color: mat.color ? mat.color.getHexString() : "?",
    });
    if (rec) footprints.push(rec);
  }

  // 2) 已正选但未加载：用估计高程的五点近似（判断"精细瓦片在路上"用）
  let selectedNotLoaded = 0;
  for (const key of L.currentVisibleKeys) {
    if (L.loadedTiles.has(key)) continue;
    selectedNotLoaded++;
    const parts = key.split(",");
    const x = +parts[0];
    const y = +parts[1];
    const z = +parts[2];
    const b = boundsOf(x, y, z);
    const h = L.estimateTileSurfaceHeight(x, y, z);
    const pts = [];
    const probes = [
      [(b.west + b.east) / 2, (b.south + b.north) / 2],
      [b.west, b.north],
      [b.east, b.north],
      [b.east, b.south],
      [b.west, b.south],
    ];
    for (const [lng, lat] of probes) {
      try {
        const s = toScreen(L.gis.lngLatToThree(lng, lat, h));
        if (s) pts.push(s);
      } catch (e) {
        /* 投影失败忽略 */
      }
    }
    const rec = finish(key, x, y, z, true, false, pts, { depthWrite: false, opacity: 0, renderOrder: -1, color: "?" });
    if (rec) footprints.push(rec);
  }

  // 3) 网格采样归因
  const STEP = 16;
  const cls = { normal: 0, geom: 0, loading: 0, unselected: 0, hole: 0, finer: 0 };
  const painterHist = new Map();
  const samples = [];
  const sliver = [];
  const yBand = { top: 0, mid: 0, bottom: 0 };
  for (let py = STEP / 2; py < H; py += STEP) {
    for (let px = STEP / 2; px < W; px += STEP) {
      let P = null;
      let S = null;
      for (const f of footprints) {
        if (px < f.minX || px > f.maxX || py < f.minY || py > f.maxY) continue;
        if (!insideConvex(f.hull, px, py)) continue;
        if (f.loaded && (!P || f.z > P.z)) P = f;
        if (f.selected && (!S || f.z > S.z)) S = f;
      }
      if (!P) {
        cls.hole++;
        continue;
      }
      painterHist.set(P.z, (painterHist.get(P.z) ?? 0) + 1);
      let kind;
      if (!S) kind = "unselected";
      else if (P.z === S.z) kind = "normal";
      else if (P.z < S.z) kind = S.loaded ? "geom" : "loading";
      else kind = "finer";
      cls[kind]++;
      if (kind !== "normal") {
        const rel = py / H;
        if (rel < 0.33) yBand.top++;
        else if (rel < 0.66) yBand.mid++;
        else yBand.bottom++;
        const row = {
          px: Math.round(px),
          py: Math.round(py),
          kind,
          painter: `${P.key} z${P.z}${P.depthWrite ? " dw=1" : " dw=0"}`,
          expect: S ? `${S.key} z${S.z}${S.loaded ? "" : "(未加载)"}` : "(无正选覆盖)",
        };
        if (kind === "geom" && sliver.length < 40) sliver.push(row);
        if (samples.length < 20) samples.push(row);
      }
    }
  }

  const zoomHist = {};
  for (const [z, n] of [...painterHist.entries()].sort((a, b) => a[0] - b[0])) zoomHist[`z${z}`] = n;
  const visNotSel = {};
  for (const [z, n] of [...visibleNotSelected.entries()].sort((a, b) => a[0] - b[0])) visNotSel[`z${z}`] = n;

  return {
    camH: Math.round(camera.position.length()),
    viewport: `${W}x${H}`,
    visSize: L.currentVisibleKeys.size,
    maxTiles: L.maxTilesPerView,
    visibleNotSelected: visNotSel,
    visibleNotSelectedTotal: [...visibleNotSelected.values()].reduce((a, b) => a + b, 0),
    selectedNotLoaded,
    painterHist: zoomHist,
    classes: cls,
    yBand,
    sampleCount: Math.round((W / STEP) * (H / STEP)),
    sliver: sliver.slice(0, 12),
    samples,
    landmark: (() => {
      // 地形最高点：用于判断碎片是否集中在山脊剪影
      let max = 0;
      for (const f of footprints) if (f.loaded && f.opacity > 0) max = Math.max(max, f.z);
      return { finestPainterZoom: max };
    })(),
  };
}

async function dump(page, label, shotName) {
  const s = await page.evaluate(analyze);
  console.log(`\n===== ${label} =====`);
  if (s.err) {
    console.log("ERR:", s.err);
    return s;
  }
  const c = s.classes;
  console.log(
    `相机高度=${s.camH}m 视口=${s.viewport} 可见集=${s.visSize}/${s.maxTiles} 正选未加载=${s.selectedNotLoaded}`,
  );
  console.log(`上屏但非正选瓦片=${s.visibleNotSelectedTotal} 分布=${JSON.stringify(s.visibleNotSelected)}`);
  console.log(`实际绘制者层级分布=${JSON.stringify(s.painterHist)}`);
  console.log(
    `归因（共 ${s.sampleCount} 采样点）: 正常=${c.normal} 几何弦越界=${c.geom} 加载中=${c.loading} 无正选覆盖=${c.unselected} 空洞=${c.hole} 更细非正选=${c.finer}`,
  );
  console.log(`非正常点屏幕分布: 上1/3=${s.yBand.top} 中1/3=${s.yBand.mid} 下1/3=${s.yBand.bottom}`);
  if (s.sliver.length) {
    console.log("几何弦越界样本（绘制者 vs 应有绘制者）:");
    for (const r of s.sliver)
      console.log(`   (${r.px},${r.py}) 实画 ${r.painter} | 应有 ${r.expect}`);
  }
  if (s.samples.length) {
    console.log("分类样本:");
    for (const r of s.samples.slice(0, 8))
      console.log(`   (${r.px},${r.py}) [${r.kind}] 实画 ${r.painter} | 应有 ${r.expect}`);
  }
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
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
  console.log(`URL: ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page))) {
    await browser.close();
    process.exit(2);
  }
  await sleep(10000);

  const cx = 640;
  const cy = 430;

  /** 相机姿态（高度 + 俯仰角），用于确认手势是否真的生效 */
  const pose = async () =>
    page.evaluate(() => {
      const L = globalThis.__terrainDebug;
      if (!L || !L.currentCamera) return null;
      const c = L.currentCamera;
      const d = c.getWorldDirection(c.position.constructor ? new (c.position.constructor)() : undefined);
      return {
        alt: Math.round(c.position.length()),
        pitch: +(Math.asin(Math.max(-1, Math.min(1, d.y))) * 180 / Math.PI).toFixed(1),
      };
    });

  const tilt = async (delta, steps) => {
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "left" });
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(cx, cy + delta, { steps: 6 });
      await sleep(60);
    }
    await page.mouse.up({ button: "left" });
  };

  // 拉近到低空（对齐用户截图：能同时看到近景 z18 与远景地平线）
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(260);
  }
  await sleep(8000);
  const p1 = await pose();
  console.log(`\n[姿态] 拉近后 高度=${p1?.alt}m 俯仰=${p1?.pitch}°`);
  await dump(page, "1-拉近", "cs-1-拉近.png");

  // 压低视角（左键向下拖）→ 视锥变斜，看向地平线；若一次不够就再来一次
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await pose();
    await tilt(28 * attempt, 8);
    await sleep(3000);
    const after = await pose();
    console.log(
      `[姿态] 压低第${attempt}次: ${before?.pitch}° → ${after?.pitch}°（高度 ${after?.alt}m）`,
    );
    if (before && after && Math.abs(after.pitch - before.pitch) > 3) break;
  }
  await sleep(9000);
  const s2 = await dump(page, "2-压低视角", "cs-2-压低视角.png");

  // 转动两轮（复现用户"视角转动"路径）
  for (let r = 1; r <= 2; r++) {
    const dir = r % 2 === 1 ? 1 : -1;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "left" });
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(cx + dir * 90, cy, { steps: 4 });
      await sleep(80);
    }
    await page.mouse.up({ button: "left" });
    await sleep(3000);
    await dump(page, `3-转动第${r}轮（松手后3s）`, `cs-3-转动${r}.png`);
  }
  await sleep(6000);
  await dump(page, "4-静置", "cs-4-静置.png");

  console.log("\n判定口径：");
  console.log("  几何弦越界占比小、且集中在山脊剪影 → 粗网格简化固有误差（可接受，影像模式表现为剪影细糊边）");
  console.log("  无正选覆盖/空洞占比大 → 选择管线漏瓦片（需修）");
  console.log("  加载中占比大且静置后不降 → 请求卡住（需修）");
  console.log(`  （本次压低视角时最小正选层级参考：${s2.landmark ? s2.landmark.finestPainterZoom : "-"}）`);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

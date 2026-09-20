/**
 * 遍历复刻探针：在页面内重放 collectQuadtreeTerrainTiles 的判定链，
 * 记录每个被剪枝节点的剪枝原因（AABB / 视锥 / 未细分叶子 / 预算），
 * 对"视锥=0"的节点用逐角 NDC 投影量化其实际在屏比例 —— 直接验证
 * 用户假设："瓦片部分与视角相交但中心点在视角外 → 被判定不加载"。
 * 运行：node scripts/diag-pan-visit.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12345";
const URL = process.env.REPRO_URL ?? `http://localhost:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function traceTraversal() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const camera = layer.currentCamera;
    const W = layer.currentViewportWidth, H = layer.currentViewportHeight;
    const vB = layer.currentViewLngBounds, vBt = layer.currentViewLatBounds;
    if (!vB || !vBt) return { err: "no view bounds" };
    const numX = (z) => Math.pow(2, z + 1), numY = (z) => Math.pow(2, z);
    const yO = layer.tileYOrigin;
    const boundsOf = (x, y, z) => ({
      west: (x / numX(z)) * 360 - 180, east: ((x + 1) / numX(z)) * 360 - 180,
      south: yO === "south" ? (y / numY(z)) * 180 - 90 : 90 - ((y + 1) / numY(z)) * 180,
      north: yO === "south" ? ((y + 1) / numY(z)) * 180 - 90 : 90 - (y / numY(z)) * 180,
    });

    // 5×5 内部采样投影：返回 {onScreen, screenYMin, onFrac, zMin, zMax}
    // onScreen>0 且被剪枝 ⇒ 误剪铁证（子树整体未加载，屏幕该区域由粗祖先顶着）
    function interiorSample(b, h) {
      let on = 0, tot = 0, syMin = 1e9, zMin = 1e9, zMax = -1e9;
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4; j++) {
          const lng = b.west + ((b.east - b.west) * i) / 4;
          const lat = b.south + ((b.north - b.south) * j) / 4;
          const d = layer.gis.lngLatToThree(lng, lat, h).project(camera);
          zMin = Math.min(zMin, d.z); zMax = Math.max(zMax, d.z);
          if (d.z < -1 || d.z > 1) continue; // 近/远平面外（含相机背后的翻转值）
          tot++;
          if (d.x >= -1 && d.x <= 1 && d.y >= -1 && d.y <= 1) {
            on++;
            syMin = Math.min(syMin, ((1 - d.y) / 2) * H);
          }
        }
      }
      return { on, syMin: syMin > 1e8 ? null : Math.round(syMin), zMin: +zMin.toFixed(3), zMax: +zMax.toFixed(3) };
    }

    // ── 复刻遍历 ──
    const startZoom = layer.minZoom;
    const sw = { x: Math.floor(((vB[0] + 180) / 360) * numX(startZoom)), y: 0 };
    const ne = { x: Math.floor(((vB[1] + 180) / 360) * numX(startZoom)), y: 0 };
    const y2t = (lat) => yO === "south"
      ? Math.floor(((lat + 90) / 180) * numY(startZoom))
      : Math.floor(((90 - lat) / 180) * numY(startZoom));
    sw.y = y2t(vBt[0]); ne.y = y2t(vBt[1]);
    const stack = [];
    for (let x = Math.min(sw.x, ne.x); x <= Math.max(sw.x, ne.x); x++)
      for (let y = Math.min(sw.y, ne.y); y <= Math.max(sw.y, ne.y); y++)
        stack.push({ x, y, zoom: startZoom });

    const maxVisited = Math.max(layer.maxTilesPerView * 8, 1024);
    let visited = 0, selCount = 0, stoppedBy = "";
    const rejects = [];   // 剪枝记录
    const leaves = [];    // 选中叶子
    while (stack.length > 0) {
      if (visited >= maxVisited) { stoppedBy = "visitedBudget"; break; }
      if (selCount >= layer.maxTilesPerView) { stoppedBy = "maxTilesPerView"; break; }
      const tile = stack.pop();
      visited++;
      const b = boundsOf(tile.x, tile.y, tile.zoom);
      if (!layer.isGeographicBoundsInFrustum(b)) {
        const h = layer.estimateTileSurfaceHeight(tile.x, tile.y, tile.zoom);
        rejects.push({ key: `${tile.x},${tile.y},${tile.zoom}`, why: "视锥", cs: interiorSample(b, h) });
        continue;
      }
      const proj = layer.getTerrainTileProjection(tile.x, tile.y, tile.zoom, camera);
      const available = layer.isTileAvailable(tile.x, tile.y, tile.zoom);
      const cap = layer.terrainAvailability ? layer.terrainSubdivisionMaxZoom : layer.maxZoom;
      const canSub = tile.zoom < cap && (available || (layer.terrainVirtualSubdivision && layer.terrainAvailability !== null));
      const shouldSub = canSub && (proj.screenSpaceError > layer.maximumScreenSpaceError || proj.pixelSize > layer.terrainTilePixelSize * 2);
      if (shouldSub) {
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]])
          stack.push({ x: tile.x * 2 + ox, y: tile.y * 2 + oy, zoom: tile.zoom + 1 });
        continue;
      }
      selCount++;
      leaves.push({ key: `${tile.x},${tile.y},${tile.zoom}`, inVis: layer.currentVisibleKeys.has(`${tile.x},${tile.y},${tile.zoom}`) });
    }

    // 关注：被剪枝但内部采样落在屏幕上的瓦片 = 误剪铁证
    const falseCulls = rejects.filter((r) => r.cs && r.cs.on > 0)
      .sort((a, b) => (a.cs.syMin ?? 1e9) - (b.cs.syMin ?? 1e9));
    const zoomHist = {};
    for (const r of rejects) { const z = +r.key.split(",")[2]; zoomHist[z] = (zoomHist[z] || 0) + 1; }
    return {
      visited, selCount, stoppedBy: stoppedBy || "-",
      visKeysActual: layer.currentVisibleKeys.size,
      rejectTotal: rejects.length,
      zoomHist,
      falseCullCount: falseCulls.length,
      falseCulls: falseCulls.slice(0, 14),
      falseByWhy: falseCulls.reduce((m, r) => { m[r.why] = (m[r.why] || 0) + 1; return m; }, {}),
      leafMismatch: leaves.filter((l) => !l.inVis).length,
    };
  } catch (e) { return { err: String((e && e.message) || e) }; }
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => document.querySelectorAll("canvas").length) > 0) break;
    await sleep(1000);
  }
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(() => !!globalThis.__terrainDebug?.currentCamera)) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready) { console.error("图层未就绪"); await browser.close(); process.exit(2); }
  await sleep(12000);
  const box = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;

  const dump = (label, s) => {
    if (s.err) { console.log(`\n== ${label} == ${s.err}`); return; }
    console.log(`\n== ${label} == visited=${s.visited} 选中=${s.selCount} 实际可见集=${s.visKeysActual} 剪枝=${s.rejectTotal} 停止=${s.stoppedBy} 叶子不匹配=${s.leafMismatch}`);
    console.log(`   剪枝zoom分布=${JSON.stringify(s.zoomHist)}`);
    console.log(`   ★误剪(被剪但内部采样在屏): ${s.falseCullCount} 块 ${JSON.stringify(s.falseByWhy || {})}`);
    for (const r of s.falseCulls)
      console.log(`     ${r.key.padEnd(16)} [${r.why}] 在屏采样点=${r.cs.on}/25 屏幕顶部y=${r.cs.syMin} z范围=[${r.cs.zMin},${r.cs.zMax}]`);
  };
  const probe = (label) => page.evaluate(traceTraversal).then((s) => dump(label, s));

  await probe("初始");
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(10000);
  await probe("拉近后");

  // 朝相机平移：拖动中 + 拖动后各采样一次
  for (let round = 1; round <= 2; round++) {
    await page.mouse.move(cx, box.y + box.h * 0.35);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 30; i++) { await page.mouse.move(cx, box.y + box.h * 0.35 + (box.h * 0.7 * i) / 60); await sleep(25); }
    await probe(`第${round}轮拖动中`);
    for (let i = 31; i <= 60; i++) { await page.mouse.move(cx, box.y + box.h * 0.35 + (box.h * 0.7 * i) / 60); await sleep(25); }
    await page.mouse.up({ button: "right" });
    await sleep(5000);
    await probe(`第${round}轮拖动后`);
    await page.screenshot({ path: path.join(process.cwd(), "artifacts", `visit-r${round}.png`) });
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

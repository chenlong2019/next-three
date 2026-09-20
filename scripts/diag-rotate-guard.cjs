/**
 * rotate 场景下护栏归因探针。
 * 复现 benchmark rotate 流程后静置，然后：
 *  1) 列出可见集中"本应细分却被护栏拦下"的瓦片
 *  2) 对右下象限逐点找绘制者，统计糊区由哪些瓦片顶着
 */
const path = require("path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
  await page.goto("http://localhost:12345/examples/cesium-terrain/fullscreen/", {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  for (let i = 0; i < 90; i++) {
    const ok = await page.evaluate(
      () =>
        Boolean(
          globalThis.__terrainDebug &&
            globalThis.__terrainDebug.currentCamera &&
            globalThis.__terrainDebug.currentVisibleKeys.size > 0,
        ),
    );
    if (ok) break;
    await sleep(1000);
  }
  await sleep(3000);

  const cx = 640;
  const cy = 430;
  // zoomIn x13
  for (let i = 0; i < 13; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(250);
  }
  // tilt x6 (dy=-50)
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(cx, cy - 50, { steps: 4 });
    await sleep(60);
  }
  await page.mouse.up({ button: "left" });
  await sleep(2000);
  // rotate x4 (dx=60, 交替)
  for (let r = 1; r <= 4; r++) {
    const dir = r % 2 === 1 ? 1 : -1;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "left" });
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(cx + dir * 60, cy, { steps: 4 });
      await sleep(70);
    }
    await page.mouse.up({ button: "left" });
    await sleep(2000);
  }
  await sleep(12000);

  const report = await page.evaluate(() => {
    const L = globalThis.__terrainDebug;
    const cam = L && L.currentCamera;
    if (!cam) return { err: "camera null" };
    const V = cam.position.constructor;
    const W = L.currentViewportWidth;
    const H = L.currentViewportHeight;

    // 可见瓦片逐个判据
    const vis = [];
    for (const key of L.currentVisibleKeys) {
      const [x, y, z] = key.split(",").map(Number);
      const p = L.getTerrainTileProjection(x, y, z, cam);
      const guardPass = p.containsCamera || !p.reliable || p.visiblePixelSize > 256;
      const wantSub = p.screenSpaceError > 2 || p.pixelSize > 512;
      const entry = L.loadedTiles.get(key);
      // 上屏足迹
      let foot = "?";
      if (entry && entry.mesh && entry.mesh.visible) {
        const pos = entry.mesh.geometry?.attributes?.position;
        if (pos && pos.count >= 3) {
          entry.mesh.updateWorldMatrix(true, false);
          const step = Math.max(1, Math.floor(pos.count / 96));
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          const v = new V();
          for (let i = 0; i < pos.count; i += step) {
            v.fromBufferAttribute(pos, i).applyMatrix4(entry.mesh.matrixWorld);
            const pr = v.clone().project(cam);
            if (!Number.isFinite(pr.x) || !Number.isFinite(pr.y) || pr.z < -1 || pr.z > 1) continue;
            const sx = Math.min(Math.max((pr.x + 1) / 2, 0), 1) * W;
            const sy = Math.min(Math.max((1 - pr.y) / 2, 0), 1) * H;
            if (sx < minX) minX = sx;
            if (sx > maxX) maxX = sx;
            if (sy < minY) minY = sy;
            if (sy > maxY) maxY = sy;
          }
          if (Number.isFinite(minX)) foot = `${Math.round(maxX - minX)}x${Math.round(maxY - minY)}`;
        }
      }
      vis.push({
        key, z,
        px: Math.round(p.pixelSize), vispx: Math.round(p.visiblePixelSize),
        sse: +p.screenSpaceError.toFixed(1),
        inCam: p.containsCamera, rel: p.reliable,
        guard: guardPass ? "pass" : "BLOCK",
        wantSub, loaded: Boolean(entry),
        availSelf: L.isTileAvailable(x, y, z),
        availChild: L.isTileAvailable(x * 2, y * 2, z + 1),
        foot,
      });
    }
    vis.sort((a, b) => a.z - b.z);
    const blocked = vis.filter((t) => t.wantSub && t.guard === "BLOCK");

    // 右下象限绘制者统计
    const STEP = 24;
    const painters = new Map();
    for (let py = 430; py < H; py += STEP) {
      for (let px2 = 640; px2 < W; px2 += STEP) {
        let best = null;
        for (const [key, entry] of L.loadedTiles) {
          const mesh = entry.mesh;
          if (!mesh || !mesh.visible || (mesh.material?.opacity ?? 1) <= 0.5) continue;
          const pos = mesh.geometry?.attributes?.position;
          if (!pos || pos.count < 3) continue;
          mesh.updateWorldMatrix(true, false);
          const step = Math.max(1, Math.floor(pos.count / 48));
          const pts = [];
          const v = new V();
          for (let i = 0; i < pos.count; i += step) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            const pr = v.clone().project(cam);
            if (!Number.isFinite(pr.x) || !Number.isFinite(pr.y) || pr.z < -1 || pr.z > 1) continue;
            pts.push([Math.min(Math.max((pr.x + 1) / 2, 0), 1) * W, Math.min(Math.max((1 - pr.y) / 2, 0), 1) * H]);
          }
          // 包围盒近似
          let hit = false;
          for (const [sx, sy] of pts) {
            if (Math.abs(sx - px2) < 3 && Math.abs(sy - py) < 3) { hit = true; break; }
          }
          // 粗略：点在网格采样点的包围盒内即算（避免凸包计算，够用）
          if (!hit) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const [sx, sy] of pts) {
              if (sx < minX) minX = sx;
              if (sx > maxX) maxX = sx;
              if (sy < minY) minY = sy;
              if (sy > maxY) maxY = sy;
            }
            hit = px2 >= minX && px2 <= maxX && py >= minY && py <= maxY;
          }
          if (hit) {
            const z = +key.slice(key.lastIndexOf(",") + 1);
            if (!best || z > best.z) best = { key, z };
          }
        }
        if (best) painters.set(best.key, (painters.get(best.key) ?? 0) + 1);
      }
    }

    return {
      camH: Math.round(cam.position.length()),
      visCount: L.currentVisibleKeys.size,
      loadedCount: L.loadedTiles.size,
      pending: L.pending ? L.pending.length : -1,
      loading: L.loading ? L.loading.size : -1,
      traversal: JSON.stringify(L.traversalDebug),
      subdivisionMax: L.terrainSubdivisionMaxZoom,
      virtualSub: L.terrainVirtualSubdivision,
      hasAvail: Boolean(L.terrainAvailability),
      maxTiles: L.maxTilesPerView,
      blockedByGuard: blocked,
      visibleList: vis,
      quadrantPainters: [...painters.entries()]
        .map(([k, n]) => ({ key: k, z: +k.slice(k.lastIndexOf(",") + 1), samples: n }))
        .sort((a, b) => a.z - b.z),
    };
  });

  if (report.err) {
    console.log("ERR:", report.err);
  } else {
    console.log(`相机高度=${report.camH}m 可见集=${report.visCount} 已加载=${report.loadedCount} 队列=${report.pending}+${report.loading} 遍历=${report.traversal}`);
    console.log(`\n被护栏拦下的瓦片（应细分却 BLOCK）：${report.blockedByGuard.length}`);
    console.log(`subdivisionMax=${report.subdivisionMax} virtual=${report.virtualSub} avail=${report.hasAvail} maxTiles=${report.maxTiles}`);
    for (const t of report.blockedByGuard)
      console.log(`   ${t.key}: px=${t.px} vis=${t.vispx} sse=${t.sse} inCam=${t.inCam} rel=${t.rel} avail=${t.availSelf}/${t.availChild} loaded=${t.loaded} foot=${t.foot}`);
    console.log(`\n可见集判据明细：`);
    for (const t of report.visibleList)
      console.log(`   ${t.key}: px=${t.px} vis=${t.vispx} sse=${t.sse} inCam=${t.inCam} rel=${t.rel} guard=${t.guard} wantSub=${t.wantSub} avail=${t.availSelf}/${t.availChild} loaded=${t.loaded} foot=${t.foot}`);
    console.log(`\n右下象限绘制者（采样点数）：`);
    for (const p of report.quadrantPainters) console.log(`   ${p.key} z${p.z}: ${p.samples}`);
  }
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "guard-rotate-settle.png") });
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

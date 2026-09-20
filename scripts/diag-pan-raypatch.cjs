/**
 * 射线探测糊斑：屏幕网格逐点做 相机射线 vs 瓦片世界包围盒 slab 求交，
 * 找出每个采样点实际"赢像素"的瓦片（tMin 最小者）。
 * 对赢像素的粗瓦片，回查其子瓦片为何没有接管：
 *  - 子瓦片是否在 visibleKeys / loadedTiles / 是否可渲染
 *  - 子瓦片的投影判定（getTerrainTileProjection，运行时可调）
 *  - 子瓦片的视锥判定（isGeographicBoundsInFrustum）与视野 AABB 判定（isTileRegionInView）
 * 运行：node scripts/diag-pan-raypatch.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12345";
const URL = process.env.REPRO_URL ?? `http://localhost:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probePatch() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const camera = layer.currentCamera;
    const W = layer.currentViewportWidth, H = layer.currentViewportHeight;
    const e = camera.matrixWorld.elements;
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    // 相机基向量（世界系）
    const rx = e[0], ry = e[1], rz = e[2];
    const ux = e[4], uy = e[5], uz = e[6];
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const tanF = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = W / H;
    const maxObs = layer.maximumObservedSurfaceHeight ?? 0;

    // 收集所有可见瓦片的世界包围盒
    const boxes = [];
    for (const [key, entry] of layer.loadedTiles) {
      if (!entry.mesh?.visible) continue;
      const op = +(entry.mesh.material?.opacity ?? 0).toFixed(2);
      if (op <= 0.01) continue;
      entry.mesh.updateWorldMatrix(true, false);
      if (!entry.mesh.geometry.boundingBox) entry.mesh.geometry.computeBoundingBox();
      const b = entry.mesh.geometry.boundingBox;
      const m = entry.mesh.matrixWorld.elements;
      // AABB（引擎以 Z 向上；matrixWorld 假定为刚体平移/旋转，这里直接变换 8 角）
      const cs = [];
      for (let i = 0; i < 8; i++) {
        const lx = i & 1 ? b.max.x : b.min.x;
        const ly = i & 2 ? b.max.y : b.min.y;
        const lz = i & 4 ? b.max.z : b.min.z;
        cs.push(
          m[0] * lx + m[4] * ly + m[8] * lz + m[12],
          m[1] * lx + m[5] * ly + m[9] * lz + m[13],
          m[2] * lx + m[6] * ly + m[10] * lz + m[14],
        );
      }
      boxes.push({
        key,
        zoom: +key.split(",")[2],
        minX: Math.min(...cs.filter((_, i) => i % 3 === 0)),
        maxX: Math.max(...cs.filter((_, i) => i % 3 === 0)),
        minY: Math.min(...cs.filter((_, i) => i % 3 === 1)),
        maxY: Math.max(...cs.filter((_, i) => i % 3 === 1)),
        minZ: Math.min(...cs.filter((_, i) => i % 3 === 2)),
        maxZ: Math.max(...cs.filter((_, i) => i % 3 === 2)),
        op,
        dw: !!entry.mesh.material.depthWrite,
        img: entry.imageryZoom, ready: !!entry.imageryReady, pend: entry.pendingImageryZoom,
      });
    }

    // 屏幕网格射线 → 每点的赢家瓦片
    const NX = 16, NY = 9;
    const votes = new Map();
    for (let iy = 2; iy < NY - 1; iy++) {
      for (let ix = 0; ix < NX; ix++) {
        const ndcX = ((ix + 0.5) / NX) * 2 - 1;
        const ndcY = 1 - ((iy + 0.5) / NY) * 2;
        // 射线方向 = forward + ndcX*tan*aspect*right + ndcY*tan*up
        const dx = fx + ndcX * tanF * aspect * rx + ndcY * tanF * ux;
        const dy = fy + ndcX * tanF * aspect * ry + ndcY * tanF * uy;
        const dz = fz + ndcX * tanF * aspect * rz + ndcY * tanF * uz;
        let best = null;
        for (const b of boxes) {
          // slab 求交
          let t0 = 0, t1 = Infinity;
          for (const [o, d, mn, mx] of [
            [px, dx, b.minX, b.maxX], [py, dy, b.minY, b.maxY], [pz, dz, b.minZ, b.maxZ],
          ]) {
            if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) { t0 = Infinity; break; } continue; }
            let ta = (mn - o) / d, tb = (mx - o) / d;
            if (ta > tb) { const t = ta; ta = tb; tb = t; }
            t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
          }
          if (t0 === Infinity || t0 > t1 || t1 < 0) continue;
          const t = Math.max(t0, 0.001);
          if (!best || t < best.t) best = { t, b };
        }
        if (!best) continue;
        const k = best.b.key;
        if (!votes.has(k)) votes.set(k, { n: 0, b: best.b, tsum: 0 });
        votes.get(k).n++; votes.get(k).tsum += best.t;
      }
    }
    const winners = [...votes.values()].sort((a, b) => b.n - a.n).slice(0, 6);

    // 对票数前 3 的赢家（若为粗瓦片）回查子瓦片判定
    const report = [];
    for (const w of winners.slice(0, 3)) {
      const b = w.b;
      const [x, y, zoom] = b.key.split(",").map(Number);
      const kids = [];
      const cz = zoom + 1;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const kx = x * 2 + ox, ky = y * 2 + oy;
        const ckey = `${kx},${ky},${cz}`;
        const ce = layer.loadedTiles.get(ckey);
        const inVis = layer.currentVisibleKeys.has(ckey);
        // 运行时调用内部判定（TS private 仅编译期）
        let proj = null, inFrus = null, inAABB = null;
        try {
          const p2 = layer.getTerrainTileProjection(kx, ky, cz, camera);
          const W2 = Math.pow(2, cz + 1), N2 = Math.pow(2, cz);
          inFrus = layer.isGeographicBoundsInFrustum({
            west: (kx / W2) * 360 - 180,
            east: ((kx + 1) / W2) * 360 - 180,
            south: (ky / N2) * 180 - 90,
            north: ((ky + 1) / N2) * 180 - 90,
          });
          inAABB = layer.isTileRegionInView(kx, ky, cz);
          proj = {
            pixelSize: Math.round(p2.pixelSize),
            visiblePixelSize: Math.round(p2.visiblePixelSize),
            sse: +p2.screenSpaceError.toFixed(1),
            dist: Math.round(p2.distance),
          };
        } catch (er) { proj = { err: String(er && er.message || er) }; }
        kids.push({
          ckey, inVis,
          loaded: !!ce,
          op: ce ? +(ce.mesh.material?.opacity ?? 0).toFixed(2) : null,
          ready: ce ? !!ce.imageryReady : null,
          proj, inFrus, inAABB,
        });
      }
      report.push({
        key: b.key, zoom: b.zoom, votes: w.n,
        avgT: Math.round(w.tsum / w.n),
        op: b.op, dw: b.dw, img: b.img, ready: b.ready, pend: b.pend,
        kids,
      });
    }
    const s = layer.getCacheStats();
    const cam = layer.gis.threeToLngLat(camera.position);
    return {
      cam: { lng: +cam[0].toFixed(5), lat: +cam[1].toFixed(5), alt: Math.round(cam[2]) },
      maxObs: Math.round(maxObs),
      visibleTiles: boxes.length,
      stitch: `${s.stitchPending}+${s.stitchInFlight}`,
      winners: report,
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
    console.log(`\n== ${label} == 相机(${s.cam.lng},${s.cam.lat}) alt=${s.cam.alt}m maxObs=${s.maxObs}m 可见瓦片=${s.visibleTiles} stitch=${s.stitch}`);
    for (const w of s.winners) {
      console.log(`  赢家 ${w.key.padEnd(16)} 票=${w.votes} op=${w.op} DW=${w.dw ? 1 : 0} img=z${w.img}${w.ready ? "" : "(未就绪)"}${w.pend != null ? "->z" + w.pend : ""} 平均t=${w.avgT}`);
      for (const k of w.kids) {
        const p = k.proj && !k.proj.err
          ? `px=${k.proj.pixelSize} visPx=${k.proj.visiblePixelSize} sse=${k.proj.sse} dist=${k.proj.dist}`
          : `proj=${k.proj && k.proj.err ? k.proj.err : "?"}`;
        console.log(`    子 ${k.ckey.padEnd(16)} 可见集=${k.inVis ? 1 : 0} 已加载=${k.loaded ? 1 : 0}${k.op != null ? " op=" + k.op : ""}${k.ready === false ? " 未就绪" : ""}` +
          ` 视锥=${k.inFrus ? 1 : 0} AABB=${k.inAABB ? 1 : 0} ${p}`);
      }
    }
  };
  const probe = (label) => page.evaluate(probePatch).then((s) => dump(label, s));

  await probe("初始");
  // 1) 压低视角 + 拉近
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(10000);
  await probe("拉近后");

  // 2) 两轮"朝相机平移"（复现糊斑）
  for (let round = 1; round <= 2; round++) {
    for (let k = 0; k < 2; k++) {
      await page.mouse.move(cx, box.y + box.h * 0.35);
      await page.mouse.down({ button: "right" });
      for (let i = 1; i <= 60; i++) { await page.mouse.move(cx, box.y + box.h * 0.35 + (box.h * 0.7 * i) / 60); await sleep(25); }
      await page.mouse.up({ button: "right" });
      await sleep(1500);
    }
    await sleep(4000);
    await probe(`第${round}轮平移后`);
    await page.screenshot({ path: path.join(process.cwd(), "artifacts", `raypatch-r${round}.png`) });
  }
  await sleep(8000);
  await probe("最终(静置8s)");
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "raypatch-settled.png") });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

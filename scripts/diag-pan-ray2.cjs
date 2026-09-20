/**
 * 三角形级精确拾取：对屏幕上若干采样点做 Möller–Trumbore 射线-三角形求交，
 * 找出真正渲染该像素的瓦片（解决包围盒归因不可靠的问题）。
 * 对每个赢家：
 *  - 扫描 loadedTiles 里它 zoom+1..+6 的所有已加载后代（可见性/透明度/候场/影像状态）
 *  - 输出可见集规模与 zoom 分布
 * 运行：node scripts/diag-pan-ray2.cjs
 */
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const PORT = process.env.PORT ?? "12345";
const URL = process.env.REPRO_URL ?? `http://localhost:${PORT}/examples/cesium-terrain/fullscreen/`;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probeTri() {
  try {
    const layer = globalThis.__terrainDebug;
    if (!layer || !layer.currentCamera) return { err: "not ready" };
    const camera = layer.currentCamera;
    const W = layer.currentViewportWidth, H = layer.currentViewportHeight;
    const e = camera.matrixWorld.elements;
    const px = camera.position.x, py = camera.position.y, pz = camera.position.z;
    const rx = e[0], ry = e[1], rz = e[2];
    const ux = e[4], uy = e[5], uz = e[6];
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const tanF = Math.tan((camera.fov * Math.PI) / 360);
    const aspect = W / H;

    // 收集可见瓦片：世界包围盒 + 顶点数据引用
    const meshes = [];
    for (const [key, entry] of layer.loadedTiles) {
      if (!entry.mesh?.visible) continue;
      const op = +(entry.mesh.material?.opacity ?? 0).toFixed(2);
      if (op <= 0.01) continue;
      const g = entry.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const m = entry.mesh.matrixWorld.elements;
      const b = g.boundingBox;
      // 世界 AABB（变换 8 角；假定无投影变形，仿射）
      const csx = [], csy = [], csz = [];
      for (let i = 0; i < 8; i++) {
        const lx = i & 1 ? b.max.x : b.min.x;
        const ly = i & 2 ? b.max.y : b.min.y;
        const lz = i & 4 ? b.max.z : b.min.z;
        csx.push(m[0] * lx + m[4] * ly + m[8] * lz + m[12]);
        csy.push(m[1] * lx + m[5] * ly + m[9] * lz + m[13]);
        csz.push(m[2] * lx + m[6] * ly + m[10] * lz + m[14]);
      }
      const pos = g.attributes.position;
      const idx = g.index ? g.index.array : null;
      meshes.push({
        key, zoom: +key.split(",")[2], op,
        dw: !!entry.mesh.material.depthWrite,
        img: entry.imageryZoom, ready: !!entry.imageryReady,
        pend: entry.pendingImageryZoom,
        reveal: !!entry.revealPending,
        inVis: layer.currentVisibleKeys.has(key),
        box: { mn: [Math.min(...csx), Math.min(...csy), Math.min(...csz)], mx: [Math.max(...csx), Math.max(...csy), Math.max(...csz)] },
        pos, idx, m,
      });
    }

    // Möller–Trumbore（世界空间三角形）
    function pick(ndcX, ndcY) {
      const dx = fx + ndcX * tanF * aspect * rx + ndcY * tanF * ux;
      const dy = fy + ndcX * tanF * aspect * ry + ndcY * tanF * uy;
      const dz = fz + ndcX * tanF * aspect * rz + ndcY * tanF * uz;
      // 预筛：盒命中并按入射 t 排序
      const cands = [];
      for (const ms of meshes) {
        let t0 = 0, t1 = Infinity, ok = true;
        const O = [px, py, pz], D = [dx, dy, dz];
        for (let a = 0; a < 3; a++) {
          const mn = ms.box.mn[a], mx = ms.box.mx[a];
          if (Math.abs(D[a]) < 1e-9) { if (O[a] < mn || O[a] > mx) { ok = false; break; } continue; }
          let ta = (mn - O[a]) / D[a], tb = (mx - O[a]) / D[a];
          if (ta > tb) { const t = ta; ta = tb; tb = t; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (!ok || t0 > t1) continue;
        cands.push({ ms, tEnter: Math.max(t0, 0) });
      }
      cands.sort((a, b) => a.tEnter - b.tEnter);
      let best = null;
      for (const { ms, tEnter } of cands) {
        if (best && best.t < tEnter) break; // 后面的盒入射更远，不可能更近
        const { pos, idx, m } = ms;
        const n = idx ? idx.length : pos.count;
        for (let i = 0; i < n; i += 3) {
          const i0 = idx ? idx[i] : i, i1 = idx ? idx[i + 1] : i + 1, i2 = idx ? idx[i + 2] : i + 2;
          const ax = m[0] * pos.getX(i0) + m[4] * pos.getY(i0) + m[8] * pos.getZ(i0) + m[12];
          const ay = m[1] * pos.getX(i0) + m[5] * pos.getY(i0) + m[9] * pos.getZ(i0) + m[13];
          const az = m[2] * pos.getX(i0) + m[6] * pos.getY(i0) + m[10] * pos.getZ(i0) + m[14];
          const bx = m[0] * pos.getX(i1) + m[4] * pos.getY(i1) + m[8] * pos.getZ(i1) + m[12];
          const by = m[1] * pos.getX(i1) + m[5] * pos.getY(i1) + m[9] * pos.getZ(i1) + m[13];
          const bz = m[2] * pos.getX(i1) + m[6] * pos.getY(i1) + m[10] * pos.getZ(i1) + m[14];
          const cx2 = m[0] * pos.getX(i2) + m[4] * pos.getY(i2) + m[8] * pos.getZ(i2) + m[12];
          const cy2 = m[1] * pos.getX(i2) + m[5] * pos.getY(i2) + m[9] * pos.getZ(i2) + m[13];
          const cz2 = m[2] * pos.getX(i2) + m[6] * pos.getY(i2) + m[10] * pos.getZ(i2) + m[14];
          const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
          const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
          const pxv = dy * e2z - dz * e2y, pyv = dz * e2x - dx * e2z, pzv = dx * e2y - dy * e2x;
          const det = e1x * pxv + e1y * pyv + e1z * pzv;
          if (det > -1e-12 && det < 1e-12) continue;
          const inv = 1 / det;
          const tx = px - ax, ty = py - ay, tz = pz - az;
          const u = (tx * pxv + ty * pyv + tz * pzv) * inv;
          if (u < 0 || u > 1) continue;
          const qx = e1y * tz - e1z * ty, qy = e1z * tx - e1x * tz, qz = e1x * ty - e1y * tx;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t > 0.001 && (!best || t < best.t)) best = { t, ms };
        }
      }
      return best;
    }

    const points = [
      ["中左", 0.30, 0.45], ["中心", 0.50, 0.40], ["中下", 0.50, 0.58],
      ["中右", 0.70, 0.45], ["下带", 0.50, 0.78],
    ];
    const picks = [];
    for (const [name, fx2, fy2] of points) {
      const hit = pick(fx2 * 2 - 1, 1 - fy2 * 2);
      if (!hit) { picks.push({ name, miss: true }); continue; }
      const w = hit.ms;
      // 后代扫描：loadedTiles 中所有 zoom>w.zoom 且祖先归并到 w 的瓦片
      const desc = [];
      for (const [k2, e2] of layer.loadedTiles) {
        if (k2 === w.key) continue;
        const [x2, y2, z2] = k2.split(",").map(Number);
        if (z2 <= w.zoom || z2 > w.zoom + 6) continue;
        const sh = z2 - w.zoom;
        if ((x2 >> sh) === Math.floor(w.key.split(",")[0] * 1) && (y2 >> sh) === Math.floor(w.key.split(",")[1] * 1)) {
          desc.push({
            key: k2, zoom: z2,
            vis: !!e2.mesh?.visible,
            op: +(e2.mesh?.material?.opacity ?? 0).toFixed(2),
            ready: !!e2.imageryReady, img: e2.imageryZoom,
            pend: e2.pendingImageryZoom, reveal: !!e2.revealPending,
            inVis: layer.currentVisibleKeys.has(k2),
          });
        }
      }
      desc.sort((a, b) => a.zoom - b.zoom || a.key.localeCompare(b.key));
      picks.push({
        name, key: w.key, zoom: w.zoom, t: Math.round(hit.t),
        op: w.op, dw: w.dw, img: w.img, ready: w.ready, pend: w.pend,
        reveal: w.reveal, inVis: w.inVis,
        desc: desc.slice(0, 16), descTotal: desc.length,
      });
    }
    // 可见集 zoom 分布
    const hist = {};
    for (const k of layer.currentVisibleKeys) {
      const z = +k.split(",")[2];
      hist[z] = (hist[z] || 0) + 1;
    }
    const s = layer.getCacheStats();
    const cam = layer.gis.threeToLngLat(camera.position);
    return {
      cam: { lng: +cam[0].toFixed(5), lat: +cam[1].toFixed(5), alt: Math.round(cam[2]) },
      visibleKeys: layer.currentVisibleKeys.size, hist,
      meshCount: meshes.length,
      stitch: `${s.stitchPending}+${s.stitchInFlight}`,
      picks,
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
    console.log(`\n== ${label} == 相机(${s.cam.lng},${s.cam.lat}) alt=${s.cam.alt}m 可见集=${s.visibleKeys} ${JSON.stringify(s.hist)} mesh=${s.meshCount} stitch=${s.stitch}`);
    for (const p of s.picks) {
      if (p.miss) { console.log(`  [${p.name}] 未命中`); continue; }
      console.log(`  [${p.name}] 真实赢家 ${p.key} t=${p.t} op=${p.op} DW=${p.dw ? 1 : 0} img=z${p.img}${p.ready ? "" : "(未就绪)"}${p.pend != null ? "->z" + p.pend : ""} 候场=${p.reveal ? 1 : 0} 可见集=${p.inVis ? 1 : 0} 后代=${p.descTotal}`);
      for (const d of p.desc) {
        console.log(`      后代 ${d.key.padEnd(16)} vis=${d.vis ? 1 : 0} op=${d.op} img=z${d.img}${d.ready ? "" : "(未就绪)"}${d.pend != null ? "->z" + d.pend : ""} 候场=${d.reveal ? 1 : 0} 可见集=${d.inVis ? 1 : 0}`);
      }
    }
  };
  const probe = (label) => page.evaluate(probeTri).then((s) => dump(label, s));

  await probe("初始");
  await page.mouse.move(cx, box.y + box.h * 0.65);
  await page.mouse.down({ button: "left" });
  for (let i = 1; i <= 24; i++) { await page.mouse.move(cx, box.y + box.h * 0.65 + ((box.y + box.h * 0.28 - box.y - box.h * 0.65) * i) / 24); await sleep(33); }
  await page.mouse.up({ button: "left" });
  await sleep(3000);
  for (let i = 0; i < 7; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400); await sleep(350); }
  await sleep(10000);
  await probe("拉近后");

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
    await page.screenshot({ path: path.join(process.cwd(), "artifacts", `ray2-r${round}.png`) });
  }
  await sleep(8000);
  await probe("最终(静置8s)");
  await page.screenshot({ path: path.join(process.cwd(), "artifacts", "ray2-settled.png") });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

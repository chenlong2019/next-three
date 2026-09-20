/**
 * 双面渲染（THREE.DoubleSide）成本 A/B 探针。
 *
 * 问题：地形材质用 DoubleSide 时，背面三角形不会被剔除。是否影响性能？
 * 做法：同一相机、同一已加载瓦片集合下，切换 DoubleSide / FrontSide 各跑若干帧：
 *   1. 帧时间（中位数 / p10 / p90）——衡量实际渲染开销
 *   2. 背面三角形占比（数量 + 投影面积）——被剔除后能省掉的栅格化工作量上限
 *   3. 截图逐像素比对——FrontSide 是否让地形消失/破洞（= DoubleSide 是否为正确性所必需）
 *
 * 注意：headless 用 SwiftShader 软件光栅化，对片元工作量比真实 GPU 敏感，
 * 故绝对帧时间不能外推，但 FrontSide vs DoubleSide 的**相对**差异有效。
 *
 * 运行前提：dev server (localhost:12345)。
 */
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const { chromium } = require(path.join(process.cwd(), "node_modules", "playwright"));

const URL = process.env.REPRO_URL || "http://localhost:12345/examples/cesium-terrain/fullscreen/";
const OUT_DIR = path.join(process.cwd(), "artifacts");
const FRAMES = Number(process.env.FRAMES || 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOUBLE_SIDE = 2; // THREE.DoubleSide
const FRONT_SIDE = 0; // THREE.FrontSide

// ───────────────────────── 页面内助手（注入到页面上下文） ─────────────────────────

/**
 * Playwright 的 evaluate 只序列化单个函数，Node 侧的作用域不会带进页面，
 * 故把所有页面内逻辑写成一段自包含脚本，用 addInitScript 注入。
 */
const PAGE_SIDE_HELPERS = `
(function () {
  globalThis.__dbg = globalThis.__dbg || {};

  /** 地形网格：从任一已加载瓦片向上走到根，再遍历取带 childVisibility 标记的网格 */
  globalThis.__dbg.collect = function () {
    var L = globalThis.__terrainDebug;
    var first = L && L.loadedTiles ? L.loadedTiles.values().next().value : null;
    var anchor = first && first.mesh;
    if (!anchor) return [];
    var root = anchor;
    while (root.parent) root = root.parent;
    var out = [];
    root.traverse(function (o) {
      if (o.isMesh && o.material && o.material.userData && o.material.userData.childVisibility) out.push(o);
    });
    return out;
  };

  /** 切换所有地形材质 side，返回受影响数量 */
  globalThis.__dbg.applySide = function (side) {
    return globalThis.__dbg.applyConfig({ side: side });
  };

  /**
   * 切换地形材质配置。除 side 外还支持：
   *   forceSinglePass=true —— 绕开 three「透明+双面」的背面/正面两次绘制路径
   *   opaque=true          —— transparent=false + opacity=1（淡入结束后本可如此，
   *                           可让地形进入不透明队列：单遍 + early-z + 不排序）
   */
  globalThis.__dbg.applyConfig = function (cfg) {
    var meshes = globalThis.__dbg.collect();
    var changed = 0;
    for (var i = 0; i < meshes.length; i++) {
      var m = meshes[i].material;
      var dirty = false;
      if (cfg.side !== undefined && m.side !== cfg.side) { m.side = cfg.side; dirty = true; }
      if (cfg.forceSinglePass !== undefined && m.forceSinglePass !== cfg.forceSinglePass) {
        m.forceSinglePass = cfg.forceSinglePass;
        dirty = true;
      }
      if (cfg.opaque !== undefined) {
        if (cfg.opaque) {
          if (m.transparent !== false) { m.transparent = false; dirty = true; }
          if (m.opacity !== 1) { m.opacity = 1; dirty = true; }
          if (cfg.side === undefined) { m.side = 2; }
        } else if (m.transparent !== true) {
          m.transparent = true;
          dirty = true;
        }
      }
      if (dirty) { m.needsUpdate = true; changed++; }
    }
    return { meshes: meshes.length, changed: changed };
  };

  globalThis.__dbg.state = function () {
    var L = globalThis.__terrainDebug;
    if (!L) return { err: "no layer" };
    return {
      visible: L.currentVisibleKeys ? L.currentVisibleKeys.size : -1,
      loaded: L.loadedTiles ? L.loadedTiles.size : -1,
      pending: L.pending ? (L.pending.length !== undefined ? L.pending.length : L.pending.size) : -1,
      loading: L.loading ? L.loading.size : -1,
    };
  };

  /** 帧时间统计（rAF 间隔）+ 绘制调用计数 */
  globalThis.__dbg.measureFrames = function (frames) {
    var canvas = document.querySelector("canvas");
    var gl = canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
    if (gl && !globalThis.__dbg.drawHooked) {
      globalThis.__dbg.drawHooked = true;
      globalThis.__dbg.drawCount = 0;
      ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced"].forEach(function (name) {
        var orig = gl[name];
        if (typeof orig !== "function") return;
        gl[name] = function () {
          globalThis.__dbg.drawCount++;
          return orig.apply(this, arguments);
        };
      });
    }
    if (globalThis.__dbg.drawCount !== undefined) globalThis.__dbg.drawCount = 0;
    return new Promise(function (resolve) {
      var gaps = [];
      var perFrameDraws = [];
      var last = 0;
      var lastDraws = 0;
      var n = 0;
      function tick(t) {
        if (last) {
          gaps.push(t - last);
          perFrameDraws.push(globalThis.__dbg.drawCount - lastDraws);
        }
        lastDraws = globalThis.__dbg.drawCount;
        last = t;
        n++;
        if (n <= frames) {
          requestAnimationFrame(tick);
          return;
        }
        gaps.sort(function (a, b) { return a - b; });
        perFrameDraws.sort(function (a, b) { return a - b; });
        function at(arr, q) {
          var i = Math.min(arr.length - 1, Math.floor(arr.length * q));
          return i >= 0 ? arr[i] : -1;
        }
        var sum = 0;
        for (var i = 0; i < gaps.length; i++) sum += gaps[i];
        resolve({
          frames: gaps.length,
          median: +at(gaps, 0.5).toFixed(2),
          p10: +at(gaps, 0.1).toFixed(2),
          p90: +at(gaps, 0.9).toFixed(2),
          avg: +(sum / Math.max(gaps.length, 1)).toFixed(2),
          fps: +(1000 / Math.max(at(gaps, 0.5), 0.001)).toFixed(1),
          drawsPerFrame: at(perFrameDraws, 0.5),
          draws: globalThis.__dbg.drawCount === undefined ? -1 : globalThis.__dbg.drawCount,
        });
      }
      requestAnimationFrame(tick);
    });
  };

  /**
   * 背面三角形统计：抽样三角形，裁剪空间 w>0 剔除相机背后的顶点，
   * NDC 带符号面积判正/背面（WebGL 默认 CCW 为正面），累加投影与屏幕内面积。
   */
  globalThis.__dbg.facingStats = function () {
    var L = globalThis.__terrainDebug;
    var cam = L && L.currentCamera;
    if (!cam) return { err: "no camera" };
    var W = L.currentViewportWidth || 1280;
    var H = L.currentViewportHeight || 860;
    cam.updateMatrixWorld(true);
    var viewEl = cam.matrixWorldInverse.elements;
    var projEl = cam.projectionMatrix.elements;

    function project(x, y, z, mw, out) {
      var vx = mw[0] * x + mw[4] * y + mw[8] * z + mw[12];
      var vy = mw[1] * x + mw[5] * y + mw[9] * z + mw[13];
      var vz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
      var cx = viewEl[0] * vx + viewEl[4] * vy + viewEl[8] * vz + viewEl[12];
      var cy = viewEl[1] * vx + viewEl[5] * vy + viewEl[9] * vz + viewEl[13];
      var cz = viewEl[2] * vx + viewEl[6] * vy + viewEl[10] * vz + viewEl[14];
      var cw = viewEl[3] * vx + viewEl[7] * vy + viewEl[11] * vz + viewEl[15];
      out[0] = projEl[0] * cx + projEl[4] * cy + projEl[8] * cz + projEl[12] * cw;
      out[1] = projEl[1] * cx + projEl[5] * cy + projEl[9] * cz + projEl[13] * cw;
      out[2] = projEl[3] * cx + projEl[7] * cy + projEl[11] * cz + projEl[15] * cw;
      return out[2];
    }

    var meshes = globalThis.__dbg.collect();
    // 网格 → 瓦片 key，便于定位背面样本
    var keyOf = new Map();
    if (L.loadedTiles) {
      L.loadedTiles.forEach(function (e, k) {
        if (e && e.mesh) keyOf.set(e.mesh, k);
      });
    }
    var triTotal = 0, triSampled = 0, triBack = 0;
    var areaFront = 0, areaBack = 0, areaBackInView = 0;
    var samples = [];
    var a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];

    for (var mi = 0; mi < meshes.length; mi++) {
      var mesh = meshes[mi];
      var geo = mesh.geometry;
      var pos = geo && geo.attributes && geo.attributes.position;
      var idx = geo && geo.index;
      var opacity = mesh.material ? (mesh.material.opacity || 0) : 0;
      if (!pos || !idx) continue;
      var triCount = Math.floor(idx.count / 3);
      triTotal += triCount;
      if (mesh.visible === false || opacity <= 0.5) continue;
      mesh.updateWorldMatrix(true, false);
      var mw = mesh.matrixWorld.elements;
      var step = Math.max(1, Math.floor(triCount / 300));
      for (var t = 0; t < triCount; t += step) {
        var i0 = idx.getX(t * 3) * 3;
        var i1 = idx.getX(t * 3 + 1) * 3;
        var i2 = idx.getX(t * 3 + 2) * 3;
        triSampled++;
        var verts = [a, b, c];
        var offs = [i0, i1, i2];
        var ok = true;
        for (var k = 0; k < 3; k++) {
          var w = project(pos.array[offs[k]], pos.array[offs[k] + 1], pos.array[offs[k] + 2], mw, verts[k]);
          if (w <= 1e-6) { ok = false; break; }
        }
        if (!ok) continue;
        var ax = a[0] / a[2], ay = a[1] / a[2];
        var bx = b[0] / b[2], by = b[1] / b[2];
        var ccx = c[0] / c[2], ccy = c[1] / c[2];
        var cross = (bx - ax) * (ccy - ay) - (by - ay) * (ccx - ax);
        var areaPx = (Math.abs(cross) / 2) * ((W / 2) * (H / 2));
        var inView =
          !(ax < -1 && bx < -1 && ccx < -1) &&
          !(ax > 1 && bx > 1 && ccx > 1) &&
          !(ay < -1 && by < -1 && ccy < -1) &&
          !(ay > 1 && by > 1 && ccy > 1);
        if (cross > 0) areaFront += areaPx;
        else {
          areaBack += areaPx;
          triBack++;
          if (inView) areaBackInView += areaPx;
          if (samples.length < 8 && inView) {
            samples.push({
              key: keyOf.get(mesh) || mesh.name || "?",
              areaPx: Math.round(areaPx),
            });
          }
        }
      }
    }
    var total = areaFront + areaBack;
    return {
      meshes: meshes.length,
      triTotal: triTotal,
      triSampled: triSampled,
      triBack: triBack,
      backTriRatio: triSampled ? +(triBack / triSampled).toFixed(4) : 0,
      backAreaShare: total > 0 ? +(areaBack / total).toFixed(4) : 0,
      backInViewPx: Math.round(areaBackInView),
      backInViewShare: +(((areaBackInView / (W * H)) * 100).toFixed(3)),
      samples: samples,
    };
  };
})();
`;

// ───────────────────────── Node 侧：PNG 解码与比对 ─────────────────────────

function decodePng(buf) {
  let pos = 8;
  const idat = [];
  let w = 0;
  let h = 0;
  let bitDepth = 8;
  let colorType = 6;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  const bpp = channels * (bitDepth / 8);
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);
    if (filter === 1 || filter === 3 || filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        if (filter === 1) cur[i] = (cur[i] + a) & 0xff;
        else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
        else {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, bpp, data: out };
}

function diffPng(fileA, fileB, threshold = 24) {
  const A = decodePng(fs.readFileSync(fileA));
  const B = decodePng(fs.readFileSync(fileB));
  if (A.w !== B.w || A.h !== B.h) return { err: "size mismatch" };
  let changed = 0;
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  const step = Math.max(1, A.bpp);
  for (let y = 0; y < A.h; y++) {
    for (let x = 0; x < A.w; x++) {
      const o = y * A.w * step + x * step;
      const d = Math.max(
        Math.abs(A.data[o] - B.data[o]),
        Math.abs(A.data[o + 1] - B.data[o + 1]),
        Math.abs(A.data[o + 2] - B.data[o + 2]),
      );
      if (d > threshold) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = A.w * A.h;
  return {
    changed,
    ratio: +(changed / total).toFixed(4),
    bbox: changed ? `${minX},${minY} → ${maxX},${maxY}` : "-",
  };
}

// ───────────────────────── 专项：噪声基线 + 地下仰视 ─────────────────────────

/**
 * 1) 稳定期噪声：同一配置下间隔 3s 连拍 4 张，两两比对 —— 用于判断
 *    "两次截图差异很大"到底是 side 改动的效果，还是场景本身还在变（影像升级等）。
 * 2) 地下仰视：把相机压到地表以下（保持朝向），分别用 DoubleSide / FrontSide
 *    截图 —— 判断"从底下往上看正常渲染"是否是 DoubleSide 独有的能力。
 */
async function runStabilityAndBelow(page) {
  const tag = "stab";
  await waitSettle(page, "稳定期");
  const shots = [];
  for (let i = 0; i < 4; i++) {
    const p = path.join(OUT_DIR, `stab-${tag}-${i}.png`);
    await page.screenshot({ path: p });
    shots.push(p);
    await sleep(3000);
  }
  console.log("\n===== 稳定期噪声（同一配置，间隔 3s） =====");
  for (let i = 1; i < shots.length; i++) {
    const d = diffPng(shots[0], shots[i]);
    console.log(`  第1张 vs 第${i + 1}张：画面变更 ${(d.ratio * 100).toFixed(2)}%`);
  }

  await page.evaluate(`globalThis.__dbg.applyConfig(${JSON.stringify({ side: FRONT_SIDE })})`);
  await sleep(6000);
  const f1 = path.join(OUT_DIR, "stab-front-1.png");
  const f2 = path.join(OUT_DIR, "stab-front-2.png");
  await page.screenshot({ path: f1 });
  await sleep(3000);
  await page.screenshot({ path: f2 });
  await page.evaluate(`globalThis.__dbg.applyConfig(${JSON.stringify({ side: DOUBLE_SIDE })})`);
  await sleep(6000);
  const b1 = path.join(OUT_DIR, "stab-double-1.png");
  await page.screenshot({ path: b1 });

  const dFrontStable = diffPng(f1, f2);
  const dCross = diffPng(f2, b1);
  const dSame = diffPng(shots[3], b1);
  console.log("===== 切换 side（各自稳定 6s 后截图） =====");
  console.log(`  FrontSide 内部稳定（间隔 3s）：${(dFrontStable.ratio * 100).toFixed(2)}%`);
  console.log(`  FrontSide → DoubleSide（各稳定后）：${(dCross.ratio * 100).toFixed(2)}%`);
  console.log(`  DoubleSide(切换前) → DoubleSide(切换回来)：${(dSame.ratio * 100).toFixed(2)}%`);

  // 地下仰视：把相机压到地表以下（Z-up，第三轴即高度）
  const below = await page.evaluate(`(function () {
    var L = globalThis.__terrainDebug;
    var cam = L.currentCamera;
    var before = cam.position.z;
    // 找到相机脚下方圆内的最细已加载瓦片，取其网格最高点作为地表高度估计
    var maxZ = -Infinity;
    L.loadedTiles.forEach(function (e) {
      var mesh = e.mesh;
      if (!mesh || !mesh.visible) return;
      var pos = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
      if (!pos) return;
      var dx = mesh.position.x - cam.position.x;
      var dy = mesh.position.y - cam.position.y;
      if (dx * dx + dy * dy > 400000 * 400000) return;
      for (var i = 2; i < pos.array.length; i += 3) {
        if (pos.array[i] > maxZ) maxZ = pos.array[i];
      }
    });
    if (!isFinite(maxZ)) return { err: "no terrain data" };
    cam.position.z = maxZ - 600;
    cam.updateMatrixWorld(true);
    return { before: Math.round(before), surface: Math.round(maxZ), after: Math.round(cam.position.z) };
  })()`);
  console.log("\n===== 地下仰视 =====");
  if (below.err) {
    console.log("  无法进入地下:", below.err);
  } else {
    console.log(`  相机高度 ${below.before}m → ${below.after}m（地表估计 ${below.surface}m）`);
    await sleep(6000);
    const stick = await page.evaluate("Math.round(globalThis.__terrainDebug.currentCamera.position.z)");
    console.log(`  6s 后相机高度=${stick}m（与设定值接近说明控制器未把它拉回）`);
    const undergroundDouble = path.join(OUT_DIR, "stab-below-double.png");
    await page.screenshot({ path: undergroundDouble });
    await page.evaluate(`globalThis.__dbg.applyConfig(${JSON.stringify({ side: FRONT_SIDE })})`);
    await sleep(2500);
    const undergroundFront = path.join(OUT_DIR, "stab-below-front.png");
    await page.screenshot({ path: undergroundFront });
    await page.evaluate(`globalThis.__dbg.applyConfig(${JSON.stringify({ side: DOUBLE_SIDE })})`);
    const d = diffPng(undergroundDouble, undergroundFront);
    console.log(`  地下视角 DoubleSide vs FrontSide：画面变更 ${(d.ratio * 100).toFixed(2)}%`);
    console.log(`  截图：${path.basename(undergroundDouble)} / ${path.basename(undergroundFront)}`);
  }
}

// ───────────────────────── 主流程 ─────────────────────────

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

/** 等瓦片真正静置：队列空、无在途，且可见集/已加载数连续 4 次采样不变 */
async function waitSettle(page, label) {
  let stable = 0;
  let prev = "";
  for (let i = 0; i < 60; i++) {
    const s = await page.evaluate("globalThis.__dbg.state()");
    const sig = `${s.visible}/${s.loaded}/${s.pending}/${s.loading}`;
    const idle = s.pending === 0 && s.loading === 0;
    stable = idle && sig === prev ? stable + 1 : 0;
    prev = sig;
    if (stable >= 4) return s;
    await sleep(700);
  }
  console.log(`  [警告] ${label} 未在超时内静置，继续测量（数据可能被加载活动污染）`);
  return await page.evaluate("globalThis.__dbg.state()");
}

/** 一个视角下：切 DoubleSide 测 → 切 FrontSide 测 → 再切 DoubleSide 复核 */
async function runView(page, name) {
  const tag = name.replace(/[^\w\u4e00-\u9fa5]/g, "");
  console.log(`\n===== 视角：${name} =====`);
  const settled = await waitSettle(page, name);
  console.log(
    `  静置状态：可见集=${settled.visible} 已加载=${settled.loaded} 队列=${settled.pending} 在途=${settled.loading}`,
  );

  const result = { name, passes: [] };
  // ① 现状（透明 + DoubleSide → three 会拆分背面/正面两遍）
  // ② 现状 + forceSinglePass（同外观，逼 three 只画一遍）
  // ③ 淡入完成后的理想状态：不透明队列（单遍 + early-z + 不参与透明排序）
  // ④ 关闭背面（FrontSide，检查环绕方向是否允许剔除）
  const configs = [
    ["①DoubleSide现状", { side: DOUBLE_SIDE, forceSinglePass: false, opaque: false }],
    ["②DS+单遍", { side: DOUBLE_SIDE, forceSinglePass: true, opaque: false }],
    ["③不透明队列", { side: DOUBLE_SIDE, forceSinglePass: false, opaque: true }],
    ["④FrontSide", { side: FRONT_SIDE, forceSinglePass: false, opaque: false }],
    ["①复核", { side: DOUBLE_SIDE, forceSinglePass: false, opaque: false }],
  ];
  for (const [label, cfg] of configs) {
    const st = await page.evaluate("globalThis.__dbg.state()");
    const applied = await page.evaluate(`globalThis.__dbg.applyConfig(${JSON.stringify(cfg)})`);
    await sleep(1500); // 程序重编译 + 稳定
    const facing = await page.evaluate("globalThis.__dbg.facingStats()");
    const perf = await page.evaluate(`globalThis.__dbg.measureFrames(${FRAMES})`);
    const shot = path.join(OUT_DIR, `side-${tag}-${label.replace(/[^\w\u4e00-\u9fa5]/g, "")}.png`);
    await page.screenshot({ path: shot });
    result.passes.push({ label, cfg, applied, facing, perf, shot, state: st });
    console.log(
      `  ${label.padEnd(16)} 帧中位=${String(perf.median).padStart(6)}ms p90=${String(perf.p90).padStart(6)}ms ` +
        `≈${String(perf.fps).padStart(5)}fps draw/帧=${String(perf.drawsPerFrame).padStart(3)} | 网格=${facing.meshes} ` +
        `背面三角=${(facing.backTriRatio * 100).toFixed(1)}% 背面屏幕占比=${facing.backInViewShare}% | 状态 ${st.visible}/${st.loaded}/${st.pending}/${st.loading}`,
    );
  }

  const base = result.passes[0];
  const recheck = result.passes[result.passes.length - 1];
  for (const p of result.passes.slice(1, -1)) {
    const d = diffPng(base.shot, p.shot);
    const rel = (((p.perf.median - base.perf.median) / base.perf.median) * 100).toFixed(1);
    console.log(
      `  ${p.label} vs ①：帧时间 ${rel}%（${base.perf.median}→${p.perf.median}ms） draw/帧 ${base.perf.drawsPerFrame}→${p.perf.drawsPerFrame} ` +
        `| 画面变更 ${(d.ratio * 100).toFixed(2)}%（区域 ${d.bbox}）`,
    );
    p.diff = d;
  }
  const dNoise = diffPng(base.shot, recheck.shot);
  console.log(
    `  噪声基线（① vs ①复核）：画面变更 ${(dNoise.ratio * 100).toFixed(2)}%，帧时间 ${base.perf.median}→${recheck.perf.median}ms`,
  );
  result.diffNoise = dNoise;
  result.facing = base.facing;
  if (base.facing.samples?.length) {
    console.log(`  屏幕内背面三角形样本（投影面积 px）：`);
    for (const s of base.facing.samples) console.log(`     ${s.key} area=${s.areaPx}px`);
  }
  return result;
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
  console.log(`URL: ${URL}  每轮帧数=${FRAMES}`);
  await page.addInitScript(PAGE_SIDE_HELPERS);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  if (!(await waitReady(page))) {
    console.error("图层未就绪");
    await browser.close();
    process.exit(2);
  }

  const cx = 640;
  const cy = 430;

  if (process.env.PHASE === "stab") {
    // 拉近 + 压低到低空斜视，再进专项测试
    for (let i = 0; i < 26; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, -240);
      await sleep(240);
    }
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "left" });
    for (let i = 0; i < 7; i++) {
      await page.mouse.move(cx, cy + 90, { steps: 6 });
      await sleep(70);
    }
    await page.mouse.up({ button: "left" });
    await runStabilityAndBelow(page);
    await browser.close();
    return;
  }

  const results = [];

  // 视角 1：初始远景
  results.push(await runView(page, "1-初始远景"));

  // 视角 2：拉近 + 压低到低空斜视（屏幕内几何最多的场景）
  for (let i = 0; i < 26; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await sleep(240);
  }
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "left" });
  for (let i = 0; i < 7; i++) {
    await page.mouse.move(cx, cy + 90, { steps: 6 });
    await sleep(70);
  }
  await page.mouse.up({ button: "left" });
  results.push(await runView(page, "2-低空斜视"));

  console.log("\n======== 汇总 ========");
  for (const r of results) {
    const base = r.passes[0];
    console.log(
      `${r.name}：现状 draw/帧=${base.perf.drawsPerFrame} 帧中位=${base.perf.median}ms | ` +
        `背面屏幕占比=${r.facing.backInViewShare}% | 噪声基线=${(r.diffNoise.ratio * 100).toFixed(2)}%`,
    );
    for (const p of r.passes.slice(1, -1)) {
      console.log(
        `   ${p.label.padEnd(14)} draw/帧=${String(p.perf.drawsPerFrame).padStart(3)} 帧中位=${String(p.perf.median).padStart(6)}ms ` +
          `画面变更=${(p.diff.ratio * 100).toFixed(2)}%`,
      );
    }
  }

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

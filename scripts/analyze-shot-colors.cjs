/**
 * 直接解码层级着色截图，把每个像素的颜色反查成层级，用于客观判定"碎色块是哪一级"。
 *
 * 用法: node scripts/analyze-shot-colors.cjs <png路径>
 *
 * 输出：
 *   1. 全图各层级像素占比（对照图例里的"正选/上屏"数，可判断哪些层级在画不该画的像素）
 *   2. ASCII 层级图（每格取该格主导层级，粗粒度看整体分层）
 *   3. 碎块检测：与周围 41x41 窗口中位层级不一致的像素聚成簇，报告"碎片层级 vs 周边层级"、
 *      面积、位置——碎片层级比周边更粗 = 粗瓦片越界（糊）；更细 = 精细瓦片只露出一小块（细碎）
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

// 与 CesiumTerrainLayer.DEBUG_ZOOM_COLORS 一致。
// 注意：2026-09-20 起色表已换新（旧表里 z6 与 z16 是同一个色值、另有 27 对间距 <90，
// 导致截图无法反查层级）。分析旧截图时用 --palette=old。
const PALETTE_NEW = {
  0: 0x030396, 1: 0x8e05f0, 2: 0x73fcfc, 3: 0xb8e28d, 4: 0x960303, 5: 0xb873fc,
  6: 0x96037d, 7: 0xfa19fa, 8: 0x039603, 9: 0x3b82f6, 10: 0x22c55e, 11: 0xfacc15,
  12: 0xef4444, 13: 0xfb923c, 14: 0xec4899, 15: 0x14b8a6, 16: 0x1919fa, 17: 0x966503,
  18: 0x84cc16, 19: 0x2cf005, 20: 0x55fc9a,
};
const PALETTE_OLD = {
  0: 0x475569, 1: 0x64748b, 2: 0x78716c, 3: 0x92400e, 4: 0x0ea5e9, 5: 0x6366f1,
  6: 0x8b5cf6, 7: 0xa855f7, 8: 0xc084fc, 9: 0x3b82f6, 10: 0x22c55e, 11: 0xfacc15,
  12: 0xef4444, 13: 0xfb923c, 14: 0xec4899, 15: 0x14b8a6, 16: 0x8b5cf6, 17: 0x06b6d4,
  18: 0x84cc16, 19: 0xf59e0b, 20: 0xa3e635,
};
const USE_OLD = process.argv.includes("--palette=old");
const PALETTE = USE_OLD ? PALETTE_OLD : PALETTE_NEW;
if (USE_OLD) console.log("注意：使用旧色表（z6 与 z16 同色，两者无法区分）");
const ENTRIES = Object.entries(PALETTE).map(([z, hex]) => ({
  zoom: +z,
  r: (hex >> 16) & 255,
  g: (hex >> 8) & 255,
  b: hex & 255,
}));

function decodePng(buf) {
  let pos = 8;
  let idat = [];
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

function classify(r, g, b) {
  let best = -1;
  let bestD = Infinity;
  for (const e of ENTRIES) {
    const d = (r - e.r) ** 2 + (g - e.g) ** 2 + (b - e.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e.zoom;
    }
  }
  return { zoom: best, dist: Math.sqrt(bestD) };
}

const file = process.argv[2];
if (!file) {
  console.error("用法: node scripts/analyze-shot-colors.cjs <png路径>");
  process.exit(2);
}
const img = decodePng(fs.readFileSync(file));
console.log(`图像: ${path.basename(file)} ${img.w}x${img.h} bpp=${img.bpp}`);

const N = img.w * img.h;
const zoomMap = new Int16Array(N);
const distMap = new Float32Array(N);
const hist = new Map();
let unmatched = 0;

const px = (x, y) => (y * img.w + x) * img.bpp;

// 忽略区域：图例（左下）、HUD（左上）、右上小方块
const ignored = (x, y) =>
  (x < 300 && y > img.h * 0.66) || (x < 240 && y < 90) || (x > img.w - 70 && y < 60);

for (let y = 0; y < img.h; y++) {
  for (let x = 0; x < img.w; x++) {
    const i = y * img.w + x;
    const o = px(x, y);
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    const c = classify(r, g, b);
    zoomMap[i] = c.zoom;
    distMap[i] = c.dist;
    if (c.dist > 70) unmatched++;
    if (ignored(x, y)) continue;
    hist.set(c.zoom, (hist.get(c.zoom) ?? 0) + 1);
  }
}

const total = [...hist.values()].reduce((a, b) => a + b, 0);
console.log("\n各层级像素占比（已排除图例/HUD；含位置分布，便于区分'远景地平线'与'画面内部碎片'）:");
// 先统计每个层级的包围盒与纵向分布
const stat = new Map();
for (let y = 0; y < img.h; y++) {
  for (let x = 0; x < img.w; x++) {
    if (ignored(x, y)) continue;
    const z = zoomMap[y * img.w + x];
    let s = stat.get(z);
    if (!s) {
      s = { n: 0, minX: img.w, maxX: 0, minY: img.h, maxY: 0, bands: [0, 0, 0] };
      stat.set(z, s);
    }
    s.n++;
    if (x < s.minX) s.minX = x;
    if (x > s.maxX) s.maxX = x;
    if (y < s.minY) s.minY = y;
    if (y > s.maxY) s.maxY = y;
    s.bands[y < img.h / 3 ? 0 : y < (img.h * 2) / 3 ? 1 : 2]++;
  }
}
for (const [z, n] of [...hist.entries()].sort((a, b) => a[0] - b[0])) {
  const s = stat.get(z);
  console.log(
    `  z${String(z).padStart(2)}  ${(n / total * 100).toFixed(2).padStart(6)}%  ${String(n).padStart(7)} px  ` +
      `色=#${PALETTE[z].toString(16).padStart(6, "0")}  包围盒 ${s.minX},${s.minY}..${s.maxX},${s.maxY}  ` +
      `上/中/下=${(s.bands[0] / n * 100).toFixed(0)}/${(s.bands[1] / n * 100).toFixed(0)}/${(s.bands[2] / n * 100).toFixed(0)}%`,
  );
}
console.log(`  颜色无法匹配调色板的像素: ${unmatched} (${(unmatched / N * 100).toFixed(2)}%，多为抗锯齿/HUD 文字)`);
// 色表自检：反查是否可靠
{
  const zs = Object.keys(PALETTE).map(Number);
  const d = (a, b) => {
    const A = PALETTE[a];
    const B = PALETTE[b];
    return Math.hypot(((A >> 16) & 255) - ((B >> 16) & 255), ((A >> 8) & 255) - ((B >> 8) & 255), (A & 255) - (B & 255));
  };
  let min = Infinity;
  let pair = null;
  for (let i = 0; i < zs.length; i++)
    for (let j = i + 1; j < zs.length; j++) {
      const v = d(zs[i], zs[j]);
      if (v < min) {
        min = v;
        pair = [zs[i], zs[j]];
      }
    }
  console.log(
    `  色表最小间距=${min.toFixed(1)}（z${pair[0]}-z${pair[1]}）${min < 60 ? " ⚠ 过近，反查会串级" : " ✓"}`,
  );
}

// ASCII 主导层级图
const CELL = Math.max(8, Math.floor(img.w / 80));
const cols = Math.floor(img.w / CELL);
const rows = Math.floor(img.h / CELL);
const sym = (z) => {
  if (z >= 18) return "@";
  if (z === 17) return "C";
  if (z === 16) return "V";
  if (z === 15) return "T";
  if (z === 14) return "P";
  if (z === 13) return "O";
  if (z === 12) return "R";
  if (z === 11) return "Y";
  if (z === 10) return "G";
  if (z === 9) return "B";
  if (z === 8) return "v";
  if (z === 7) return "p";
  if (z === 6) return "u";
  if (z === 5) return "i";
  return ".";
};
console.log(`\nASCII 主导层级图（每格 ${CELL}px；R12 Y11 G10 B9 i5 u6 v8 p7 O13 P14 T15 V16 C17 @18+）:`);
const grid = [];
for (let cy = 0; cy < rows; cy++) {
  let line = "";
  for (let cx = 0; cx < cols; cx++) {
    const tally = new Map();
    for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
      for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
        if (ignored(x, y)) continue;
        const z = zoomMap[y * img.w + x];
        tally.set(z, (tally.get(z) ?? 0) + 1);
      }
    }
    let bestZ = -1;
    let bestN = 0;
    for (const [z, n] of tally) if (n > bestN) { bestN = n; bestZ = z; }
    line += sym(bestZ);
  }
  grid.push(line);
  console.log(`  ${line}`);
}

// 碎块检测：与 41x41 窗口中位层级不一致的像素 → 连通簇
const WIN = 20;
const flags = new Uint8Array(N);
const diff = new Int16Array(N);
for (let y = WIN; y < img.h - WIN; y++) {
  for (let x = WIN; x < img.w - WIN; x++) {
    if (ignored(x, y)) continue;
    const i = y * img.w + x;
    if (distMap[i] > 70) continue;
    const samples = [];
    for (let dy = -WIN; dy <= WIN; dy += 4)
      for (let dx = -WIN; dx <= WIN; dx += 4) {
        const j = (y + dy) * img.w + (x + dx);
        if (distMap[j] <= 70) samples.push(zoomMap[j]);
      }
    if (samples.length < 20) continue;
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)];
    if (Math.abs(zoomMap[i] - med) >= 2) {
      flags[i] = 1;
      diff[i] = zoomMap[i] - med;
    }
  }
}

const seen = new Uint8Array(N);
const clusters = [];
for (let i = 0; i < N; i++) {
  if (!flags[i] || seen[i]) continue;
  const stack = [i];
  seen[i] = 1;
  let count = 0;
  let minX = img.w;
  let maxX = 0;
  let minY = img.h;
  let maxY = 0;
  const zoomTally = new Map();
  let dSum = 0;
  while (stack.length) {
    const cur = stack.pop();
    const cx = cur % img.w;
    const cy = (cur - cx) / img.w;
    count++;
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    zoomTally.set(zoomMap[cur], (zoomTally.get(zoomMap[cur]) ?? 0) + 1);
    dSum += diff[cur];
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue;
      const ni = ny * img.w + nx;
      if (flags[ni] && !seen[ni]) {
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  let zBest = -1;
  let zN = 0;
  for (const [z, n] of zoomTally) if (n > zN) { zN = n; zBest = z; }
  clusters.push({
    count,
    zoom: zBest,
    meanDiff: +(dSum / count).toFixed(2),
    box: `${minX},${minY}..${maxX},${maxY}`,
    centerYRel: +(((minY + maxY) / 2) / img.h).toFixed(2),
  });
}
clusters.sort((a, b) => b.count - a.count);
console.log(`\n碎块检测（与周边中位层级差 ≥2 级）: 共 ${clusters.length} 簇`);
const coarse = clusters.filter((c) => c.meanDiff < 0);
const fine = clusters.filter((c) => c.meanDiff > 0);
console.log(
  `  比周边更粗的簇 ${coarse.length} 个（合计 ${coarse.reduce((a, c) => a + c.count, 0)} px）→ 这些就是"糊/越界"候选`,
);
console.log(
  `  比周边更细的簇 ${fine.length} 个（合计 ${fine.reduce((a, c) => a + c.count, 0)} px）`,
);
console.log("\n最大的 12 个碎块:");
for (const c of clusters.slice(0, 12))
  console.log(
    `  ${String(c.count).padStart(6)} px  z${String(c.zoom).padStart(2)}  ${c.meanDiff < 0 ? "比周边更粗" : "比周边更细"} (Δ${c.meanDiff})  位置 ${c.box}  屏幕纵向 ${c.centerYRel}`,
  );
const byZoom = new Map();
for (const c of clusters) byZoom.set(c.zoom, (byZoom.get(c.zoom) ?? 0) + c.count);
console.log(
  `\n碎块按层级汇总: ${[...byZoom.entries()].sort((a, b) => b[1] - a[1]).map(([z, n]) => `z${z}:${n}px`).join(" ")}`,
);

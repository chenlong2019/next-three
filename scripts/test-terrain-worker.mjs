/**
 * terrainMeshWorker 冒烟测试（Node --experimental-strip-types）
 *
 * 用进程内 FakeWorker 驱动 terrainWorkerMain，验证：
 * 1. quantized-mesh 头部/顶点(zigzag+delta)/索引(high-water mark) 解析
 * 2. 顶点展开（Web Mercator 投影 + UV）与主线程公式一致
 * 3. 裙边合并的顶点/索引数量正确，裙边顶点 Z 正确下移
 *
 * 运行：node scripts/test-terrain-worker.mjs
 */
import assert from "node:assert/strict";
import { terrainWorkerMain } from "../lib/sources/engine/layers/terrainMeshWorker.ts";

class FakeWorker {
  constructor() {
    this.results = [];
    this.onresult = null;
    // terrainWorkerMain 会设置 this.onmessage，并调用 this.postMessage 上报结果
    terrainWorkerMain(this);
  }
  /** worker → main 的结果通道 */
  postMessage(msg) {
    this.results.push(msg);
    if (this.onresult) this.onresult(msg);
  }
  /** main → worker 的任务派发 */
  dispatch(msg) {
    this.onmessage({ data: msg });
  }
}

// ── 构造合成 quantized-mesh ─────────────────────────────────────
// 4 个角点：u/v ∈ {0, 32767}，height ∈ {0, 100, 50, 25}
const MIN_H = 0;
const MAX_H = 100;

function zigzagEncode(delta) {
  return (delta << 1) ^ (delta >> 31);
}

function encodeChannel(values) {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const delta = values[i] - prev;
    view.setUint16(i * 2, zigzagEncode(delta) & 0xffff, true);
    prev = values[i];
  }
  return bytes;
}

function hwmEncode(indices) {
  const codes = [];
  let highest = 0;
  for (const idx of indices) {
    if (idx === highest) {
      codes.push(0);
      highest++;
    } else {
      codes.push(highest - idx);
    }
  }
  return codes;
}

const uVals = [0, 32767, 32767, 0];
const vVals = [0, 0, 32767, 32767];
const hVals = [0, 100, 50, 25];
// 三角形 (0,1,2) (2,1,3)
const triIndices = [0, 1, 2, 2, 1, 3];

function buildTerrainBuffer() {
  const uBytes = encodeChannel(uVals);
  const vBytes = encodeChannel(vVals);
  const hBytes = encodeChannel(hVals);
  const codes = hwmEncode(triIndices);

  // 与真实 .terrain 布局一致：header(88) + vertexCount(4) + 3 通道 + triangleCount(4) + u16 索引
  const headerSize = 88;
  const size =
    headerSize + 4 + uBytes.length + vBytes.length + hBytes.length + 4 + codes.length * 2;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  // boundingVolume 前半部分随便填，minHeight @24 f32, maxHeight @28 f32
  view.setFloat32(24, MIN_H, true);
  view.setFloat32(28, MAX_H, true);
  let offset = headerSize;
  view.setUint32(offset, uVals.length, true); // vertexCount
  offset += 4;
  bytescopy(view, offset, uBytes);
  offset += uBytes.length;
  bytescopy(view, offset, vBytes);
  offset += vBytes.length;
  bytescopy(view, offset, hBytes);
  offset += hBytes.length;
  // u16 索引按 2 字节对齐；此布局下 offset 恰为偶数，无需填充
  view.setUint32(offset, 2, true); // triangleCount
  offset += 4;
  for (let i = 0; i < codes.length; i++) {
    view.setUint16(offset + i * 2, codes[i], true);
  }
  return buffer;
}

function bytescopy(view, offset, bytes) {
  for (let i = 0; i < bytes.length; i++) view.setUint8(offset + i, bytes[i]);
}

// ── 独立实现的期望值计算（与 worker 内部实现互为对照）──────────
const R = 6378137;
const ORIGIN_MX = 1000;
const ORIGIN_MY = 2000;
const PARAMS = {
  west: 10,
  east: 11,
  south: 20,
  north: 21,
  exaggeration: 2,
  radius: R,
  originMx: ORIGIN_MX,
  originMy: ORIGIN_MY,
  addSkirt: false,
  zoom: 5,
};

const MAX_LAT = 85.05112878;
const mercY = (latDeg) => {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg));
  return R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
};
const mercX = (lngDeg) => R * (lngDeg * Math.PI) / 180;

function expectedVertex(i, bounds = PARAMS) {
  const lng = bounds.west + (uVals[i] / 32767) * (bounds.east - bounds.west);
  const lat = bounds.south + (vVals[i] / 32767) * (bounds.north - bounds.south);
  const alt = MIN_H + (hVals[i] / 32767) * (MAX_H - MIN_H);
  return {
    x: mercX(lng) - ORIGIN_MX,
    y: mercY(lat) - ORIGIN_MY,
    z: alt * bounds.exaggeration,
    uvV: (mercY(lat) - mercY(bounds.south)) / (mercY(bounds.north) - mercY(bounds.south)),
  };
}

async function run() {
  const worker = new FakeWorker();
  const done = new Promise((resolve, reject) => {
    worker.onresult = resolve;
    setTimeout(() => reject(new Error("worker timeout")), 3000);
  });
  const buffer = buildTerrainBuffer();
  worker.dispatch({ id: 1, buffer, params: { ...PARAMS, addSkirt: false } });
  const msg = await done;

  assert.equal(msg.ok, true, `worker 返回错误: ${msg.error}\n${msg.stack || ""}`);
  const { positions, uvs, indices, minHeight, maxHeight, vertexCount } = msg.result;
  assert.equal(vertexCount, 4);
  assert.equal(minHeight, MIN_H);
  assert.equal(maxHeight, MAX_H);
  assert.equal(indices.length, 6);
  assert.deepEqual(Array.from(indices), triIndices, "high-water mark 解码应还原原始索引");

  for (let i = 0; i < 4; i++) {
    const exp = expectedVertex(i);
    // positions 为 Float32Array，百万米级坐标的 f32 精度约 0.06m，容差取 0.1m
    assert.ok(Math.abs(positions[i * 3] - exp.x) < 0.1, `v${i}.x ${positions[i * 3]} != ${exp.x}`);
    assert.ok(Math.abs(positions[i * 3 + 1] - exp.y) < 0.1, `v${i}.y 不匹配`);
    assert.ok(Math.abs(positions[i * 3 + 2] - exp.z) < 1e-3, `v${i}.z ${positions[i * 3 + 2]} != ${exp.z}`);
    const expU = uVals[i] / 32767;
    assert.ok(Math.abs(uvs[i * 2] - expU) < 1e-6, `v${i}.u 不匹配`);
    assert.ok(Math.abs(uvs[i * 2 + 1] - exp.uvV) < 1e-5, `v${i}.v 不匹配`);
  }
  console.log("PASS: 解析/投影/索引 (addSkirt=false)");

  // ── 裙边 ──────────────────────────────────────────────
  const done2 = new Promise((resolve, reject) => {
    worker.onresult = resolve;
    setTimeout(() => reject(new Error("worker timeout")), 3000);
  });
  const buffer2 = buildTerrainBuffer();
  worker.dispatch({ id: 2, buffer: buffer2, params: { ...PARAMS, addSkirt: true } });
  const msg2 = await done2;
  assert.equal(msg2.ok, true, `worker 返回错误: ${msg2.error}`);
  const r2 = msg2.result;
  // 4 个顶点全部位于边界；四角顶点各属于两条边 → 裙边顶点数 = sorted 长度（>4）
  assert.equal(r2.vertexCount, 4);
  const skirtCount = r2.positions.length / 3 - 4;
  assert.ok(skirtCount >= 4, `裙边顶点数应 >= 4，实际 ${skirtCount}`);
  assert.equal(r2.uvs.length / 2, 4 + skirtCount);
  assert.equal(r2.indices.length, 6 + (skirtCount - 1) * 6 + 6, "裙边索引数不匹配");
  // 前 4 个顶点与无裙边版本一致
  for (let i = 0; i < 12; i++) {
    assert.ok(Math.abs(r2.positions[i] - positions[i]) < 1e-9, "裙边不应影响原始顶点");
  }
  // 裙边顶点 Z = 对应边界顶点 Z - skirtHeight
  const heightRange = MAX_H - MIN_H;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lodScale = clamp((PARAMS.zoom - 2) / 10, 0.25, 1);
  const skirtHeight = clamp(heightRange * 0.02, 2, 40) * lodScale;
  assert.ok(skirtHeight > 0, "skirtHeight 应为正");
  for (let j = 0; j < skirtCount; j++) {
    const sx = r2.positions[(4 + j) * 3];
    const sy = r2.positions[(4 + j) * 3 + 1];
    const sz = r2.positions[(4 + j) * 3 + 2];
    let matched = false;
    for (let i = 0; i < 4; i++) {
      if (
        Math.abs(sx - r2.positions[i * 3]) < 1e-3 &&
        Math.abs(sy - r2.positions[i * 3 + 1]) < 1e-3
      ) {
        matched = Math.abs(sz - (r2.positions[i * 3 + 2] - skirtHeight)) < 1e-2;
        break;
      }
    }
    assert.ok(matched, `裙边顶点 ${j} 未匹配到边界顶点或下移量不正确`);
  }
  console.log("PASS: 裙边合并 (addSkirt=true)");

  console.log("全部通过 ✔");
}

run().catch((err) => {
  console.error("FAIL:", err?.stack || err?.message || err);
  process.exit(1);
});

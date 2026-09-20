/**
 * 上采样（虚拟细分）测试：验证 terrainWorkerMain 的 upsample 消息路径
 * 与模块级 upsampleTerrainMesh 结果一致，并在平面源网格上验证高程插值精确。
 *
 * 运行：node scripts/test-terrain-upsample.mjs
 */
import assert from "node:assert/strict";
import {
  terrainWorkerMain,
  upsampleTerrainMesh,
} from "../lib/sources/engine/layers/terrainMeshWorker.ts";

// Worker 内部通过 self.__terrainUpsampler__ 取上采样器；Node 下手动桥接
if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
globalThis.self.__terrainUpsampler__ = upsampleTerrainMesh;

class FakeWorker {
  constructor() {
    this.onresult = null;
    terrainWorkerMain(this);
  }
  postMessage(msg) {
    if (this.onresult) this.onresult(msg);
  }
  dispatch(msg) {
    this.onmessage({ data: msg });
  }
}

const R = 6378137;
const DEG = Math.PI / 180;
const mercY = (latDeg) => R * Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2));
const invMercY = (my) => ((2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * 180) / Math.PI;
const mToLng = (m) => (m / R) / DEG;

// ── 1) 平面源网格：z = 10 + 20u + 40v（u/v ∈ [0,1000] 米）──────
// 三角剖分 (0,1,2),(1,3,2) 保持平面性 → 重采样高程应逐点精确
const S = 1000;
const sourcePositions = new Float32Array([
  0, 0, 10,
  S, 0, 30,
  0, S, 50,
  S, S, 70,
]);
const sourceUvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const sourceIndices = new Uint32Array([0, 1, 2, 1, 3, 2]);
const source = { positions: sourcePositions, uvs: sourceUvs, indices: sourceIndices, vertexCount: 4 };

// 子瓦片 = 源的 NE 四分块（投影米坐标 [500,1000]²）
const childParams = {
  west: mToLng(500),
  east: mToLng(1000),
  south: invMercY(500),
  north: invMercY(1000),
  exaggeration: 1,
  radius: R,
  originMx: 0,
  originMy: 0,
  addSkirt: true,
  zoom: 17,
  segments: 16,
};

const expectedZ = (mx, my) => 10 + (20 * mx) / S + (40 * my) / S;

async function run() {
  const worker = new FakeWorker();

  // ── upsample 消息路径（Worker 内调用注入的上采样器）──
  const done = new Promise((resolve, reject) => {
    worker.onresult = resolve;
    setTimeout(() => reject(new Error("worker timeout")), 3000);
  });
  worker.dispatch({ id: 1, type: "upsample", source, params: childParams });
  const msg = await done;
  assert.equal(msg.ok, true, `worker 返回错误: ${msg.error}\n${msg.stack || ""}`);
  const r = msg.result;

  const segments = 16;
  const gridVerts = (segments + 1) * (segments + 1);
  assert.equal(r.vertexCount, gridVerts, "网格顶点数应为 17×17");
  assert.ok(r.positions.length / 3 > gridVerts, "应包含裙边顶点");
  assert.equal(r.indices.length, segments * segments * 6 + (4 * segments - 1) * 6 + 6, "索引数不匹配");

  // 高程逐点精确：网格部分 z = 平面函数
  let maxErr = 0;
  for (let gy = 0; gy <= segments; gy++) {
    for (let gx = 0; gx <= segments; gx++) {
      const i = gy * (segments + 1) + gx;
      const mx = 500 + (gx / segments) * 500;
      const my = 500 + (gy / segments) * 500;
      const err = Math.abs(r.positions[i * 3 + 2] - expectedZ(mx, my));
      maxErr = Math.max(maxErr, err);
    }
  }
  assert.ok(maxErr < 0.01, `平面插值最大误差 ${maxErr} 应 < 0.01m`);
  assert.ok(Math.abs(r.minHeight - 40) < 1e-6, "子块最小高程（SW 角 500,500）");
  assert.ok(Math.abs(r.maxHeight - 70) < 1e-6, "子块最大高程（NE 角 1000,1000）");

  // UV 覆盖 [0,1]，裙边顶点 UV 与边界顶点一致
  for (let i = 0; i < r.uvs.length / 2; i++) {
    assert.ok(r.uvs[i * 2] >= -1e-6 && r.uvs[i * 2] <= 1 + 1e-6, "uv.x 越界");
    assert.ok(r.uvs[i * 2 + 1] >= -1e-6 && r.uvs[i * 2 + 1] <= 1 + 1e-6, "uv.y 越界");
  }
  // 裙边顶点 z 低于对应边界顶点
  for (let i = gridVerts; i < r.positions.length / 3; i++) {
    assert.ok(r.positions[i * 3 + 2] < 70 + 1e-6, "裙边顶点不应高于表面");
  }
  console.log(`PASS: worker upsample 消息路径 + 平面插值精确 (maxErr=${maxErr.toExponential(2)}m)`);

  // ── 与模块级直接调用结果一致（同一份逻辑的两条通道）──
  const direct = upsampleTerrainMesh(source, childParams);
  assert.equal(direct.positions.length, r.positions.length);
  for (let i = 0; i < direct.positions.length; i++) {
    assert.ok(Math.abs(direct.positions[i] - r.positions[i]) < 1e-6, "两条通道 positions 不一致");
  }
  assert.deepEqual(Array.from(direct.indices), Array.from(r.indices), "两条通道 indices 不一致");
  console.log("PASS: worker 注入通道与模块直调结果一致");

  // ── exaggeration 折算：源 z 已含夸张（与真实管线一致），z 保持夸张，
  // min/max 报告原始高程 ──
  const exSource = {
    ...source,
    positions: new Float32Array([0, 0, 20, S, 0, 60, 0, S, 100, S, S, 140]),
  };
  const exParams = { ...childParams, exaggeration: 2 };
  const r2 = upsampleTerrainMesh(exSource, exParams);
  assert.ok(Math.abs(r2.positions[2] - 80) < 1e-6, "z 应含 exaggeration");
  assert.ok(Math.abs(r2.minHeight - 40) < 1e-6, "minHeight 应为原始高程");
  assert.ok(Math.abs(r2.maxHeight - 70) < 1e-6, "maxHeight 应为原始高程");
  console.log("PASS: exaggeration 折算正确");

  // ── UV 不受 originMy 影响（回归：v 曾被 originMy 平移后 clamp 成常量，
  // 渲染成条纹）──
  const shiftedParams = {
    ...childParams,
    originMx: 4000,
    originMy: 3000,
  };
  // 源网格与查询共用同一 origin（与真实管线一致）：源位置 = 绝对坐标 - origin
  const shiftedSource = {
    ...source,
    positions: new Float32Array([
      0 - 4000, 0 - 3000, 10,
      S - 4000, 0 - 3000, 30,
      0 - 4000, S - 3000, 50,
      S - 4000, S - 3000, 70,
    ]),
  };
  const r3 = upsampleTerrainMesh(shiftedSource, shiftedParams);
  const seg = 16;
  let vMin = Infinity;
  let vMax = -Infinity;
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let gy = 0; gy <= seg; gy++) {
    for (let gx = 0; gx <= seg; gx++) {
      const i = gy * (seg + 1) + gx;
      uMin = Math.min(uMin, r3.uvs[i * 2]);
      uMax = Math.max(uMax, r3.uvs[i * 2]);
      vMin = Math.min(vMin, r3.uvs[i * 2 + 1]);
      vMax = Math.max(vMax, r3.uvs[i * 2 + 1]);
    }
  }
  assert.ok(Math.abs(uMin) < 1e-6 && Math.abs(uMax - 1) < 1e-6, `u 应覆盖 [0,1]，实际 [${uMin},${uMax}]`);
  assert.ok(Math.abs(vMin) < 1e-6 && Math.abs(vMax - 1) < 1e-6, `v 应覆盖 [0,1]，实际 [${vMin},${vMax}]（originMy 平移回归）`);
  // UV 与 origin 无关完全一致；位置 = 无偏移结果整体平移 (-originMx, -originMy)
  assert.deepEqual(Array.from(r3.uvs), Array.from(r.uvs), "UV 不应随 origin 变化");
  for (let i = 0; i < r3.positions.length / 3; i++) {
    assert.ok(Math.abs(r3.positions[i * 3] - (r.positions[i * 3] - shiftedParams.originMx)) < 1e-3, "x 应整体平移 -originMx");
    assert.ok(Math.abs(r3.positions[i * 3 + 1] - (r.positions[i * 3 + 1] - shiftedParams.originMy)) < 1e-3, "y 应整体平移 -originMy");
    assert.ok(Math.abs(r3.positions[i * 3 + 2] - r.positions[i * 3 + 2]) < 1e-6, "z 不应随 origin 变化");
  }
  console.log("PASS: UV 与 originMy 无关，位置保持 origin 相对坐标");

  console.log("全部通过 ✔");
}

run().catch((err) => {
  console.error("FAIL:", err?.stack || err?.message || err);
  process.exit(1);
});

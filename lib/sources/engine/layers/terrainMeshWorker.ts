/**
 * 地形网格构建 Worker 池
 *
 * 把 quantized-mesh 解析、顶点展开（Web Mercator 投影 + UV）、裙边合并等
 * CPU 密集型工作从主线程移到 Web Worker，避免每块地形瓦片提交渲染时阻塞
 * 渲染循环造成掉帧。
 *
 * 实现说明：
 * - Worker 通过 Blob URL 创建（经典 Worker），不依赖打包器的 worker 加载
 *   特性，在任何打包配置（webpack / turbopack / 静态导出）下均可工作。
 * - Worker 与主线程之间使用 Transferable 传递 TypedArray，零拷贝。
 * - Worker 不可用时（极少数 CSP 限制环境）调用方应回退到主线程同步路径。
 */

/** 无裙边的基准表面数据：作为"虚拟细分"瓦片的高程采样源 */
export interface TerrainMeshBaseArrays {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

/** Worker 构建结果：可直接用于 BufferGeometry 的顶点数据 */
export interface TerrainMeshArrays {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  minHeight: number;
  maxHeight: number;
  /** 原始顶点数（不含裙边追加的顶点） */
  vertexCount: number;
  /**
   * 基准表面（不含裙边）。裙边三角形是垂直墙面，参与高程插值会在
   * 瓦片边缘采出偏低的高度，因此上采样必须使用无裙边版本。
   * addSkirt=false 时与主体数据相同。
   */
  base?: TerrainMeshBaseArrays;
}

/** 单块瓦片的几何构建参数（均为可序列化普通值） */
export interface TerrainMeshParams {
  west: number;
  east: number;
  south: number;
  north: number;
  exaggeration: number;
  /** 地球半径（WebMercatorGIS.EARTH_RADIUS） */
  radius: number;
  originMx: number;
  originMy: number;
  addSkirt: boolean;
  zoom: number;
}

/**
 * Worker 主体。
 *
 * 注意：本函数会被 `toString()` 序列化为 Worker 脚本源码，因此必须完全
 * 自包含——不能引用任何闭包外的标识符或 import。
 * 导出仅用于测试（在 Node 中直接以进程内方式驱动）。
 */
export function terrainWorkerMain(ctx: {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}): void {
  const MAX_LAT = 85.05112878;
  const PI_4 = Math.PI / 4;
  const DEG = Math.PI / 180;

  interface BuildResult {
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    minHeight: number;
    maxHeight: number;
    vertexCount: number;
    base?: {
      positions: Float32Array;
      uvs: Float32Array;
      indices: Uint32Array;
      vertexCount: number;
    };
  }

  const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

  /** Web Mercator Y（米） */
  const mercY = (latDeg: number, radius: number): number =>
    radius * Math.log(Math.tan(PI_4 + (clamp(latDeg, -MAX_LAT, MAX_LAT) * DEG) / 2));

  function decodeChannel(
    view: DataView,
    offset: number,
    count: number,
    out: Uint16Array,
  ): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const encoded = view.getUint16(offset, true);
      offset += 2;
      const delta = (encoded >> 1) ^ -(encoded & 1);
      value += delta;
      out[i] = value;
    }
    return offset;
  }

  function decodeIndices(encoded: Uint16Array | Uint32Array): Uint32Array {
    const decoded = new Uint32Array(encoded.length);
    let highest = 0;
    for (let i = 0; i < encoded.length; i++) {
      const code = encoded[i];
      if (code === 0) {
        decoded[i] = highest;
        highest++;
      } else {
        decoded[i] = highest - code;
      }
    }
    return decoded;
  }

  function parseQuantizedMesh(buffer: ArrayBuffer): {
    minHeight: number;
    maxHeight: number;
    vertexCount: number;
    u: Uint16Array;
    v: Uint16Array;
    height: Uint16Array;
    indices: Uint32Array;
  } {
    const view = new DataView(buffer);
    const minHeight = view.getFloat32(24, true);
    const maxHeight = view.getFloat32(28, true);
    let offset = 88;

    const vertexCount = view.getUint32(offset, true);
    offset += 4;

    const u = new Uint16Array(vertexCount);
    const v = new Uint16Array(vertexCount);
    const height = new Uint16Array(vertexCount);
    offset = decodeChannel(view, offset, vertexCount, u);
    offset = decodeChannel(view, offset, vertexCount, v);
    offset = decodeChannel(view, offset, vertexCount, height);

    let indices: Uint32Array;
    if (vertexCount > 65536) {
      if (offset % 4 !== 0) offset += 2;
      const triangleCount = view.getUint32(offset, true);
      offset += 4;
      const indexCount = triangleCount * 3;
      const encoded = new Uint32Array(indexCount);
      for (let i = 0; i < indexCount; i++) {
        encoded[i] = view.getUint32(offset + i * 4, true);
      }
      indices = decodeIndices(encoded);
    } else {
      if (offset % 2 !== 0) offset += 1;
      const triangleCount = view.getUint32(offset, true);
      offset += 4;
      const indexCount = triangleCount * 3;
      const encoded = new Uint16Array(indexCount);
      for (let i = 0; i < indexCount; i++) {
        encoded[i] = view.getUint16(offset + i * 2, true);
      }
      indices = decodeIndices(encoded);
    }
    return { minHeight, maxHeight, vertexCount, u, v, height, indices };
  }

  function build(buffer: ArrayBuffer, p: {
    west: number;
    east: number;
    south: number;
    north: number;
    exaggeration: number;
    radius: number;
    originMx: number;
    originMy: number;
    addSkirt: boolean;
    zoom: number;
  }): BuildResult {
    const decoded = parseQuantizedMesh(buffer);
    const { vertexCount, u, v, height, indices, minHeight, maxHeight } = decoded;
    if (vertexCount === 0) throw new Error("Empty quantized-mesh vertex data.");

    const heightRange = maxHeight - minHeight;
    const southM = mercY(p.south, p.radius);
    const northM = mercY(p.north, p.radius);
    const mercRange = Math.max(northM - southM, 1e-9);

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);

    // 顶点展开：内联 Mercator 数学，避免主线程版本每顶点的对象分配
    for (let i = 0; i < vertexCount; i++) {
      const lng = p.west + (u[i] / 32767) * (p.east - p.west);
      const lat = p.south + (v[i] / 32767) * (p.north - p.south);
      let alt = minHeight + (height[i] / 32767) * heightRange;
      if (p.exaggeration !== 1) alt *= p.exaggeration;

      const mx = p.radius * lng * DEG;
      const my = mercY(lat, p.radius);
      positions[i * 3] = mx - p.originMx;
      positions[i * 3 + 1] = my - p.originMy;
      positions[i * 3 + 2] = alt;

      uvs[i * 2] = u[i] / 32767;
      uvs[i * 2 + 1] = clamp((my - southM) / mercRange, 0, 1);
    }

    if (!p.addSkirt) {
      // 无裙边时主体数据即基准表面
      return { positions, uvs, indices, minHeight, maxHeight, vertexCount, base: { positions, uvs, indices, vertexCount } };
    }

    // ── 裙边（与主线程 addSkirt 逻辑一致，直接操作 TypedArray）──
    const edgeVerts: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const uu = uvs[i * 2];
      const vv = uvs[i * 2 + 1];
      if (uu < 0.001 || uu > 0.999 || vv < 0.001 || vv > 0.999) edgeVerts.push(i);
    }
    if (edgeVerts.length < 4) {
      return { positions, uvs, indices, minHeight, maxHeight, vertexCount, base: { positions, uvs, indices, vertexCount } };
    }

    const bottom: number[] = [];
    const right: number[] = [];
    const top: number[] = [];
    const left: number[] = [];
    for (const i of edgeVerts) {
      const uu = uvs[i * 2];
      const vv = uvs[i * 2 + 1];
      if (vv < 0.001) bottom.push(i);
      else if (uu > 0.999) right.push(i);
      else if (vv > 0.999) top.push(i);
      else if (uu < 0.001) left.push(i);
    }
    bottom.sort((a, b) => uvs[a * 2] - uvs[b * 2]);
    right.sort((a, b) => uvs[a * 2 + 1] - uvs[b * 2 + 1]);
    top.sort((a, b) => uvs[b * 2] - uvs[a * 2]);
    left.sort((a, b) => uvs[b * 2 + 1] - uvs[a * 2 + 1]);
    const sorted = [...bottom, ...right, ...top, ...left];
    if (sorted.length < 4) {
      return { positions, uvs, indices, minHeight, maxHeight, vertexCount, base: { positions, uvs, indices, vertexCount } };
    }

    const lodScale = clamp((p.zoom - 2) / 10, 0.25, 1);
    const skirtHeight = clamp(heightRange * 0.02, 2, 40) * lodScale;
    const skirtCount = sorted.length;
    const base = vertexCount;

    const totalPositions = new Float32Array((vertexCount + skirtCount) * 3);
    totalPositions.set(positions);
    for (let i = 0; i < skirtCount; i++) {
      const vi = sorted[i];
      totalPositions[(base + i) * 3] = positions[vi * 3];
      totalPositions[(base + i) * 3 + 1] = positions[vi * 3 + 1];
      totalPositions[(base + i) * 3 + 2] = positions[vi * 3 + 2] - skirtHeight;
    }

    const totalUvs = new Float32Array((vertexCount + skirtCount) * 2);
    totalUvs.set(uvs);
    for (let i = 0; i < skirtCount; i++) {
      const vi = sorted[i];
      totalUvs[(base + i) * 2] = uvs[vi * 2];
      totalUvs[(base + i) * 2 + 1] = uvs[vi * 2 + 1];
    }

    const skirtIndexCount = (skirtCount - 1) * 6 + 6;
    const totalIndices = new Uint32Array(indices.length + skirtIndexCount);
    totalIndices.set(indices);
    let o = indices.length;
    for (let i = 0; i < skirtCount - 1; i++) {
      const topA = sorted[i];
      const topB = sorted[i + 1];
      const botA = base + i;
      const botB = base + i + 1;
      totalIndices[o++] = topA;
      totalIndices[o++] = botA;
      totalIndices[o++] = topB;
      totalIndices[o++] = topB;
      totalIndices[o++] = botA;
      totalIndices[o++] = botB;
    }
    const last = skirtCount - 1;
    totalIndices[o++] = sorted[last];
    totalIndices[o++] = base + last;
    totalIndices[o++] = sorted[0];
    totalIndices[o++] = sorted[0];
    totalIndices[o++] = base + last;
    totalIndices[o++] = base;

    return {
      positions: totalPositions,
      uvs: totalUvs,
      indices: totalIndices,
      minHeight,
      maxHeight,
      vertexCount,
      // 裙边之前的原始表面（与主体不同 buffer），供上采样使用
      base: { positions, uvs, indices, vertexCount },
    };
  }

  ctx.onmessage = (event: { data: unknown }) => {
    const msg = event.data as {
      id: number;
      type?: "build" | "upsample";
      buffer?: ArrayBuffer;
      source?: TerrainMeshBaseArrays;
      params: TerrainMeshParams & { segments?: number };
    };
    try {
      let result: BuildResult;
      if (msg.type === "upsample") {
        // 上采样器由池在 Worker 脚本前缀中注入（self.__terrainUpsampler__）
        const upsampler = (
          self as unknown as {
            __terrainUpsampler__?: (
              source: TerrainMeshBaseArrays,
              params: TerrainMeshParams & { segments?: number },
            ) => BuildResult;
          }
        ).__terrainUpsampler__;
        if (!upsampler || !msg.source) {
          throw new Error("Upsample function is unavailable in worker.");
        }
        result = upsampler(msg.source, msg.params);
      } else {
        if (!msg.buffer) throw new Error("Missing terrain buffer.");
        result = build(msg.buffer, msg.params);
      }
      const transfer: Transferable[] = [
        result.positions.buffer as ArrayBuffer,
        result.uvs.buffer as ArrayBuffer,
        result.indices.buffer as ArrayBuffer,
      ];
      const base = result.base;
      if (base && base.positions.buffer !== result.positions.buffer) {
        transfer.push(
          base.positions.buffer as ArrayBuffer,
          base.uvs.buffer as ArrayBuffer,
          base.indices.buffer as ArrayBuffer,
        );
      }
      ctx.postMessage({ id: msg.id, ok: true, result }, transfer);
    } catch (err: unknown) {
      ctx.postMessage({
        id: msg.id,
        ok: false,
        error: String((err as Error | null)?.message ?? err),
        stack: String((err as Error | null)?.stack ?? ""),
      });
    }
  };
}

interface PendingJob {
  resolve: (result: TerrainMeshArrays) => void;
  reject: (error: Error) => void;
}

/**
 * 上采样：从一块已解码的基准网格（无裙边）按子瓦片地理范围重采样出
 * 规则网格，供 availability 之下的"虚拟细分"瓦片使用——不发地形请求，
 * 高程由源三角形重心插值得到（与 Cesium UpsampledTerrainProvider 等价）。
 *
 * 注意：本函数会被 `toString()` 序列化注入 Worker，必须完全自包含。
 */
export function upsampleTerrainMesh(
  source: TerrainMeshBaseArrays,
  p: TerrainMeshParams & { segments?: number },
): TerrainMeshArrays {
  const MAX_LAT = 85.05112878;
  const DEG = Math.PI / 180;
  const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
  const mercY = (latDeg: number, radius: number): number =>
    radius * Math.log(Math.tan(Math.PI / 4 + (clamp(latDeg, -MAX_LAT, MAX_LAT) * DEG) / 2));

  const triCount = (source.indices.length / 3) | 0;
  if (triCount < 1 || source.vertexCount < 3) {
    throw new Error("Empty source mesh for upsample.");
  }
  const segments = Math.max(2, Math.min(64, Math.floor(p.segments ?? 16)));
  const gridVerts = (segments + 1) * (segments + 1);
  const sp = source.positions;
  const si = source.indices;

  // 源三角形按均匀网格分桶，把逐点三角搜索降到 O(1)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < source.vertexCount; i++) {
    const x = sp[i * 3];
    const y = sp[i * 3 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const binCols = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(triCount / 4))));
  const cellW = spanX / binCols;
  const cellH = spanY / binCols;
  const bins: number[][] = new Array(binCols * binCols);
  for (let t = 0; t < triCount; t++) {
    const i0 = si[t * 3] * 3;
    const i1 = si[t * 3 + 1] * 3;
    const i2 = si[t * 3 + 2] * 3;
    const cx0 = Math.max(0, Math.floor((Math.min(sp[i0], sp[i1], sp[i2]) - minX) / cellW));
    const cx1 = Math.min(binCols - 1, Math.floor((Math.max(sp[i0], sp[i1], sp[i2]) - minX) / cellW));
    const cy0 = Math.max(0, Math.floor((Math.min(sp[i0 + 1], sp[i1 + 1], sp[i2 + 1]) - minY) / cellH));
    const cy1 = Math.min(
      binCols - 1,
      Math.floor((Math.max(sp[i0 + 1], sp[i1 + 1], sp[i2 + 1]) - minY) / cellH),
    );
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const idx = cy * binCols + cx;
        (bins[idx] ?? (bins[idx] = [])).push(t);
      }
    }
  }

  /** 在源三角网表面上线性插值 (mx, my) 处的高程（投影米坐标） */
  const sampleHeight = (mx: number, my: number): number => {
    const qx = clamp(mx, minX, maxX);
    const qy = clamp(my, minY, maxY);
    const cx = clamp(Math.floor((qx - minX) / cellW), 0, binCols - 1);
    const cy = clamp(Math.floor((qy - minY) / cellH), 0, binCols - 1);
    for (let radius = 0; radius <= 2; radius++) {
      const x0 = Math.max(0, cx - radius);
      const x1 = Math.min(binCols - 1, cx + radius);
      const y0 = Math.max(0, cy - radius);
      const y1 = Math.min(binCols - 1, cy + radius);
      for (let by = y0; by <= y1; by++) {
        for (let bx = x0; bx <= x1; bx++) {
          const bin = bins[by * binCols + bx];
          if (!bin) continue;
          for (const t of bin) {
            const i0 = si[t * 3] * 3;
            const i1 = si[t * 3 + 1] * 3;
            const i2 = si[t * 3 + 2] * 3;
            const ax = sp[i0];
            const ay = sp[i0 + 1];
            const az = sp[i0 + 2];
            const bx = sp[i1];
            const byy = sp[i1 + 1];
            const bz = sp[i1 + 2];
            const cx2 = sp[i2];
            const cy2 = sp[i2 + 1];
            const cz = sp[i2 + 2];
            const det = (bx - ax) * (cy2 - ay) - (byy - ay) * (cx2 - ax);
            if (Math.abs(det) < 1e-9) continue;
            const w1 = ((qx - ax) * (cy2 - ay) - (qy - ay) * (cx2 - ax)) / det;
            const w2 = ((bx - ax) * (qy - ay) - (byy - ay) * (qx - ax)) / det;
            const w0 = 1 - w1 - w2;
            if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
            return w0 * az + w1 * bz + w2 * cz;
          }
        }
      }
    }
    return NaN;
  };

  const southM = mercY(p.south, p.radius);
  const northM = mercY(p.north, p.radius);
  const mercRange = Math.max(northM - southM, 1e-9);
  const invExag = p.exaggeration !== 0 ? 1 / p.exaggeration : 1;

  const positions = new Float32Array(gridVerts * 3);
  const uvs = new Float32Array(gridVerts * 2);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let lastZ = 0;
  for (let gy = 0; gy <= segments; gy++) {
    const lat = p.south + (gy / segments) * (p.north - p.south);
    // UV 必须用绝对 Mercator Y（与 build 一致）；位置坐标再减去 originMy
    const myAbs = mercY(lat, p.radius);
    const my = myAbs - p.originMy;
    for (let gx = 0; gx <= segments; gx++) {
      const lng = p.west + (gx / segments) * (p.east - p.west);
      const mx = p.radius * lng * DEG - p.originMx;
      let z = sampleHeight(mx, my);
      if (!Number.isFinite(z)) z = lastZ;
      lastZ = z;
      const i = gy * (segments + 1) + gx;
      positions[i * 3] = mx;
      positions[i * 3 + 1] = my;
      positions[i * 3 + 2] = z;
      const alt = z * invExag;
      if (alt < minHeight) minHeight = alt;
      if (alt > maxHeight) maxHeight = alt;
      uvs[i * 2] = gx / segments;
      uvs[i * 2 + 1] = clamp((myAbs - southM) / mercRange, 0, 1);
    }
  }

  const indices = new Uint32Array(segments * segments * 6);
  let o = 0;
  for (let gy = 0; gy < segments; gy++) {
    for (let gx = 0; gx < segments; gx++) {
      const a = gy * (segments + 1) + gx;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices[o++] = a;
      indices[o++] = b;
      indices[o++] = d;
      indices[o++] = a;
      indices[o++] = d;
      indices[o++] = c;
    }
  }

  if (p.addSkirt) {
    // 边界环：底行(西→东)、右列(南→北)、顶行(东→西)、左列(北→南)，
    // 顺序与 build 的裙边排序约定一致，保证环向三角化闭合
    const sorted: number[] = [];
    for (let gx = 0; gx <= segments; gx++) sorted.push(gx);
    for (let gy = 1; gy <= segments; gy++) sorted.push(gy * (segments + 1) + segments);
    for (let gx = segments - 1; gx >= 0; gx--) sorted.push(segments * (segments + 1) + gx);
    for (let gy = segments - 1; gy >= 1; gy--) sorted.push(gy * (segments + 1));

    const lodScale = clamp((p.zoom - 2) / 10, 0.25, 1);
    const skirtHeight = clamp((maxHeight - minHeight) * 0.02, 2, 40) * lodScale;
    const skirtCount = sorted.length;
    const base2 = gridVerts;

    const totalPositions = new Float32Array((gridVerts + skirtCount) * 3);
    totalPositions.set(positions);
    for (let i = 0; i < skirtCount; i++) {
      const vi = sorted[i];
      totalPositions[(base2 + i) * 3] = positions[vi * 3];
      totalPositions[(base2 + i) * 3 + 1] = positions[vi * 3 + 1];
      totalPositions[(base2 + i) * 3 + 2] = positions[vi * 3 + 2] - skirtHeight;
    }
    const totalUvs = new Float32Array((gridVerts + skirtCount) * 2);
    totalUvs.set(uvs);
    for (let i = 0; i < skirtCount; i++) {
      const vi = sorted[i];
      totalUvs[(base2 + i) * 2] = uvs[vi * 2];
      totalUvs[(base2 + i) * 2 + 1] = uvs[vi * 2 + 1];
    }
    const skirtIndexCount = (skirtCount - 1) * 6 + 6;
    const totalIndices = new Uint32Array(indices.length + skirtIndexCount);
    totalIndices.set(indices);
    let so = indices.length;
    for (let i = 0; i < skirtCount - 1; i++) {
      const topA = sorted[i];
      const topB = sorted[i + 1];
      const botA = base2 + i;
      const botB = base2 + i + 1;
      totalIndices[so++] = topA;
      totalIndices[so++] = botA;
      totalIndices[so++] = topB;
      totalIndices[so++] = topB;
      totalIndices[so++] = botA;
      totalIndices[so++] = botB;
    }
    const last = skirtCount - 1;
    totalIndices[so++] = sorted[last];
    totalIndices[so++] = base2 + last;
    totalIndices[so++] = sorted[0];
    totalIndices[so++] = sorted[0];
    totalIndices[so++] = base2 + last;
    totalIndices[so++] = base2;

    return {
      positions: totalPositions,
      uvs: totalUvs,
      indices: totalIndices,
      minHeight,
      maxHeight,
      vertexCount: gridVerts,
      base: { positions, uvs, indices, vertexCount: gridVerts },
    };
  }

  return {
    positions,
    uvs,
    indices,
    minHeight,
    maxHeight,
    vertexCount: gridVerts,
    base: { positions, uvs, indices, vertexCount: gridVerts },
  };
}

/**
 * 地形网格 Worker 池。Worker 不可用时 `available === false`，
 * 调用方回退到主线程同步构建。
 */
export class TerrainMeshWorkerPool {
  readonly available = false;

  private workers: Worker[] = [];
  private blobUrl: string | null = null;
  private pending = new Map<number, PendingJob>();
  private nextId = 1;
  private roundRobin = 0;

  constructor(poolSize: number) {
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
      return;
    }
    if (poolSize < 1) return;

    let url: string;
    try {
      // 先注入上采样器（terrainWorkerMain 内部通过 self.__terrainUpsampler__ 取用），
      // 再启动 Worker 主体；两个函数都自包含，可安全 toString 序列化
      const source = `self.__terrainUpsampler__ = ${upsampleTerrainMesh.toString()};(${terrainWorkerMain.toString()})(self);`;
      url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    } catch {
      return;
    }

    const spawned: Worker[] = [];
    for (let i = 0; i < poolSize; i++) {
      try {
        spawned.push(this.spawn(url));
      } catch {
        break;
      }
    }
    if (spawned.length === 0) {
      URL.revokeObjectURL(url);
      return;
    }
    this.blobUrl = url;
    (this as { available: boolean }).available = true;
    this.workers = spawned;
  }

  private spawn(url: string): Worker {
    const worker = new Worker(url);
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as {
        id: number;
        ok: boolean;
        result?: TerrainMeshArrays;
        error?: string;
      };
      const job = this.pending.get(msg.id);
      if (!job) return; // 已被取消
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) {
        job.resolve(msg.result);
      } else {
        job.reject(new Error(msg.error || "Terrain mesh worker failed."));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      // 拒绝所有在该 worker 上等待的任务
      for (const [id, job] of this.pending) {
        job.reject(new Error(event.message || "Terrain mesh worker crashed."));
        this.pending.delete(id);
      }
    };
    return worker;
  }

  /**
   * 构建一块瓦片的网格数据。
   * 注意：成功时 `buffer` 的所有权被转移到 Worker。
   */
  build(buffer: ArrayBuffer, params: TerrainMeshParams): Promise<TerrainMeshArrays> {
    if (!this.available || this.workers.length === 0) {
      // buffer 未被转移，调用方可安全回退到同步路径
      return Promise.reject(new Error("Terrain mesh worker pool is unavailable."));
    }
    const id = this.nextId++;
    const worker = this.workers[this.roundRobin++ % this.workers.length];
    return new Promise<TerrainMeshArrays>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type: "build", buffer, params }, [buffer]);
    });
  }

  /**
   * 上采样：从源基准网格（无裙边）重采样出子瓦片网格。
   * source 会被结构化克隆（不 transfer，源几何仍被 BufferGeometry 引用）。
   */
  upsample(
    source: TerrainMeshBaseArrays,
    params: TerrainMeshParams & { segments?: number },
  ): Promise<TerrainMeshArrays> {
    if (!this.available || this.workers.length === 0) {
      return Promise.reject(new Error("Terrain mesh worker pool is unavailable."));
    }
    const id = this.nextId++;
    const worker = this.workers[this.roundRobin++ % this.workers.length];
    return new Promise<TerrainMeshArrays>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type: "upsample", source, params });
    });
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    (this as { available: boolean }).available = false;
    for (const [, job] of this.pending) {
      job.reject(new Error("Terrain mesh worker pool disposed."));
    }
    this.pending.clear();
  }
}

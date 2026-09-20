import * as THREE from "three";
import { WEB_MERCATOR_MAX_LATITUDE, WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { getTileBounds } from "../utils/gis-utils";
import { requestScheduler } from "./RequestScheduler";
import {
  DEFAULT_TILE_SUBDOMAINS,
  getTileRequestGroup,
  replaceTileTemplate,
} from "./TileUrlTemplate";
import type { TerrainMeshArrays, TerrainMeshBaseArrays } from "./terrainMeshWorker";
import { TerrainMeshWorkerPool, upsampleTerrainMesh } from "./terrainMeshWorker";
import { ImageryStitchPool } from "./imageryStitchWorker";
import type { TileDiskCache } from "./TileDiskCache";
import { getTileDiskCache } from "./TileDiskCache";

type TileKey = string;

export type TerrainTileYOrigin = "north" | "south" | "auto";

// Visible imagery should not wait behind the terrain prefetch queue.
const IMAGERY_REQUEST_PRIORITY_OFFSET = -1_000_000;
const LEVEL_ZERO_GEOMETRIC_ERROR = 78271.516964;
const TERRAIN_FALLBACK_COLOR = 0x6f786f;

/**
 * 调试着色模式（debugColorByZoom）的层级调色板。
 *
 * 色相 = 层级，明度 = 瓦片个体。开这个模式就不请求、不拼接任何影像，
 * 地形网格一就绪即以纯色上屏，于是截图里一眼可判：
 *   - 某片区域是什么颜色 → 该像素实际由哪一级瓦片绘制；
 *   - 出现粗层级色块 → 那里的精细瓦片没被选中/没上屏（糊斑来源）；
 *   - 同色块内部的深浅交界面 → 同层级瓦片的边界。
 * 因为省掉了影像网络往返，"瓦片选择对不对"这件事的验证速度远快于看真实影像。
 */
/**
 * 层级配色表。两条硬约束（改色值时必须同时满足）：
 *   1. **任意两级颜色互不相同，且 RGB 欧氏距离 ≥ 60**。曾经 z6 与 z16 是同一个
 *      色值（距离 0），另有 27 对距离 <90 —— 于是截图里的碎色块无法反查层级，
 *      判定只能靠猜。当前表最小间距 69.9（z11 vs z13，两个都是"招牌色"，保留），
 *      仅此一对低于 70。
 *   2. 避开场景背景色 0x1a1a1a 与无影像兜底色 0x6f786f（否则会把背景/兜底像素
 *      误判成某个层级）。
 * z9~z15、z18 保持"招牌色"（蓝/绿/黄/红/橙/粉/青/黄绿）便于人工比对，
 * 其余层级由约束搜索分配。scripts/analyze-shot-colors.cjs 用同一张表反查截图。
 */
const DEBUG_ZOOM_COLORS: Record<number, number> = {
  0: 0x030396,
  1: 0x8e05f0,
  2: 0x73fcfc,
  3: 0xb8e28d,
  4: 0x960303,
  5: 0xb873fc,
  6: 0x96037d,
  7: 0xfa19fa,
  8: 0x039603,
  9: 0x3b82f6,
  10: 0x22c55e,
  11: 0xfacc15,
  12: 0xef4444,
  13: 0xfb923c,
  14: 0xec4899,
  15: 0x14b8a6,
  16: 0x1919fa,
  17: 0x966503,
  18: 0x84cc16,
  19: 0x2cf005,
  20: 0x55fc9a,
};

/**
 * 层级 → 调试色；未配色层级按黄金角生成色相，同层相邻瓦片按坐标抖动明度。
 *
 * 抖动量固定为 -4% / 0 / +4% 三档：要保证"渲染出来的颜色仍离自己的基准色更近"，
 * 抖动引起的 RGB 位移（≤18）必须显著小于色表最小间距（69.9），否则截图像素
 * 反查层级会串级。
 */
function debugZoomColorHex(zoom: number, x = 0, y = 0): number {
  const preset = DEBUG_ZOOM_COLORS[zoom];
  const color = new THREE.Color();
  if (preset === undefined) {
    color.setHSL(((zoom * 137.508) % 360) / 360, 0.72, 0.52);
  } else {
    color.setHex(preset);
  }
  // 明度抖动让"同一层级铺了几块瓦片"也能数出来（色相仍严格对应层级）。
  const hash = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  color.offsetHSL(0, 0, ((hash % 3) - 1) * 0.04);
  return color.getHex();
}

// 非生产环境自检：色表出现重复/过近的色值会让截图反查层级失效，启动时直接告警。
if (process.env.NODE_ENV !== "production") {
  const entries = Object.entries(DEBUG_ZOOM_COLORS).map(([z, hex]) => ({ z: Number(z), hex }));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i].hex;
      const b = entries[j].hex;
      const d = Math.hypot(
        ((a >> 16) & 255) - ((b >> 16) & 255),
        ((a >> 8) & 255) - ((b >> 8) & 255),
        (a & 255) - (b & 255),
      );
      if (d < 60) {
        console.warn(
          `[terrain] 层级调试色过近：z${entries[i].z} 与 z${entries[j].z} 距离 ${d.toFixed(1)}（需 ≥60），截图反查层级会串级`,
        );
      }
    }
  }
}

/** 地形瓦片缓存默认 256MB（单块约 65KB，约 4000 块）。 */
const DEFAULT_TERRAIN_DISK_CACHE_BYTES = 256 * 1024 * 1024;
/** 影像瓦片缓存默认 128MB。 */
const DEFAULT_IMAGERY_DISK_CACHE_BYTES = 128 * 1024 * 1024;
/** 下一级预取：排在底图毯之后的最低优先级。 */
const PREFETCH_PRIORITY = Number.MAX_SAFE_INTEGER - 1;
/** 同时最多在途的预取请求数。 */
const MAX_PREFETCH_IN_FLIGHT = 4;
/** 单次会话最多预取的瓦片数（防止长时间挂机产生无界后台流量）。 */
const MAX_PREFETCH_TOTAL = 1024;
/** 虚拟细分瓦片网格的每边分段数（17×17 顶点，512 三角形）。 */
const VIRTUAL_TILE_SEGMENTS = 16;
/** 上采样源网格缓存上限（存无裙边基准网格，约 0.5MB/块）。 */
const MESH_SOURCE_CACHE_MAX = 48;
/**
 * 遮挡判定向上标记祖先的最大层数。
 *
 * 必须 ≥ 场景里"最细瓦片 − 最粗底图毯"的最大层级差，否则最深处的可渲染
 * 瓦片够不到最粗的祖先：那些祖先没被标记"已被覆盖"，保留 depthWrite=true，
 * 其稀疏采样的巨大三角弦在几何上悬在精细表面上方，深度测试获胜后直接把
 * 后绘制的精细瓦片盖掉（表现为"明明有高等级瓦片，却被低等级斑块覆盖"）。
 * 实测 z5 底图毯 + z18~z20 精细瓦片的场景层级差达 13~15 级，12 层不够。
 * 每帧代价 = O(可渲染瓦片数 × 24) ≈ 数千次集合插入，可忽略。
 */
const MAX_ANCESTOR_WALK = 24;
/**
 * 象限覆盖判定的每帧节点预算。超出后一律判“未覆盖”（保守保留粗瓦片），
 * 保证倾斜视角 + 大视野下单帧遮挡判定工作量有硬上限。
 */
const MAX_OCCLUSION_NODES = 4096;

// ─── Cesium Geographic Tiling Scheme (EPSG:4326) ─────────────────
// Cesium Terrain 使用地理坐标系切片：
//   zoom 0: X 方向 2 块, Y 方向 1 块
//   zoom n: X 方向 2^(n+1) 块, Y 方向 2^n 块

/** 经纬度转服务瓦片编号；TMS 从南向北，slippyMap 从北向南。 */
function lngLatToGeoTile(
  lng: number,
  lat: number,
  zoom: number,
  yOrigin: "north" | "south",
): { x: number; y: number } {
  const numX = Math.pow(2, zoom + 1);
  const numY = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * numX);
  const y =
    yOrigin === "north"
      ? Math.floor(((90 - lat) / 180) * numY)
      : Math.floor(((lat + 90) / 180) * numY);
  return {
    x: Math.max(0, Math.min(numX - 1, x)),
    y: Math.max(0, Math.min(numY - 1, y)),
  };
}

/** 按服务行号方向计算瓦片范围；quantized-mesh 顶点 v 始终向北。 */
function geoTileBounds(x: number, y: number, zoom: number, yOrigin: "north" | "south") {
  const numX = Math.pow(2, zoom + 1);
  const numY = Math.pow(2, zoom);
  const west = (x / numX) * 360 - 180;
  const east = ((x + 1) / numX) * 360 - 180;
  const north = yOrigin === "north" ? 90 - (y / numY) * 180 : ((y + 1) / numY) * 180 - 90;
  const south = yOrigin === "north" ? 90 - ((y + 1) / numY) * 180 : (y / numY) * 180 - 90;
  return { west, east, south, north };
}

// ─── quantized-mesh 解码 ─────────────────────────────────────────

interface QuantizedMeshData {
  minHeight: number;
  maxHeight: number;
  vertexCount: number;
  u: Uint16Array;
  v: Uint16Array;
  height: Uint16Array;
  indices: Uint32Array;
}

/**
 * 解析 Cesium quantized-mesh 二进制格式
 * 所有数值为 little-endian
 */
function parseQuantizedMesh(buffer: ArrayBuffer): QuantizedMeshData {
  const view = new DataView(buffer);
  let offset = 0;

  // Header: 88 bytes
  // centerX(f64×3) + minHeight(f32) + maxHeight(f32) + boundingSphere(f64×4) + horizonOcclusion(f64×3)
  const minHeight = view.getFloat32(offset + 24, true);
  const maxHeight = view.getFloat32(offset + 28, true);
  offset += 88;

  // Vertex data
  const vertexCount = view.getUint32(offset, true);
  offset += 4;

  const u = new Uint16Array(vertexCount);
  const v = new Uint16Array(vertexCount);
  const height = new Uint16Array(vertexCount);

  // u, v, height 各自是 zigzag + delta 编码
  offset = decodeVertexChannel(view, offset, vertexCount, u);
  offset = decodeVertexChannel(view, offset, vertexCount, v);
  offset = decodeVertexChannel(view, offset, vertexCount, height);

  // Indices
  if (vertexCount > 65536) {
    if (offset % 4 !== 0) offset += 2;
    const triangleCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = triangleCount * 3;
    const encoded = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      encoded[i] = view.getUint32(offset + i * 4, true);
    }
    const indices = decodeIndices(encoded);
    return { minHeight, maxHeight, vertexCount, u, v, height, indices };
  } else {
    if (offset % 2 !== 0) offset += 1;
    const triangleCount = view.getUint32(offset, true);
    offset += 4;
    const indexCount = triangleCount * 3;
    const encoded = new Uint16Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      encoded[i] = view.getUint16(offset + i * 2, true);
    }
    const indices = decodeIndices(encoded);
    return { minHeight, maxHeight, vertexCount, u, v, height, indices };
  }
}

/** 解码顶点通道（zigzag + delta） */
function decodeVertexChannel(
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

/** 解码索引（high-water mark 编码） */
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

// ─── 配置 ────────────────────────────────────────────────────────

export interface CesiumTerrainLayerOptions {
  /** 本图层最多同时在途的地形请求数；共享调度器仍按 origin 限制网络并发。 */
  maxConcurrent?: number;
  /** 等待队列容量（默认128） */
  maxQueueSize?: number;
  /** 每帧最多新发起请求数（默认8） */
  maxRequestsPerFrame?: number;
  /** Number of terrain meshes committed to the scene per frame. */
  maxTileRendersPerFrame?: number;
  /** 最低地形层级（默认0） */
  minZoom?: number;
  /** 最大地形层级（默认13，Cesium World Terrain 最高约 15） */
  maxZoom?: number;
  /** 最大LOD降级层数（默认2） */
  maxLodLevels?: number;
  /** 单次视图最多选择的地形瓦片数（默认512）。 */
  maxTilesPerView?: number;
  /** 瓦片屏幕尺寸超过该像素值后继续细分（默认256）。 */
  terrainTilePixelSize?: number;
  /** Cesium 对应的 maximumScreenSpaceError（默认2）。 */
  maximumScreenSpaceError?: number;
  /** LRU缓存最大瓦片数（默认96） */
  maxCacheSize?: number;
  /** 地形夸张系数（默认1.0） */
  exaggeration?: number;
  /** 使用线框材质显示地形三角网，便于检查分层与缺口。 */
  wireframe?: boolean;
  /**
   * 调试着色模式：**不绘制影像**，瓦片按层级着纯色（色相=层级，明度=瓦片个体）。
   *
   * 用于把"瓦片选择/覆盖是否正确"变成肉眼可判的图：截图里同色=同层级，
   * 出现粗层级色块即说明该区域的精细瓦片没被选中或没上屏。
   * 该模式下不请求、不拼接任何影像，地形网格一就绪即上屏，验证速度最快；
   * 运行时也可用 `setDebugColorMode()` 随时开关（关掉后自动补拉影像）。
   */
  debugColorByZoom?: boolean;
  /** 影像URL模板（贴在地形上的卫星图，可选） */
  imageryUrlTemplate?: string;
  /** 影像 {s} 子域列表；Google 默认使用 0-3。 */
  imagerySubdomains?: readonly string[];
  /** 多子域影像统一限流组；未设置时根据含 {s} 的 URL 模板自动生成。 */
  imageryRequestGroup?: string;
  /** 影像统一限流组的最大并发；默认沿用 RequestScheduler 的每服务器并发。 */
  imageryMaximumRequestsPerServer?: number;
  /** auto 读取 layer.json 的 scheme；无元数据时保留 TMS（south）行为。 */
  tileYOrigin?: TerrainTileYOrigin;
  /** Geographic 地形相对 Web Mercator 影像的级别偏移，默认 -1。 */
  terrainZoomOffset?: number;
  /** 目标地形瓦片的影像拼接画布上限，默认 2048；父级 fallback 固定使用 512。 */
  imageryMaxCanvasSize?: number;
  /** 地形表面影像相对地形级别的额外请求偏移，默认 0。 */
  imageryZoomOffset?: number;
  /** 地形请求的每服务器并发上限；默认沿用调度器的 6。 */
  maximumRequestsPerServer?: number;
  /** 地形 .terrain 字节的持久化缓存预算（字节），默认 256MB；0 关闭。 */
  terrainDiskCacheBytes?: number;
  /** 影像瓦片的持久化缓存预算（字节），默认 128MB；0 关闭。 */
  imageryDiskCacheBytes?: number;
  /**
   * 空闲时预取下一级地形数据的瓦片数（默认 16；0 关闭）。
   * 只预取 .terrain 原始字节进持久化缓存，不建网格、不拉影像，
   * 用户真正缩放进来时省掉一次网络往返。
   */
  prefetchTileBudget?: number;
  /**
   * availability 之下的层级是否继续用上采样网格细分（默认 true）。
   * 与 Cesium 的 UpsampledTerrainProvider 行为一致：地形数据到顶后仍按
   * 屏幕误差继续细分，虚拟瓦片的几何由最近可用祖先网格重采样（不发
   * 地形请求），影像层级随之细化到 terrainSubdivisionMaxZoom。
   */
  terrainVirtualSubdivision?: boolean;
  /** 地形四叉树细分（含虚拟瓦片）的最大层级，默认 maxZoom + 3。 */
  terrainSubdivisionMaxZoom?: number;
  /**
   * 影像瓦片「入场节拍」：一整批瓦片希望全部亮起的时长（毫秒，默认 420）。
   *
   * 影像就绪后不立即上屏，而是按节拍依次放行淡入，避免同一帧集中亮起
   * 造成的"放鞭炮"感。块多时间隔自动变密、块少时变疏，整批约在此时长内
   * 出清；调小 = 清晰得更快但节奏更急，调大 = 更平缓但更晚看清；
   * 设为 0 关闭节拍（就绪即上屏，旧行为）。
   */
  revealSpreadMs?: number;
  /** 单块入场间隔上限（毫秒，默认 60）：小队列入场也不必等太久。 */
  revealMaxSlotMs?: number;
  /**
   * 候场超过该时长（毫秒，默认 400）的瓦片强制优先入场。
   * 保证节拍永远不会变成可见清晰度的瓶颈。
   */
  revealMaxWaitMs?: number;
  /** 同一帧最多放行的块数（默认 4）：低帧率时补偿节拍，避免队列排不空。 */
  revealMaxPerFrame?: number;
  /**
   * 相机手势（拖拽/缩放）期间每次视图更新最多放行的影像升级瓦片数，
   * 默认 2。设 0 回到"手势内完全冻结"的旧行为，设大则交互中更清晰但更吃带宽。
   */
  imageryInteractingBudget?: number;
}

export interface TerrainViewportLoadState {
  total: number;
  loaded: number;
  pending: number;
  failed: number;
  complete: boolean;
  failedKeys: TileKey[];
}

interface TerrainTileEntry {
  mesh: THREE.Mesh;
  key: TileKey;
  /** Highest decoded terrain elevation for this tile, in meters. */
  surfaceHeight: number;
  imageryZoom: number;
  imageryCoverage: ImageryCoverage | null;
  pendingImageryZoom: number | null;
  /** 画布尺寸上限导致实际可用的最高影像层级（降级时记录，防止无限重试）。 */
  imageryZoomCap: number | null;
  /** 影像升级失败后的最早重试时间戳（指数退避）。 */
  imageryRetryAt: number;
  /** 连续影像升级失败次数（成功后清零）。 */
  imageryFailures: number;
  /** 加入场景的时间戳（用于 fade-in 动画） */
  bornAt: number;
  /** Geometry may be ready while its imagery is still loading. */
  imageryReady: boolean;
  /** 影像已就绪但仍在"入场队列"里候场（true = 尚未上屏，保持全透明 + 不可见） */
  revealPending: boolean;
}

interface ImageryCoverage {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** 延后执行的影像拼接任务：由 update() 按每帧时间预算调度。 */
interface ImageryStitchTask {
  /** 越小越先执行：初载 0（瓦片等它上屏），升级 1。 */
  priority: number;
  cancelled: boolean;
  run: () => void;
  /** 队列被清空（clearAll/dispose）时拒绝外层 promise，避免悬挂。 */
  onCancel: (error: Error) => void;
}

interface ImageryFetchResult {
  texture: THREE.Texture;
  zoom: number;
  coverage: ImageryCoverage | null;
}

interface ImageryLoadingRequest {
  promise: Promise<ImageBitmap>;
  queueAbortController: AbortController;
  owners: Set<TileKey>;
  started: boolean;
}

/** 正在 fade-out 的瓦片 */
interface FadingTile {
  entry: TerrainTileEntry;
  fadeStart: number;
}

/**
 * 等待"入场节拍"的瓦片：影像已经加载并拼接完毕，但暂不上屏，由 update()
 * 按节拍逐块放行。
 *
 * 存在的理由：拼接是按每帧预算（8ms / 2 任务）执行的，一批瓦片常常在同一帧
 * 前后集中完成，若此时直接 bornAt = now，它们会在同一帧同时开始淡入，视觉
 * 上就是整片地形"啪"地一起浮出来（像放鞭炮）。Cesium 的观感是瓦片依次亮起，
 * 这里把批次的入场时间摊开还原那种节奏。
 */
interface RevealItem {
  key: TileKey;
  entry: TerrainTileEntry;
  /** 越大越先入场：屏幕裁剪后的投影像素尺寸（与影像升级同一优先级口径） */
  score: number;
  /** 入队时刻，用于"候场过久强制放行"，避免节拍变成加载瓶颈 */
  queuedAt: number;
}

interface PendingRequest {
  key: TileKey;
  x: number;
  y: number;
  zoom: number;
  priority: number;
  isFallback: boolean;
  /** 虚拟瓦片：不发地形请求，几何由可用祖先网格上采样得到。 */
  virtual: boolean;
  abortController: AbortController;
  started: boolean;
}

/** 一次地形网格构建任务（在 Worker 中解析 + 展开顶点 + 裙边） */
interface TerrainMeshJob {
  /** 由 `building.then(onOk, onErr)` 消费拒绝，不会产生 unhandled rejection */
  settled: boolean;
  result?: TerrainMeshArrays;
  error?: unknown;
}

interface PendingTerrainRender {
  key: TileKey;
  x: number;
  y: number;
  zoom: number;
  priority: number;
  isFallback: boolean;
  /** 虚拟瓦片：meshJob 来自上采样，没有 terrainBuffer，也不回填源缓存。 */
  virtual: boolean;
  abortController: AbortController;
  /** Worker 路径下 buffer 所有权已转移，仅在同步回退路径中使用。 */
  terrainBuffer?: ArrayBuffer;
  /** 非空时使用 Worker 构建结果；为 null 时走主线程同步回退路径。 */
  meshJob: TerrainMeshJob | null;
  imageryPromise: Promise<ImageryFetchResult | null> | null;
  imageryAttached: boolean;
  initialImageryZoom: number;
}

interface TileFailure {
  retries: number;
  lastAttempt: number;
  nextAttempt: number;
  permanent: boolean;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
  }
}

function isPermanentHttpStatus(status: number | null): boolean {
  return status === 404 || status === 410;
}

interface TileAvailability {
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}

interface TerrainValidBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Cesium Terrain 地形图层（quantized-mesh 格式）
 *
 * 加载 Cesium Ion 地形瓦片，构建三维地形网格，可选叠加卫星影像。
 * 复用优先级队列 + 多级LOD + LRU缓存 + 父级Fallback 调度模式。
 *
 * 用法：
 * ```ts
 * const terrain = new CesiumTerrainLayer(gis, {
 *   terrainUrl: 'https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0',
 *   accessToken: 'your_token',
 *   imageryUrlTemplate: 'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
 * });
 * scene.add(terrain);
 * ```
 */
export class CesiumTerrainLayer extends THREE.Group {
  private gis: WebMercatorGIS;
  private terrainUrl: string;
  private accessToken: string;
  private tileYOrigin: "north" | "south";
  private terrainZoomOffset: number;
  private imageryMaxCanvasSize: number;
  private imageryZoomOffset: number;
  private isTileUrlTemplate: boolean;
  private hasExplicitTileTemplate = false;
  private ionResourceToken: string | null = null;
  private terrainTileTemplate: string | null = null;
  private terrainVersion: string | null = null;
  private terrainAvailability: TileAvailability[][] | null = null;
  private terrainValidBounds: TerrainValidBounds | null = null;
  private ionInitialization: Promise<void> | null = null;
  private ionTokenRefresh: Promise<void> | null = null;
  private metadataReady = false;
  private readonly metadataController = new AbortController();
  private readonly lifecycleController = new AbortController();
  private imageryUrlTemplate?: string;
  private imagerySubdomains: readonly string[];
  private imageryRequestGroup?: string;
  private imageryMaximumRequestsPerServer?: number;
  /** 地形请求的每服务器并发上限（默认沿用调度器默认值）。 */
  private terrainMaximumRequestsPerServer?: number;

  /** 持久化瓦片缓存（跨刷新复用，网络不可用降级为 null）。 */
  private terrainDiskCache: TileDiskCache | null = null;
  private imageryDiskCache: TileDiskCache | null = null;
  /** 与解析后的区域端点无关的稳定命名空间，保证换 CDN 区域后缓存仍复用。 */
  private readonly terrainCacheNamespace: string;
  private readonly terrainDiskCacheBytes: number;
  private readonly imageryDiskCacheBytes: number;

  /** 空闲预取下一级地形数据的预算与状态。 */
  private prefetchTileBudget: number;
  private prefetchAttempted = new Set<TileKey>();
  private prefetchInFlight = 0;
  private prefetchController: AbortController | null = null;
  private lastPrefetchAt = 0;

  /** availability 之下的层级是否继续上采样细分（虚拟瓦片）。 */
  private terrainVirtualSubdivision: boolean;
  /** 地形四叉树细分（含虚拟瓦片）的最大层级。 */
  private terrainSubdivisionMaxZoom: number;
  /** 可用瓦片的基准网格（无裙边）LRU，作为虚拟瓦片的高程采样源。 */
  private meshSourceCache = new Map<TileKey, TerrainMeshBaseArrays>();
  /** 正在解码的源网格请求，避免并发重复拉取/解码。 */
  private sourceArraysLoading = new Map<TileKey, Promise<TerrainMeshBaseArrays>>();

  private loadedTiles = new Map<TileKey, TerrainTileEntry>();
  private tileCache = new Map<TileKey, TerrainTileEntry>();
  private pending: PendingRequest[] = [];
  /** Downloaded terrain buffers waiting for a bounded per-frame scene commit. */
  private pendingTerrainRenders: PendingTerrainRender[] = [];
  private loading = new Map<TileKey, PendingRequest>();
  /** 失败记录：可见瓦片按退避策略持续重试。 */
  private failedTiles = new Map<TileKey, TileFailure>();
  /** 最大连续重试日志次数；实际请求不会永久停止。 */
  private maxRetries = 2;
  /** 重试冷却时间（ms），冷却期内不重新入队 */
  private retryCooldown = 10000;
  private readonly maxRetryCooldown = 160000;
  private currentVisibleKeys = new Set<TileKey>();

  private maxConcurrent: number;
  private maxQueueSize: number;
  private maxRequestsPerFrame: number;
  private maxTileRendersPerFrame: number;
  private minZoom: number;
  private maxZoom: number;
  private maxLodLevels: number;
  private maxTilesPerView: number;
  private terrainTilePixelSize: number;
  private maximumScreenSpaceError: number;
  private maxCacheSize: number;
  private exaggeration: number;
  private wireframe: boolean;
  /** 调试着色模式：不绘制影像、按层级着纯色（见 debugColorByZoom 选项） */
  private debugColorByZoom: boolean;
  private disposed = false;
  /** 当前帧统一影像层级（由 updateTilesInView 计算），所有瓦片使用相同影像分辨率 */
  private currentImageryZoom = 4;
  private currentViewLngBounds: [number, number] | null = null;
  private currentViewLatBounds: [number, number] | null = null;
  private currentViewportWidth = 1;
  private currentViewportHeight = 1;
  private currentCameraFrustum: THREE.Frustum | null = null;
  private currentCamera: THREE.PerspectiveCamera | null = null;
  /** 地形网格构建 Worker 池：解析 + 顶点展开 + 裙边全部在 Worker 中完成 */
  private terrainMeshPool: TerrainMeshWorkerPool;
  /** 影像拼接 Worker 池：drawImage 拼画布 + 翻转 + 导出 ImageBitmap 全在 Worker 中完成 */
  private stitchPool: ImageryStitchPool;
  private maximumObservedSurfaceHeight = 0;
  private imageryPriorityTarget = new THREE.Vector3();
  private imageryPriorityCamera: THREE.Vector3 | null = null;
  /** 共享影像图片缓存：相邻地形瓦片复用相同 Mercator 影像瓦片，避免重复请求 */
  private imgCache = new Map<string, ImageBitmap>();
  /** 正在下载的影像请求，避免同一缓存键并发重复请求。 */
  private imgLoading = new Map<string, ImageryLoadingRequest>();
  /** 影像瓦片失败记录；404/410 永久失败，其他错误按退避策略重试。 */
  private failedImagery = new Map<string, TileFailure>();
  private readonly maxImgCacheSize = 300;
  /** 正在 fade-out 的瓦片（动画结束后才真正移除） */
  private fadingOut = new Map<TileKey, FadingTile>();
  private readonly FADE_IN_MS = 300;
  private readonly FADE_OUT_MS = 200;

  // ─── 入场节拍（避免整批瓦片同帧"放鞭炮"）──────────────────────
  // 影像拼接按每帧预算执行，一批瓦片经常在同一帧集中完成；若就绪即上屏，
  // 整片地形会在同一帧一起淡入。这里让就绪的瓦片先在队列里候场，由
  // update() 按自适应节拍逐块放行，还原 Cesium 那种"依次亮起"的观感。
  /** 候场队列：影像已就绪、等待上屏的瓦片 */
  private revealQueue: RevealItem[] = [];
  /** 入场节拍信用（单位 = 块）：随时间按 1/slotMs 累积，攒满 1 才放行一块 */
  private revealCredit = 1;
  /** 上一次结算节拍的时刻；0 = 队列空闲未锚定（下一块立即可入场） */
  private revealLastAt = 0;
  /**
   * 当前批次的单块入场间隔（毫秒）；0 = 尚未定档。
   *
   * 在批次形成时（队列里还都是这一批的成员）按规模一次性定档，之后不再随
   * 队列长度重算 —— 否则队列被放行变短 → 间隔变大 → 放行更慢，越到队尾
   * 越拖（实测 24 块的同批要 1.1 秒才出完）。定档后整批恒定在
   * `revealSpreadMs` 左右出清。
   */
  private revealSlotMs = 0;
  /**
   * 一整批瓦片希望全部亮起的时长（毫秒）：起批时按规模定档单块间隔。
   *
   * 初始化可配（`revealSpreadMs`）：调小 = 清晰得更快但节奏更急；
   * 设为 0 = 关闭节拍、就绪即上屏（旧行为）。
   */
  private revealSpreadMs = 420;
  /** 单块入场间隔上限（毫秒）：小队列入场也别太拖（可配 `revealMaxSlotMs`） */
  private revealMaxSlotMs = 60;
  /**
   * 剩余不超过该块数时不再摊（只在队尾留 1 块时直放）。
   *
   * 这个阈值必须足够小：真实场景里"一波就绪"常常是 3~6 块，若阈值取 3 就会
   * 把整波放进同一帧，节拍等于没生效（实测转向场景的前 3 大帧占比仍是 75%）。
   */
  private readonly REVEAL_TAIL_IMMEDIATE = 1;
  /** 同一帧最多放行的块数（低帧率时补偿节拍，避免队列排不空；可配 `revealMaxPerFrame`） */
  private revealMaxPerFrame = 4;
  /** 节拍信用上限，防止长时间积压后一次性兑现成新的"整片一起亮" */
  private readonly REVEAL_MAX_CREDIT = 6;
  /** 帧窗口（毫秒）：与上一块上屏相距超过它，说明是涓流加载，无需摊 */
  private readonly REVEAL_FAST_WINDOW_MS = 24;
  /** 候场超过该时长（毫秒）的瓦片强制优先入场，避免节拍拖慢可见清晰度（可配 `revealMaxWaitMs`） */
  private revealMaxWaitMs = 400;
  /** 上一次"直接上屏"（未候场）的时刻，用于识别同帧爆发 */
  private lastRevealAdmitAt = 0;

  // ─── 快速跳层（防抖）─────────────────────────────────────────
  // 连续缩放若在一次连续手势里跨越多个层级，中间代际的瓦片（祖先兜底、
  // 待淡出的旧瓦片）从加载到被替换常常不足百毫秒，却要吃满几何提交、
  // 影像拼接与透明混合的预算。此时只保留「最高层」（本帧 LOD 集）与
  // 「最底层」（底图毯）：祖先兜底与旧代际立即入缓存，影像也不再为
  // 中间层级升级；手势停下（尾巴期内无层级变化）后恢复常规行为，
  // 中间层级从缓存秒回、缺失影像再补齐。
  private fastZoomActive = false;
  /** 最近一次观察到的 LOD 层级（= 本帧可见集里的最细层级） */
  private lastLodZoom = -1;
  /**
   * 最近一次四叉树遍历的代价与截断情况（诊断用）。
   *
   * `stoppedBy` 非空表示遍历**没走完**就被预算掐断：此时哪些区域拿到瓦片
   * 完全取决于固定的探索顺序，与相机朝向强相关 —— 这是"转向某几个方位
   * 时瓦片请求手感变差"的根因所在。
   */
  private traversalDebug = {
    roots: 0,
    visited: 0,
    maxVisited: 0,
    accepted: 0,
    stoppedBy: "" as "" | "visitedBudget" | "maxTilesPerView",
    subdivided: 0,
    prunedAABB: 0,
    prunedFrustum: 0,
    notSubdividable: 0,
    guardBlocked: 0,
    guardBlockSamples: [] as string[],
  };
  /** 当前跳层突发的起始层级与时刻 */
  private lodBurstBaseZoom = -1;
  private lodBurstBaseAt = 0;
  /** 最近一次 LOD 层级变化时刻 */
  private lodLastChangeAt = 0;
  /** 两次层级变化间隔超过该值视为两次独立突发（毫秒） */
  private readonly LOD_BURST_GAP_MS = 250;
  /** 累计跨越多少级才算"跳跃多层"（级） */
  private readonly LOD_FAST_MIN_LEVELS = 2;
  /** 层级停止变化后快速模式保留的尾巴（毫秒） */
  private readonly LOD_FAST_TAIL_MS = 300;
  /** 快速跳层时保留的"最底层"：比本帧 LOD 集粗多少层及以上的已加载祖先 */
  private readonly LOD_FAST_COARSE_GAP = 2;
  /** 快速跳层时向上回溯祖先的最大层数 */
  private readonly LOD_FAST_ANCESTOR_WALK = 6;

  constructor(
    gis: WebMercatorGIS,
    config: {
      /** Cesium Ion 地形服务基础地址 */
      terrainUrl: string;
      /** Cesium Ion access token */
      accessToken: string;
    },
    options: CesiumTerrainLayerOptions = {},
  ) {
    super();
    this.gis = gis;
    const workerCount = Math.min(
      4,
      Math.max(1, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency - 1 : 2),
    );
    this.terrainMeshPool = new TerrainMeshWorkerPool(workerCount);
    this.stitchPool = new ImageryStitchPool(Math.min(2, workerCount));
    this.terrainUrl = config.terrainUrl.replace(/\/$/, "");
    this.accessToken = config.accessToken;
    this.isTileUrlTemplate = /\{[xyz]\}/.test(this.terrainUrl);
    const yOrigin = options.tileYOrigin ?? "auto";
    this.tileYOrigin = yOrigin === "north" ? "north" : "south";
    // A full URL template plus an explicit scheme can request tiles without
    // waiting for layer.json. Cesium Ion still needs a short endpoint token
    // exchange, but that response is small and does not block on metadata.
    this.hasExplicitTileTemplate = this.isTileUrlTemplate && yOrigin !== "auto";
    this.metadataReady = yOrigin !== "auto" && !this.isCesiumIonUrl();
    this.terrainZoomOffset = options.terrainZoomOffset ?? -1;
    if (!Number.isInteger(this.terrainZoomOffset)) {
      throw new TypeError("terrainZoomOffset must be an integer.");
    }
    this.imageryMaxCanvasSize = options.imageryMaxCanvasSize ?? 2048;
    if (!Number.isInteger(this.imageryMaxCanvasSize) || this.imageryMaxCanvasSize < 512) {
      throw new RangeError("imageryMaxCanvasSize must be an integer of at least 512.");
    }
    this.imageryZoomOffset = options.imageryZoomOffset ?? 0;
    if (!Number.isInteger(this.imageryZoomOffset)) {
      throw new TypeError("imageryZoomOffset must be an integer.");
    }
    this.imageryUrlTemplate = options.imageryUrlTemplate;
    this.imagerySubdomains = options.imagerySubdomains?.length
      ? options.imagerySubdomains
      : DEFAULT_TILE_SUBDOMAINS;
    this.imageryRequestGroup =
      options.imageryRequestGroup ?? getTileRequestGroup(this.imageryUrlTemplate);
    this.imageryMaximumRequestsPerServer = options.imageryMaximumRequestsPerServer;
    if (
      this.imageryMaximumRequestsPerServer !== undefined &&
      (!Number.isInteger(this.imageryMaximumRequestsPerServer) ||
        this.imageryMaximumRequestsPerServer < 1)
    ) {
      throw new RangeError("imageryMaximumRequestsPerServer must be an integer greater than 0.");
    }

    this.maxConcurrent = options.maxConcurrent ?? 10;
    this.maxQueueSize = options.maxQueueSize ?? 128;
    this.maxRequestsPerFrame = options.maxRequestsPerFrame ?? 8;
    this.maxTileRendersPerFrame = options.maxTileRendersPerFrame ?? 2;
    if (!Number.isInteger(this.maxTileRendersPerFrame) || this.maxTileRendersPerFrame < 1) {
      throw new RangeError("maxTileRendersPerFrame must be an integer greater than 0.");
    }
    this.minZoom = options.minZoom ?? 1;
    this.maxZoom = options.maxZoom ?? 13;
    this.maxLodLevels = options.maxLodLevels ?? 2;
    this.maxTilesPerView = options.maxTilesPerView ?? 512;
    if (!Number.isInteger(this.maxTilesPerView) || this.maxTilesPerView < 16) {
      throw new RangeError("maxTilesPerView must be an integer of at least 16.");
    }
    this.terrainTilePixelSize = options.terrainTilePixelSize ?? 256;
    if (!Number.isFinite(this.terrainTilePixelSize) || this.terrainTilePixelSize < 64) {
      throw new RangeError("terrainTilePixelSize must be at least 64.");
    }
    this.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 2;
    if (!Number.isFinite(this.maximumScreenSpaceError) || this.maximumScreenSpaceError <= 0) {
      throw new RangeError("maximumScreenSpaceError must be greater than 0.");
    }
    this.maxCacheSize = options.maxCacheSize ?? 96;
    this.exaggeration = options.exaggeration ?? 1.0;
    this.terrainMaximumRequestsPerServer = options.maximumRequestsPerServer;
    this.prefetchTileBudget =
      options.prefetchTileBudget === undefined
        ? 16
        : Math.max(0, Math.floor(options.prefetchTileBudget));
    this.terrainVirtualSubdivision = options.terrainVirtualSubdivision ?? true;
    const subdivisionMax = options.terrainSubdivisionMaxZoom ?? this.maxZoom + 3;
    if (!Number.isInteger(subdivisionMax) || subdivisionMax < this.maxZoom) {
      throw new RangeError("terrainSubdivisionMaxZoom must be an integer >= maxZoom.");
    }
    this.terrainSubdivisionMaxZoom = subdivisionMax;

    // 入场节拍（可配）：见 CesiumTerrainLayerOptions 中同名选项的说明
    this.revealSpreadMs = Math.max(0, options.revealSpreadMs ?? 420);
    if (!Number.isFinite(this.revealSpreadMs)) {
      throw new RangeError("revealSpreadMs must be a finite number (0 disables the pacing).");
    }
    this.revealMaxSlotMs = options.revealMaxSlotMs ?? 60;
    if (!Number.isFinite(this.revealMaxSlotMs) || this.revealMaxSlotMs <= 0) {
      throw new RangeError("revealMaxSlotMs must be greater than 0.");
    }
    this.revealMaxWaitMs = options.revealMaxWaitMs ?? 400;
    if (!Number.isFinite(this.revealMaxWaitMs) || this.revealMaxWaitMs < 0) {
      throw new RangeError("revealMaxWaitMs must not be negative.");
    }
    this.revealMaxPerFrame = options.revealMaxPerFrame ?? 4;
    if (!Number.isInteger(this.revealMaxPerFrame) || this.revealMaxPerFrame < 1) {
      throw new RangeError("revealMaxPerFrame must be an integer greater than 0.");
    }
    this.imageryInteractingBudget = options.imageryInteractingBudget ?? 2;
    if (!Number.isInteger(this.imageryInteractingBudget) || this.imageryInteractingBudget < 0) {
      throw new RangeError("imageryInteractingBudget must be an integer of at least 0.");
    }

    // 持久化缓存：命名空间取“去掉 {z}/{x}/{y} 模板部分的地址”，
    // 因此 Ion endpoint 把区域换成 us-east-1 / ap-northeast-1 时缓存依然复用。
    const templateStart = this.terrainUrl.indexOf("{");
    const terrainBase =
      templateStart >= 0
        ? this.terrainUrl.slice(0, templateStart)
        : this.terrainUrl.split(/[?#]/, 1)[0];
    this.terrainCacheNamespace = `terrain:${terrainBase.replace(/\/$/, "")}`;
    this.terrainDiskCacheBytes =
      options.terrainDiskCacheBytes ?? DEFAULT_TERRAIN_DISK_CACHE_BYTES;
    this.imageryDiskCacheBytes =
      options.imageryDiskCacheBytes ?? DEFAULT_IMAGERY_DISK_CACHE_BYTES;
    this.terrainDiskCache = getTileDiskCache(
      this.terrainCacheNamespace,
      this.terrainDiskCacheBytes,
    );
    this.imageryDiskCache = this.imageryUrlTemplate
      ? getTileDiskCache(
          `imagery:${getTileRequestGroup(this.imageryUrlTemplate)}`,
          this.imageryDiskCacheBytes,
        )
      : null;
    this.wireframe = options.wireframe ?? false;
    this.debugColorByZoom = options.debugColorByZoom ?? false;
    if (!this.metadataReady) {
      this.ionInitialization = this.initializeTerrainSource();
    }
  }

  // ─── 核心更新入口 ───────────────────────────────────────────

  public updateTilesInView(
    viewLngBounds: [number, number],
    viewLatBounds: [number, number],
    baseZoom: number,
    cameraTarget?: THREE.Vector3,
    cameraDistance?: number,
    cameraPosition?: THREE.Vector3,
    /** Imagery zoom derived from camera height, independent from terrain zoom. */
    imageryZoom?: number,
    camera?: THREE.PerspectiveCamera,
    viewportWidth = 1,
    viewportHeight = 1,
  ) {
    if (this.disposed || !this.metadataReady) return;

    const terrainZoom = THREE.MathUtils.clamp(
      baseZoom + this.terrainZoomOffset,
      this.minZoom,
      this.maxZoom,
    );
    // Imagery level follows the camera-derived value, not the terrain service
    // level. fetchImagery may lower it further only to fit its canvas.
    this.currentImageryZoom = THREE.MathUtils.clamp(
      (imageryZoom ?? baseZoom) + this.imageryZoomOffset,
      this.minZoom,
      this.maxZoom + 3,
    );
    this.currentViewLngBounds = [viewLngBounds[0], viewLngBounds[1]];
    this.currentViewLatBounds = [viewLatBounds[0], viewLatBounds[1]];
    this.currentViewportWidth = Math.max(viewportWidth, 1);
    this.currentViewportHeight = Math.max(viewportHeight, 1);
    if (camera) {
      camera.updateMatrixWorld();
      this.currentCamera = camera;
      this.currentCameraFrustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      );
    } else {
      this.currentCamera = null;
      this.currentCameraFrustum = null;
    }
    const [lngMin, lngMax] = viewLngBounds;
    const [latMin, latMax] = viewLatBounds;
    const target = cameraTarget ?? new THREE.Vector3(0, 0, 0);
    const camPos = cameraPosition;
    this.imageryPriorityTarget.copy(target);
    this.imageryPriorityCamera = camPos ? camPos.clone() : null;
    // 扩大高精度覆盖范围：3 倍相机距离内都用最高 LOD，减少倾斜视角下的低等级瓦片
    const nearRadius = (cameraDistance ?? 50000) * 3;

    const swTile = lngLatToGeoTile(lngMin, latMin, terrainZoom, this.tileYOrigin);
    const neTile = lngLatToGeoTile(lngMax, latMax, terrainZoom, this.tileYOrigin);

    const xStart = Math.min(swTile.x, neTile.x);
    const xEnd = Math.max(swTile.x, neTile.x);
    const yStart = Math.min(swTile.y, neTile.y);
    const yEnd = Math.max(swTile.y, neTile.y);

    const MAX_TILES = this.maxTilesPerView;
    const totalTiles = (xEnd - xStart + 1) * (yEnd - yStart + 1);

    const visibleKeys = new Set<TileKey>();
    const tilesToLoad: {
      key: TileKey;
      x: number;
      y: number;
      zoom: number;
      priority: number;
      virtual?: boolean;
    }[] = [];

    if (camera) {
      this.collectQuadtreeTerrainTiles(
        viewLngBounds,
        viewLatBounds,
        baseZoom,
        camera,
        target,
        camPos,
        visibleKeys,
        tilesToLoad,
      );
    } else if (totalTiles <= MAX_TILES) {
      for (let x = xStart; x <= xEnd; x++) {
        for (let y = yStart; y <= yEnd; y++) {
          const dist = this.tileDistanceTo(x, y, terrainZoom, target, camPos);
          const effectiveZoom = this.getEffectiveZoom(dist, terrainZoom, nearRadius);
          const parent = this.toParentTile(x, y, terrainZoom, effectiveZoom);
          const resolved = this.resolveAvailableAncestor(parent.x, parent.y, effectiveZoom);
          if (!resolved) continue;
          const key = this.getKey(resolved.x, resolved.y, resolved.zoom);

          if (visibleKeys.has(key)) continue;
          visibleKeys.add(key);
          if (this.loadedTiles.has(key)) continue;
          if (this.restoreFromCache(key)) continue;
          tilesToLoad.push({
            key,
            x: resolved.x,
            y: resolved.y,
            zoom: resolved.zoom,
            priority: dist,
          });
        }
      }
    } else {
      let fallbackZoom = Math.max(this.minZoom, terrainZoom - this.maxLodLevels);
      while (fallbackZoom > this.minZoom) {
        const swFallback = lngLatToGeoTile(lngMin, latMin, fallbackZoom, this.tileYOrigin);
        const neFallback = lngLatToGeoTile(lngMax, latMax, fallbackZoom, this.tileYOrigin);
        const fallbackCount =
          (Math.abs(neFallback.x - swFallback.x) + 1) * (Math.abs(neFallback.y - swFallback.y) + 1);
        if (fallbackCount <= MAX_TILES) break;
        fallbackZoom--;
      }
      const swF = lngLatToGeoTile(lngMin, latMin, fallbackZoom, this.tileYOrigin);
      const neF = lngLatToGeoTile(lngMax, latMax, fallbackZoom, this.tileYOrigin);
      const fxStart = Math.min(swF.x, neF.x);
      const fxEnd = Math.max(swF.x, neF.x);
      const fyStart = Math.min(swF.y, neF.y);
      const fyEnd = Math.max(swF.y, neF.y);

      for (let x = fxStart; x <= fxEnd; x++) {
        for (let y = fyStart; y <= fyEnd; y++) {
          const resolved = this.resolveAvailableAncestor(x, y, fallbackZoom);
          if (!resolved) continue;
          const key = this.getKey(resolved.x, resolved.y, resolved.zoom);
          if (visibleKeys.has(key)) continue;
          visibleKeys.add(key);
          if (this.loadedTiles.has(key)) continue;
          if (this.restoreFromCache(key)) continue;
          const dist = this.tileDistanceTo(resolved.x, resolved.y, resolved.zoom, target, camPos);
          tilesToLoad.push({
            key,
            x: resolved.x,
            y: resolved.y,
            zoom: resolved.zoom,
            priority: dist,
          });
        }
      }
    }

    this.currentVisibleKeys = new Set(visibleKeys);
    // LOD 观测量 = 本帧可见集里的最细层级，据此判定是否处于快速跳层
    let lodZoom = 0;
    for (const key of visibleKeys) {
      const zoom = Number(key.split(",")[2]);
      if (zoom > lodZoom) lodZoom = zoom;
    }
    this.updateFastZoomState(performance.now(), lodZoom);
    // 快速跳层：不加载中间代际的祖先兜底（"最底层"底图毯仍然保留）。
    // 这些祖先往往在百毫秒内被更细的一代替换，加载 + 拼接 + 上传全是浪费。
    const fallbackParentKeys = this.fastZoomActive
      ? new Set<TileKey>()
      : this.enqueueFallbackParents(tilesToLoad, visibleKeys);
    // 底图毯：请求保留（不被 cancelExcept 清掉）+ 渲染保留（不被 fade-out）
    const baseLayerKeys = this.ensureBaseLayer(viewLngBounds, viewLatBounds, terrainZoom);
    for (const key of baseLayerKeys) fallbackParentKeys.add(key);

    for (const tile of tilesToLoad) {
      this.enqueue(tile.key, tile.x, tile.y, tile.zoom, tile.priority, false, Boolean(tile.virtual));
    }

    this.cancelExcept(visibleKeys, fallbackParentKeys);

    // 快速跳层：保留集 = 底图毯 + 「最底层」——比本帧 LOD 集粗 ≥2 层的已加载
    // 祖先（它们已在显存里，零加载成本，正好当屏幕底毯），中间代际不保留，
    // 于是同区域只会有"最高层"和"最底层"两代在渲染。
    const fallbackKeys = new Set<TileKey>();
    for (const key of baseLayerKeys) fallbackKeys.add(key);
    if (this.fastZoomActive) {
      const coarseCutoff = lodZoom - this.LOD_FAST_COARSE_GAP;
      for (const key of visibleKeys) {
        const parts = key.split(",").map(Number);
        let ax = parts[0];
        let ay = parts[1];
        let az = parts[2];
        for (let depth = 0; depth < this.LOD_FAST_ANCESTOR_WALK && az > this.minZoom; depth++) {
          ax = Math.floor(ax / 2);
          ay = Math.floor(ay / 2);
          az -= 1;
          if (az > coarseCutoff) continue; // 中间代际：不保留，立即退场
          const ancestorKey = this.getKey(ax, ay, az);
          if (this.loadedTiles.has(ancestorKey)) fallbackKeys.add(ancestorKey);
        }
      }
    } else {
      for (const key of this.computeFallbackKeys(visibleKeys)) fallbackKeys.add(key);
    }

    // 取消已变回可见的 fade-out 瓦片
    for (const [key] of this.fadingOut) {
      if (visibleKeys.has(key) || fallbackKeys.has(key)) {
        const fading = this.fadingOut.get(key)!;
        this.fadingOut.delete(key);
        const mat = fading.entry.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 1;
        mat.transparent = false;
        this.loadedTiles.set(key, fading.entry);
      }
    }

    // 不再可见的瓦片 → 常规路径开始 fade-out（而非立即移除）；
    // 快速跳层时直接入缓存：200ms 的透明淡出在这一刻纯属 overdraw 浪费，
    // 被撤掉的都会被更细的一代或底图毯接管，手势停下后才需要它们回归。
    for (const [key, entry] of this.loadedTiles) {
      if (!visibleKeys.has(key) && !fallbackKeys.has(key)) {
        this.loadedTiles.delete(key);
        if (this.fastZoomActive) {
          this.cacheTile(key, entry);
          continue;
        }
        // 还在候场、从未上屏的瓦片：谈不上"淡出"（它 opacity 仍为 0，
        // 走淡出路径反而会从 1 开始闪一下），直接摘出队列进缓存
        if (entry.revealPending) {
          this.cacheTile(key, entry);
          continue;
        }
        const mat = entry.mesh.material as THREE.MeshBasicMaterial;
        mat.transparent = true;
        this.fadingOut.set(key, { entry, fadeStart: performance.now() });
      }
    }

    if (this.needsImagery()) {
      const imageryCandidates: Array<{
        entry: TerrainTileEntry;
        zoom: number;
        coverage: ImageryCoverage | null;
        /** 越大越先：屏幕投影像素面积（"离视角最近/占屏最大"的瓦片先升级） */
        score: number;
      }> = [];
      const projectionCamera = this.currentCamera;
      const addImageryCandidate = (key: TileKey, isFallback: boolean): void => {
        const entry = this.loadedTiles.get(key);
        if (!entry) return;
        const [x, y, zoom] = key.split(",").map(Number);
        // 快速跳层：只为"最高层"（本帧最细层级）升级影像。中间层级的画布
        // 拼好、纹理传完往往几十毫秒后就被替换，纯属浪费拼接与上传预算。
        // 兜底瓦片同理——它们这几十毫秒后就会被正选瓦片取代。
        if (this.fastZoomActive && (isFallback || zoom < lodZoom)) return;
        // 兜底瓦片只在"紧贴 LOD 集"时升级：底图毯那类比 LOD 粗好几级的瓦片
        // 升级毫无意义（它被更细的瓦片整片盖住），却要占掉一个升级名额。
        if (isFallback && zoom < lodZoom - 2) return;
        // 排序键从"到相机/目标的距离"改为"屏幕投影面积"：倾斜视角下前中景
        // 几十块瓦片的距离值非常接近（实测 3.1~4.5km 挤在同一个档位），
        // 排序退化后实际按入队顺序执行，近处不一定先清晰；投影面积则直接
        // 反映"这块在屏幕上有多大、用户多快能看出模糊"。
        // 用视口裁剪后的尺寸：屏幕外的角点不代表用户能看到的大小。
        const screenSize = projectionCamera
          ? this.getTerrainTileProjection(x, y, zoom, projectionCamera).visiblePixelSize
          : 1 / Math.max(1, this.tileDistanceTo(x, y, zoom, target, camPos));
        imageryCandidates.push({
          entry,
          zoom: this.getTileImageryZoom(x, y, zoom),
          coverage: this.getRequiredImageryCoverage(entry),
          // 兜底瓦片降一档（要占屏 4 倍大才挤掉正选瓦片），避免抢走正选名额
          score: screenSize / (isFallback ? 4 : 1),
        });
      };
      for (const key of visibleKeys) addImageryCandidate(key, false);
      // 兜底瓦片（本帧不在 LOD 集里、但为了不漏底正顶在屏幕上）同样要能升级：
      // 它们不升级就会永远停在初始的粗影像层级，屏幕对应区域始终最模糊。
      for (const key of fallbackKeys) {
        if (visibleKeys.has(key)) continue;
        addImageryCandidate(key, true);
      }
      imageryCandidates.sort((a, b) => b.score - a.score);
      // 手势期间不再"完全冻结"影像升级，改为只放行极少数最占屏的瓦片。
      //
      // 原实现是直接跳过整段升级，理由是手势里的画布重建会掉帧。但那会让
      // 拖动全程停在旧层级（实测清晰率 0~22%），松手后一次性补课，实测形成
      // 160 req/s 持续数秒的请求突发——这正是"转一下视角，瓦片请求就不流畅"
      // 的观感来源，也容易撞上瓦片服务端的速率限制。
      // 现在改为匀速放行（手势内每 200ms 2 块），请求流变平缓，松手后也无
      // 积压可补。拼接与纹理上传本来就有预算队列（8ms / 2 任务每帧），
      // 这点量不会造成主线程风暴。
      const upgradeBudget = this.cameraInteracting
        ? Math.max(0, this.imageryInteractingBudget)
        : this.maxRequestsPerFrame;
      let imageryUpgradesStarted = 0;
      for (const candidate of imageryCandidates) {
        // 配置为 0 → 恢复"手势内完全冻结"的旧行为
        if (upgradeBudget <= 0) break;
        if (
          this.upgradeTileImagery(candidate.entry, candidate.zoom, candidate.coverage) &&
          ++imageryUpgradesStarted >= upgradeBudget
        ) {
          break;
        }
      }
    }

    this.cancelImageryExcept(visibleKeys, fallbackKeys);
    this.processQueue();
    this.hideCoveredAncestors();
  }

  /**
   * 每帧调用：驱动 LOD 过渡动画（fade-in / fade-out）
   * 应在渲染循环中调用，不受 200ms 节流限制
   */
  public update() {
    this.processTerrainRenderQueue();
    this.processStitchQueue();
    const now = performance.now();

    // 手势看门狗：cameraInteracting 只由 controls 的 "end" 事件复位，一旦某条
    // 手势路径没触发 end（拖拽中指针捕获丢失、alt-tab、惯性中再次按下……），
    // 标志会永久卡死：影像目标层级被永远压在手势档（extraLevels=0），瓦片
    // 停在低层级糊斑，且低层级影像与低目标自洽——不再请求、不再细化，永不
    // 自愈。拖拽进行中相机每帧都在动；若发现"标志为真但相机已静止超过
    // 800ms"，判定 end 事件丢失，自动解除交互态。
    if (this.cameraInteracting && this.currentCamera) {
      const cam = this.currentCamera;
      const sig = `${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)},${cam.quaternion.x.toFixed(4)},${cam.quaternion.y.toFixed(4)},${cam.quaternion.z.toFixed(4)},${cam.quaternion.w.toFixed(4)}`;
      if (sig !== this.interactCamSig) {
        this.interactCamSig = sig;
        this.interactCamMoveAt = now;
      } else if (now - this.interactCamMoveAt > 800) {
        this.cameraInteracting = false;
      }
    }

    // 入场节拍：把本帧"刚就绪的一批瓦片"摊到若干帧里依次亮起
    this.processRevealQueue(now);

    // fade-in：新瓦片透明度 0 → 1
    for (const [, entry] of this.loadedTiles) {
      const mat = entry.mesh.material as THREE.MeshBasicMaterial;
      const wireMaterial = entry.mesh.userData.wireframeMaterial as
        THREE.MeshBasicMaterial | undefined;
      if (!mat.transparent) continue; // 已完成
      // 还在入场队列里候场：保持全透明，等节拍放行（放行时才写入 bornAt，
      // 若这里放行会按旧的 bornAt 算出 t >= 1，直接跳到全不透明）
      if (entry.revealPending) {
        mat.opacity = 0;
        if (wireMaterial) wireMaterial.opacity = 0;
        continue;
      }
      // 影像未就绪的瓦片保持全透明：先显示灰色兜底色再被纹理覆盖会在
      // 缩放切换时产生“灰色图层”闪烁。等待纹理到位后（bornAt 会被刷新）
      // 再开始淡入；期间旧的已带纹理瓦片作为 fallback 继续显示。
      if (this.needsImagery() && !entry.imageryReady) continue;
      const t = (now - entry.bornAt) / this.FADE_IN_MS;
      if (t >= 1) {
        mat.opacity = 1;
        mat.transparent = false; // 关闭透明，避免排序问题
      } else {
        mat.opacity = t;
      }
      if (wireMaterial) wireMaterial.opacity = mat.opacity * 0.7;
    }

    // 快速跳层：正在淡出的代际立即结束（它们 100% 会被更细的一代替换，
    // 200ms 的透明混合纯属 overdraw）
    if (this.fastZoomActive && this.fadingOut.size > 0) {
      for (const [key, fading] of this.fadingOut) {
        (fading.entry.mesh.material as THREE.MeshBasicMaterial).opacity = 0;
        this.cacheTile(key, fading.entry);
      }
      this.fadingOut.clear();
    }

    // fade-out：旧瓦片透明度 1 → 0，结束后缓存
    for (const [key, fading] of this.fadingOut) {
      const mat = fading.entry.mesh.material as THREE.MeshBasicMaterial;
      const wireMaterial = fading.entry.mesh.userData.wireframeMaterial as
        THREE.MeshBasicMaterial | undefined;
      const t = (now - fading.fadeStart) / this.FADE_OUT_MS;
      if (t >= 1) {
        this.fadingOut.delete(key);
        mat.opacity = 0;
        this.cacheTile(key, fading.entry);
      } else {
        mat.opacity = 1 - t;
      }
      if (wireMaterial) wireMaterial.opacity = mat.opacity * 0.7;
    }

    this.updateTerrainChildOcclusion();
    // 管线空闲时投机预取下一级地形（只写持久化缓存，不抢可见带宽）
    this.prefetchNextLevel();
  }

  // ─── 入场节拍 ───────────────────────────────────────────────

  /**
   * 影像就绪 → 进入入场队列（而非立即上屏）。
   *
   * 两条快路径：`revealSpreadMs <= 0`（初始化显式关闭节拍）与涓流加载
   * （与上一块上屏相距超过一个帧窗口）——后者本来就是一块块来的，摊开
   * 反而平白增加延迟。其余（同一帧窗口内集中就绪的一批，包含快速跳层时
   * 的一批）一律入队依次亮起。
   */
  private enqueueReveal(key: TileKey, entry: TerrainTileEntry): void {
    const now = performance.now();
    // 就绪的瞬间已被撤到缓存（不在场景里）：不上屏，交给 restoreFromCache
    if (this.loadedTiles.get(key) !== entry) {
      entry.revealPending = false;
      return;
    }
    // 节拍已关闭：就绪即上屏
    if (this.revealSpreadMs <= 0) {
      this.lastRevealAdmitAt = now;
      this.revealTile(key, entry);
      return;
    }
    if (
      this.revealQueue.length === 0 &&
      now - this.lastRevealAdmitAt > this.REVEAL_FAST_WINDOW_MS
    ) {
      this.lastRevealAdmitAt = now;
      this.revealTile(key, entry);
      return;
    }
    const [x, y, zoom] = key.split(",").map(Number);
    const camera = this.currentCamera;
    entry.revealPending = true;
    // 候场期间先不可见：既省掉 opacity=0 的透明 draw call，也让
    // isTileRenderable 判定为 false —— 父级/粗层级因此继续兜底，
    // 不会在子瓦片还没亮起来时就被撤下。
    entry.mesh.visible = false;
    this.revealQueue.push({
      key,
      entry,
      score: camera ? this.getTerrainTileProjection(x, y, zoom, camera).visiblePixelSize : 1,
      queuedAt: now,
    });
  }

  /** 把候场瓦片移出入场队列（入缓存 / 释放时调用），避免残留占据节拍槽位 */
  private dropFromRevealQueue(entry: TerrainTileEntry): void {
    if (!entry.revealPending) return;
    entry.revealPending = false;
    for (let i = 0; i < this.revealQueue.length; i++) {
      if (this.revealQueue[i].entry === entry) {
        this.revealQueue.splice(i, 1);
        break;
      }
    }
  }

  /** 把候场瓦片真正交给渲染：重置 bornAt 重新开始淡入 */
  private revealTile(key: TileKey, entry: TerrainTileEntry): void {
    entry.revealPending = false;
    // 候场期间可能已入缓存或被释放：此时直接丢弃，由后续 restoreFromCache 接手
    if (this.loadedTiles.get(key) !== entry) return;
    entry.bornAt = performance.now();
    const mat = entry.mesh.material as THREE.MeshBasicMaterial;
    mat.transparent = true;
    mat.opacity = 0;
    entry.mesh.visible = true;
  }

  /**
   * 每帧结算入场节拍：一整批瓦片恒定在 `revealSpreadMs` 内依次亮起 —— 块数
   * 少时单块间隔大（显得从容），块数多时间隔小（密集但均匀）。信用累积模型
   * 让节奏不随帧率漂移（低帧率时一帧多放几块追赶）。候场超过
   * `revealMaxWaitMs` 的瓦片强制优先放行，节拍不会变成清晰度的瓶颈。
   */
  private processRevealQueue(now: number): void {
    const queue = this.revealQueue;
    if (queue.length === 0) {
      // 空闲：清掉锚点与档位，下一批的第一块立即可入场
      this.revealCredit = 1;
      this.revealLastAt = 0;
      this.revealSlotMs = 0;
      return;
    }

    // 队尾只剩几块时不再摊：否则会出现"最后几块慢慢挤出来"的长尾
    if (queue.length <= this.REVEAL_TAIL_IMMEDIATE) {
      let tailReleased = 0;
      while (queue.length > 0 && tailReleased < this.revealMaxPerFrame) {
        tailReleased++;
        const item = queue.shift()!;
        this.revealTile(item.key, item.entry);
      }
      this.revealCredit = 1;
      return;
    }

    // 批次定档：整批在 revealSpreadMs 内出清
    if (this.revealSlotMs === 0) {
      this.revealSlotMs = Math.min(this.revealMaxSlotMs, this.revealSpreadMs / queue.length);
      // 首帧就能放行第一块
      this.revealLastAt = now - this.revealSlotMs;
    }

    this.revealCredit = Math.min(
      this.REVEAL_MAX_CREDIT,
      this.revealCredit + (now - this.revealLastAt) / this.revealSlotMs,
    );
    this.revealLastAt = now;

    let released = 0;
    while (queue.length > this.REVEAL_TAIL_IMMEDIATE && released < this.revealMaxPerFrame) {
      if (this.revealCredit < 1) break;
      this.revealCredit -= 1;
      released++;
      let best = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const wait = now - item.queuedAt;
        // 候场超时的瓦片以等待时长压过一切优先级——节拍不能变成清晰度的瓶颈
        const score = wait >= this.revealMaxWaitMs ? 1e9 + wait : item.score;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      const item = queue.splice(best, 1)[0];
      this.revealTile(item.key, item.entry);
    }
  }

  // ─── 队列调度 ───────────────────────────────────────────────

  private getKey(x: number, y: number, zoom: number): TileKey {
    return `${x},${y},${zoom}`;
  }

  private enqueue(
    key: TileKey,
    x: number,
    y: number,
    zoom: number,
    priority: number,
    isFallback = false,
    virtual = false,
  ) {
    if (this.loading.has(key)) return;

    // Failed tiles remain part of the current visible target. Retry them with
    // bounded exponential backoff instead of permanently abandoning them.
    const failRecord = this.failedTiles.get(key);
    if (failRecord?.permanent || (failRecord && Date.now() < failRecord.nextAttempt)) return;

    const existing = this.pending.find((r) => r.key === key);
    if (existing) {
      existing.priority = priority;
      return;
    }

    if (this.pending.length >= this.maxQueueSize) {
      let worstIdx = 0;
      for (let i = 1; i < this.pending.length; i++) {
        if (this.pending[i].priority > this.pending[worstIdx].priority) worstIdx = i;
      }
      if (priority >= this.pending[worstIdx].priority) return;
      this.pending.splice(worstIdx, 1);
    }

    this.pending.push({
      key,
      x,
      y,
      zoom,
      priority,
      isFallback,
      virtual,
      abortController: new AbortController(),
      started: false,
    });
  }

  private enqueueFallbackParents(
    tiles: { key: TileKey; x: number; y: number; zoom: number; priority: number }[],
    visibleKeys: Set<TileKey>,
  ): Set<TileKey> {
    const parents = new Set<TileKey>();
    for (const tile of tiles) {
      if (tile.zoom <= this.minZoom) continue;

      const resolved = this.resolveAvailableAncestor(
        Math.floor(tile.x / 2),
        Math.floor(tile.y / 2),
        tile.zoom - 1,
      );
      if (!resolved) continue;
      const { x, y, zoom } = resolved;
      const key = this.getKey(x, y, zoom);
      if (visibleKeys.has(key) || parents.has(key)) continue;
      parents.add(key);
      if (this.loadedTiles.has(key) || this.loading.has(key)) continue;
      if (this.pending.some((request) => request.key === key)) continue;
      if (this.tileCache.has(key)) {
        this.restoreFromCache(key);
        continue;
      }

      this.enqueue(key, x, y, zoom, Math.max(0, tile.priority - (tile.zoom - zoom)), true);
    }
    return parents;
  }

  /**
   * 确保存在一层覆盖整个视野的粗层级"底图毯"瓦片：
   * 快速旋转/倾斜视角时，新暴露的区域在当前 LOD 往往没有已加载瓦片，
   * 祖先也早已被缓存淘汰，等待网络期间屏幕出现大块黑色。
   * 底图毯以最低优先级加载、常驻保留（不 fade-out、请求不被取消），
   * 渲染顺序和 polygonOffset 决定它永远垫在精细瓦片之下，仅作兜底。
   */
  private ensureBaseLayer(
    viewLngBounds: [number, number],
    viewLatBounds: [number, number],
    terrainZoom: number,
  ): Set<TileKey> {
    const baseKeys = new Set<TileKey>();
    const BASE_MAX_TILES = 48;
    // 从 terrainZoom-1 向下找第一个覆盖视野瓦片数不超过上限的层级
    let baseZoom = terrainZoom - 1;
    let xStart = 0;
    let xEnd = 0;
    let yStart = 0;
    let yEnd = 0;
    while (baseZoom >= this.minZoom) {
      const sw = lngLatToGeoTile(viewLngBounds[0], viewLatBounds[0], baseZoom, this.tileYOrigin);
      const ne = lngLatToGeoTile(viewLngBounds[1], viewLatBounds[1], baseZoom, this.tileYOrigin);
      xStart = Math.min(sw.x, ne.x);
      xEnd = Math.max(sw.x, ne.x);
      yStart = Math.min(sw.y, ne.y);
      yEnd = Math.max(sw.y, ne.y);
      const count = (xEnd - xStart + 1) * (yEnd - yStart + 1);
      if (count <= BASE_MAX_TILES) break;
      baseZoom--;
    }
    if (baseZoom < this.minZoom || baseZoom >= terrainZoom) return baseKeys;

    for (let x = xStart; x <= xEnd; x++) {
      for (let y = yStart; y <= yEnd; y++) {
        // 服务端不保证每个坐标都有 .terrain（availability 存在空洞），
        // 必须解析到实际可用的祖先瓦片，否则会产生 404 请求
        const resolved = this.resolveAvailableAncestor(x, y, baseZoom);
        if (!resolved) continue;
        const key = this.getKey(resolved.x, resolved.y, resolved.zoom);
        baseKeys.add(key);
        if (this.loadedTiles.has(key)) continue;
        if (this.restoreFromCache(key)) continue;
        // 极低优先级（排在所有视野瓦片之后），isFallback 使其不受
        // currentVisibleKeys 检查限制、影像画布也用较小的尺寸
        this.enqueue(
          key,
          resolved.x,
          resolved.y,
          resolved.zoom,
          Number.MAX_SAFE_INTEGER / 2,
          true,
        );
      }
    }
    return baseKeys;
  }

  private cancelExcept(visibleKeys: Set<TileKey>, retainedKeys: Set<TileKey> = new Set()) {
    this.pending = this.pending.filter((r) => visibleKeys.has(r.key) || retainedKeys.has(r.key));
    this.pendingTerrainRenders = this.pendingTerrainRenders.filter((task) => {
      if (visibleKeys.has(task.key) || retainedKeys.has(task.key)) return true;
      task.abortController.abort();
      this.disposePendingTerrainRender(task);
      this.loading.delete(task.key);
      return false;
    });
    for (const [key, req] of this.loading) {
      // Do not abort an active transport on every camera update. During a
      // continuous zoom/tilt gesture that would repeatedly cancel the only
      // requests capable of producing the first visible terrain mesh.
      if (!visibleKeys.has(key) && !retainedKeys.has(key) && !req.started) {
        req.abortController.abort();
        this.loading.delete(key);
      }
    }
    for (const key of this.failedTiles.keys()) {
      const failure = this.failedTiles.get(key);
      if (!failure?.permanent && !visibleKeys.has(key) && !retainedKeys.has(key)) {
        this.failedTiles.delete(key);
      }
    }
  }

  /**
   * 空闲时投机预取"下一级"地形数据。
   *
   * 只下载 .terrain 原始字节进持久化缓存，**不建网格、不拉影像**：
   * - 单块成本低（约 65KB），优先级排在底图毯之后；
   * - 用户真正缩放进来时 fetchTerrain 直接命中缓存，省掉地形本身的
   *   网络往返，网格构建与影像请求可以立刻并行推进，缩放不再“等一拍”。
   *
   * 只在管线完全空闲（没有排队/在途的可见瓦片）时触发；一旦出现真实
   * 加载任务立即取消在途预取，把带宽让回可见区域。
   */
  private prefetchNextLevel(): void {
    if (this.disposed || this.prefetchTileBudget <= 0) return;
    // 没有 availability 就不知道哪些瓦片真实存在，投机请求会刷出 404
    if (!this.terrainAvailability) return;

    if (this.pending.length > 0 || this.loading.size > 0) {
      this.cancelPrefetch();
      return;
    }

    const now = performance.now();
    if (now - this.lastPrefetchAt < 500) return;
    this.lastPrefetchAt = now;
    if (this.prefetchAttempted.size >= MAX_PREFETCH_TOTAL) return;

    // 只预取"最深层可见瓦片"的子级：更粗的 fallback 子级未必是目标 LOD
    let deepestZoom = this.minZoom;
    for (const key of this.currentVisibleKeys) {
      const zoom = Number(key.slice(key.lastIndexOf(",") + 1));
      if (zoom > deepestZoom) deepestZoom = zoom;
    }
    if (deepestZoom >= this.maxZoom) return;

    let budget = Math.min(this.prefetchTileBudget, MAX_PREFETCH_TOTAL - this.prefetchAttempted.size);
    if (budget <= 0) return;
    if (this.prefetchInFlight >= MAX_PREFETCH_IN_FLIGHT) return;
    if (!this.prefetchController) this.prefetchController = new AbortController();
    const signal = this.prefetchController.signal;

    for (const key of this.currentVisibleKeys) {
      if (budget <= 0 || this.prefetchInFlight >= MAX_PREFETCH_IN_FLIGHT) break;
      const [x, y, zoom] = key.split(",").map(Number);
      if (zoom !== deepestZoom) continue;
      const entry = this.loadedTiles.get(key);
      // 当前视野先铺满影像，再做投机加载，避免抢占首屏带宽
      if (!entry || !entry.imageryReady) continue;
      if (zoom + 1 > this.maxZoom) continue;

      for (const [childX, childY] of [
        [x * 2, y * 2],
        [x * 2 + 1, y * 2],
        [x * 2, y * 2 + 1],
        [x * 2 + 1, y * 2 + 1],
      ]) {
        if (budget <= 0 || this.prefetchInFlight >= MAX_PREFETCH_IN_FLIGHT) break;
        const childZoom = zoom + 1;
        if (!this.isTileAvailable(childX, childY, childZoom)) continue;
        const childKey = this.getKey(childX, childY, childZoom);
        if (this.loadedTiles.has(childKey) || this.tileCache.has(childKey)) continue;
        if (this.loading.has(childKey) || this.prefetchAttempted.has(childKey)) continue;

        this.prefetchAttempted.add(childKey);
        this.prefetchInFlight++;
        budget--;
        void this.fetchTerrain(childX, childY, childZoom, signal, PREFETCH_PRIORITY)
          .catch(() => undefined)
          .finally(() => {
            this.prefetchInFlight = Math.max(0, this.prefetchInFlight - 1);
          });
      }
    }
  }

  /** 出现真实加载任务时取消在途预取，把并发与带宽让给可见区域。 */
  private cancelPrefetch(): void {
    if (!this.prefetchController && this.prefetchInFlight === 0) return;
    this.prefetchController?.abort();
    this.prefetchController = null;
    this.prefetchInFlight = 0;
  }

  private processQueue() {
    this.pending.sort((a, b) => a.priority - b.priority);
    let started = 0;
    while (
      this.pending.length > 0 &&
      this.loading.size < this.maxConcurrent &&
      started < this.maxRequestsPerFrame
    ) {
      const req = this.pending.shift()!;
      this.startLoad(req);
      started++;
    }
  }

  private processTerrainRenderQueue(): void {
    this.pendingTerrainRenders.sort((a, b) => a.priority - b.priority);
    let rendered = 0;

    while (this.pendingTerrainRenders.length > 0 && rendered < this.maxTileRendersPerFrame) {
      // 取第一个已就绪（Worker 构建完成）的任务；未就绪的保持排队，
      // 避免队首高优先级瓦片阻塞后面已可渲染的低优先级瓦片。
      let taskIndex = -1;
      for (let i = 0; i < this.pendingTerrainRenders.length; i++) {
        const t = this.pendingTerrainRenders[i];
        if (!t.meshJob || t.meshJob.settled) {
          taskIndex = i;
          break;
        }
      }
      if (taskIndex < 0) break;
      const task = this.pendingTerrainRenders.splice(taskIndex, 1)[0];
      if (task.abortController.signal.aborted || !this.loading.has(task.key)) {
        this.disposePendingTerrainRender(task);
        continue;
      }
      if (!this.currentVisibleKeys.has(task.key) && !task.isFallback) {
        this.loading.delete(task.key);
        this.disposePendingTerrainRender(task);
        continue;
      }

      try {
        const bounds = geoTileBounds(task.x, task.y, task.zoom, this.tileYOrigin);
        let geometry: THREE.BufferGeometry;
        let maxHeight: number;
        const job = task.meshJob;
        if (job) {
          if (job.error) {
            // buffer 已转移给 Worker 时无法回退，只能按失败处理（重试走退避）
            if (task.terrainBuffer && task.terrainBuffer.byteLength > 0) {
              const decoded = parseQuantizedMesh(task.terrainBuffer);
              geometry = this.buildTerrainGeometry(decoded, bounds, task.zoom);
              maxHeight = decoded.maxHeight;
            } else {
              throw job.error;
            }
          } else {
            const result = job.result!;
            geometry = this.buildGeometryFromArrays(result);
            maxHeight = result.maxHeight;
            // 真实瓦片的基准网格（无裙边）回填上采样源缓存
            if (!task.virtual) this.rememberSourceArrays(task.key, result);
          }
        } else {
          const decoded = parseQuantizedMesh(task.terrainBuffer!);
          geometry = this.buildTerrainGeometry(decoded, bounds, task.zoom);
          maxHeight = decoded.maxHeight;
        }
        // 调试着色模式仍挂载 childVisibility 着色器（它才是"谁最终画这个像素"
        // 的判定），只是不装纹理，直接用层级纯色铺上去。
        const [tileX, tileY] = task.key.split(",").map(Number);
        const mesh = this.createTerrainMesh(
          geometry,
          task.zoom,
          this.needsImagery() || this.debugColorByZoom,
          this.debugColorByZoom ? debugZoomColorHex(task.zoom, tileX, tileY) : undefined,
        );

        this.loading.delete(task.key);
        this.failedTiles.delete(task.key);
        const surfaceHeight = Math.max(0, maxHeight * this.exaggeration);
        this.maximumObservedSurfaceHeight = Math.max(
          this.maximumObservedSurfaceHeight,
          surfaceHeight,
        );
        const entry: TerrainTileEntry = {
          mesh,
          key: task.key,
          surfaceHeight,
          imageryZoom: task.initialImageryZoom,
          imageryCoverage: null,
          pendingImageryZoom: this.needsImagery() ? task.initialImageryZoom : null,
          imageryZoomCap: null,
          imageryRetryAt: 0,
          imageryFailures: 0,
          bornAt: performance.now(),
          imageryReady: !this.needsImagery(),
          revealPending: false,
        };
        this.loadedTiles.set(task.key, entry);
        this.add(mesh);
        this.hideCoveredAncestors();
        this.updateTerrainChildOcclusion();

        if (task.imageryPromise) {
          task.imageryAttached = true;
          task.imageryPromise
            .then((result) => {
              if (!result) {
                // 影像失败或被中止：保持 imageryReady=false（瓦片不可见）。
                // computeFallbackKeys 会把未就绪的瓦片视为未解析，其已加载的
                // 父级继续显示兜底；upgradeTileImagery 在后续视图更新时重试。
                // 绝不标记就绪——那会让瓦片以灰色兜底色淡入（转视角时反复出现）。
                return;
              }
              const { texture, zoom, coverage } = result;
              if (task.abortController.signal.aborted) {
                texture.dispose();
                return;
              }
              if (!this.loadedTiles.has(task.key) && !this.tileCache.has(task.key)) {
                texture.dispose();
                return;
              }
              // 切到调试着色模式后迟到的影像：丢弃，别盖掉层级纯色
              if (this.debugColorByZoom) {
                texture.dispose();
                return;
              }
              const material = mesh.material as THREE.MeshBasicMaterial;
              material.map = texture;
              material.color.set(0xffffff);
              material.needsUpdate = true;
              entry.imageryZoom = zoom;
              entry.imageryCoverage = coverage;
              entry.imageryReady = true;
              entry.pendingImageryZoom = null;
              // 入场节拍：同一帧批量就绪的瓦片依次亮起，而不是整片同时淡入
              this.enqueueReveal(task.key, entry);
              this.hideCoveredAncestors();
              this.updateTerrainChildOcclusion();
            })
            .finally(() => {
              if (entry.pendingImageryZoom === task.initialImageryZoom) {
                entry.pendingImageryZoom = null;
              }
            });
        }
        rendered++;
      } catch (error: unknown) {
        this.disposePendingTerrainRender(task);
        if (!task.abortController.signal.aborted) {
          this.loading.delete(task.key);
          this.recordTerrainFailure(task.key, error);
        }
      }
    }
    this.processQueue();
  }

  /** 把下载好的 .terrain buffer 提交给 Worker 构建（所有权转移） */
  private createTerrainMeshJob(
    terrainBuffer: ArrayBuffer,
    bounds: { west: number; east: number; south: number; north: number },
    zoom: number,
  ): TerrainMeshJob {
    const building = this.terrainMeshPool.build(terrainBuffer, {
      west: bounds.west,
      east: bounds.east,
      south: bounds.south,
      north: bounds.north,
      exaggeration: this.exaggeration,
      radius: this.gis.R,
      originMx: this.gis.originMx,
      originMy: this.gis.originMy,
      addSkirt: !this.wireframe,
      zoom,
    });
    return this.wrapMeshJob(building);
  }

  /** 统一包装构建 promise：同时给出 onFulfilled / onRejected，消费掉
   * 拒绝（统一由 processTerrainRenderQueue 读取 job.error），避免任务被
   * abort 或 Worker 失败时出现 unhandled rejection。 */
  private wrapMeshJob(building: Promise<TerrainMeshArrays>): TerrainMeshJob {
    const job: TerrainMeshJob = { settled: false };
    building.then(
      (result) => {
        job.settled = true;
        job.result = result;
      },
      (error) => {
        job.settled = true;
        job.error = error;
      },
    );
    return job;
  }

  /** 用 Worker 返回的 TypedArray 组装几何体（零拷贝；MeshBasicMaterial 无需法线） */
  private buildGeometryFromArrays(arrays: TerrainMeshArrays): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(arrays.positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(arrays.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
    return geo;
  }

  private createTerrainMesh(
    geometry: THREE.BufferGeometry,
    zoom: number,
    requiresImagery: boolean,
    colorOverride?: number,
  ): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({
      // Geometry must remain visible while imagery is pending or unavailable.
      // The texture is installed later without making terrain visibility depend
      // on a second network request.
      color: colorOverride ?? (requiresImagery ? TERRAIN_FALLBACK_COLOR : 0xffffff),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -(zoom * 4 + 4),
      polygonOffsetUnits: -zoom,
      transparent: true,
      opacity: 0,
    });

    const childVisibility = new THREE.Vector4(0, 0, 0, 0);
    material.userData.childVisibility = childVisibility;
    if (requiresImagery) {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.childVisibility = { value: childVisibility };
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec2 vTerrainUv;")
          .replace("#include <uv_vertex>", "#include <uv_vertex>\nvTerrainUv = uv;");
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            ["#include <common>", "varying vec2 vTerrainUv;", "uniform vec4 childVisibility;"].join(
              "\n",
            ),
          )
          .replace(
            "#include <map_fragment>",
            [
              "vec2 childUv = floor(clamp(vTerrainUv, vec2(0.0), vec2(0.999999)) * 2.0);",
              "bool childHidden =",
              "  (childUv.x < 0.5 && childUv.y < 0.5 && childVisibility.x > 0.5) ||",
              "  (childUv.x > 0.5 && childUv.y < 0.5 && childVisibility.y > 0.5) ||",
              "  (childUv.x < 0.5 && childUv.y > 0.5 && childVisibility.z > 0.5) ||",
              "  (childUv.x > 0.5 && childUv.y > 0.5 && childVisibility.w > 0.5);",
              "if (childHidden) discard;",
              "#include <map_fragment>",
            ].join("\n"),
          );
      };
    }

    const mesh = new THREE.Mesh(geometry, material);
    if (this.wireframe) {
      const wireMaterial = new THREE.MeshBasicMaterial({
        color: 0x67e8f9,
        wireframe: true,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -(zoom + 3),
        polygonOffsetUnits: -2,
      });
      const wireMesh = new THREE.Mesh(geometry, wireMaterial);
      wireMesh.renderOrder = zoom + 1000;
      mesh.userData.wireframeMaterial = wireMaterial;
      mesh.add(wireMesh);
    }
    mesh.visible = true;
    mesh.renderOrder = zoom;
    return mesh;
  }

  private disposePendingTerrainRender(task: PendingTerrainRender): void {
    if (!task.imageryAttached && task.imageryPromise) {
      void task.imageryPromise.then((result) => result?.texture.dispose());
    }
  }

  private disposeTerrainMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose();
    const material = mesh.material as THREE.Material;
    material.dispose();
    const wireMaterial = mesh.userData.wireframeMaterial as THREE.Material | undefined;
    wireMaterial?.dispose();
  }

  private recordTerrainFailure(key: TileKey, error: unknown): void {
    const errorName = error instanceof Error ? error.name : undefined;
    if (errorName === "AbortError") return;

    const now = Date.now();
    const retries = (this.failedTiles.get(key)?.retries ?? 0) + 1;
    const status = error instanceof HttpStatusError ? error.status : null;
    const permanent = isPermanentHttpStatus(status);
    const backoff = permanent
      ? Number.POSITIVE_INFINITY
      : Math.min(this.retryCooldown * Math.pow(2, Math.min(retries - 1, 4)), this.maxRetryCooldown);
    this.failedTiles.set(key, {
      retries,
      lastAttempt: now,
      nextAttempt: now + backoff,
      permanent,
    });
    if (!permanent && (retries <= this.maxRetries || retries % 5 === 0)) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[CesiumTerrainLayer] 加载失败 ${key} (第 ${retries} 次，${Math.round(backoff / 1000)} 秒后重试):`,
        message,
      );
    }
  }

  private async startLoad(req: PendingRequest) {
    if (req.virtual) {
      await this.startVirtualLoad(req);
      return;
    }
    this.loading.set(req.key, req);
    const { x, y, zoom, key } = req;
    const signal = req.abortController.signal;
    const targetImageryZoom = this.getTileImageryZoom(x, y, zoom);
    const initialImageryZoom = this.getInitialTileImageryZoom(zoom, targetImageryZoom);
    const requiresImagery = this.needsImagery();
    const projectedCanvasSize = this.getTileImageryCanvasSize(x, y, zoom);
    const imageryCanvasSize = req.isFallback
      ? Math.min(512, this.imageryMaxCanvasSize, projectedCanvasSize)
      : projectedCanvasSize;
    let imageryPromise: Promise<ImageryFetchResult | null> | null = null;
    const imageryAttached = false;
    const disposeUnclaimedImagery = (): void => {
      if (imageryAttached || !imageryPromise) return;
      void imageryPromise.then((result) => result?.texture.dispose());
    };

    try {
      imageryPromise = requiresImagery
        ? this.fetchImagery(x, y, zoom, initialImageryZoom, signal, imageryCanvasSize, 0).catch(
            () => null,
          )
        : null;
      const terrainBuffer = await this.fetchTerrain(x, y, zoom, signal, req.priority, () => {
        req.started = true;
      });
      if (signal.aborted || !this.loading.has(key)) return;

      const task: PendingTerrainRender = {
        key,
        x,
        y,
        zoom,
        priority: req.priority,
        isFallback: req.isFallback,
        virtual: false,
        abortController: req.abortController,
        terrainBuffer,
        meshJob: null,
        imageryPromise,
        imageryAttached: false,
        initialImageryZoom,
      };
      // CPU 密集的解析 + 顶点展开 + 裙边合并放入 Worker，主线程只在结果
      // 就绪后组装 BufferGeometry，避免提交渲染时阻塞渲染循环。
      if (this.terrainMeshPool.available) {
        const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
        task.meshJob = this.createTerrainMeshJob(terrainBuffer, bounds, zoom);
      }
      this.pendingTerrainRenders.push(task);

      // 影像异步加载，完成后替换纹理
    } catch (err: unknown) {
      disposeUnclaimedImagery();
      if (signal.aborted) return;
      this.loading.delete(key);
      this.recordPendingFailure(key, err);
    }
  }

  /** 统一的加载失败记录（退避重试策略），供真实/虚拟瓦片加载共用 */
  private recordPendingFailure(key: TileKey, err: unknown): void {
    const errorName = err instanceof Error ? err.name : undefined;
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (errorName !== "AbortError") {
      const now = Date.now();
      const retries = (this.failedTiles.get(key)?.retries ?? 0) + 1;
      const status = err instanceof HttpStatusError ? err.status : null;
      const permanent = isPermanentHttpStatus(status);
      const backoff = permanent
        ? Number.POSITIVE_INFINITY
        : Math.min(
            this.retryCooldown * Math.pow(2, Math.min(retries - 1, 4)),
            this.maxRetryCooldown,
          );
      this.failedTiles.set(key, {
        retries,
        lastAttempt: now,
        nextAttempt: now + backoff,
        permanent,
      });
      if (!permanent && (retries <= this.maxRetries || retries % 5 === 0)) {
        console.warn(
          `[CesiumTerrainLayer] 加载失败 ${key} (第 ${retries} 次，${Math.round(backoff / 1000)} 秒后重试):`,
          errorMessage,
        );
      }
    }
  }

  /**
   * 虚拟瓦片加载：不发地形请求。几何由最近可用祖先的基准网格（无裙边）
   * 上采样重采样得到；祖先本身由 enqueueFallbackParents 作为兜底瓦片
   * 加载渲染，虚拟瓦片就绪后由遮挡/深度策略覆盖它。
   */
  private async startVirtualLoad(req: PendingRequest) {
    this.loading.set(req.key, req);
    const { x, y, zoom, key } = req;
    const signal = req.abortController.signal;
    const targetImageryZoom = this.getTileImageryZoom(x, y, zoom);
    const initialImageryZoom = this.getInitialTileImageryZoom(zoom, targetImageryZoom);
    const imageryPromise = this.needsImagery()
      ? this.fetchImagery(
          x,
          y,
          zoom,
          initialImageryZoom,
          signal,
          this.getTileImageryCanvasSize(x, y, zoom),
          0,
        ).catch(() => null)
      : null;
    const disposeUnclaimedImagery = (): void => {
      if (!imageryPromise) return;
      void imageryPromise.then((result) => result?.texture.dispose());
    };

    try {
      const source = this.resolveAvailableAncestor(x, y, zoom);
      if (!source) throw new Error("Virtual tile has no available terrain ancestor.");
      const sourceArrays = await this.ensureSourceArrays(
        source.x,
        source.y,
        source.zoom,
        signal,
        req.priority,
      );
      if (signal.aborted || !this.loading.has(key)) {
        disposeUnclaimedImagery();
        return;
      }

      const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
      const params = {
        west: bounds.west,
        east: bounds.east,
        south: bounds.south,
        north: bounds.north,
        exaggeration: this.exaggeration,
        radius: this.gis.R,
        originMx: this.gis.originMx,
        originMy: this.gis.originMy,
        addSkirt: !this.wireframe,
        zoom,
        segments: VIRTUAL_TILE_SEGMENTS,
      };
      let meshJob: TerrainMeshJob;
      if (this.terrainMeshPool.available) {
        meshJob = this.wrapMeshJob(this.terrainMeshPool.upsample(sourceArrays, params));
      } else {
        // Worker 不可用（诊断环境）：主线程同步上采样
        meshJob = { settled: true, result: upsampleTerrainMesh(sourceArrays, params) };
      }

      const task: PendingTerrainRender = {
        key,
        x,
        y,
        zoom,
        priority: req.priority,
        isFallback: req.isFallback,
        virtual: true,
        abortController: req.abortController,
        meshJob,
        imageryPromise,
        imageryAttached: false,
        initialImageryZoom,
      };
      this.pendingTerrainRenders.push(task);
    } catch (err: unknown) {
      disposeUnclaimedImagery();
      if (signal.aborted) return;
      this.loading.delete(key);
      this.recordPendingFailure(key, err);
    }
  }

  /** 取一块可用瓦片的基准网格（无裙边）作为上采样高程源 */
  private async ensureSourceArrays(
    x: number,
    y: number,
    zoom: number,
    signal: AbortSignal,
    priority: number,
  ): Promise<TerrainMeshBaseArrays> {
    const key = this.getKey(x, y, zoom);
    const cached = this.meshSourceCache.get(key);
    if (cached) {
      // LRU touch
      this.meshSourceCache.delete(key);
      this.meshSourceCache.set(key, cached);
      return cached;
    }
    const inflight = this.sourceArraysLoading.get(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<TerrainMeshBaseArrays> => {
      // 让一拍事件循环：同键瓦片可能正在正常构建，先等它回填缓存
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const warmed = this.meshSourceCache.get(key);
      if (warmed) return warmed;

      // 缓存缺失：重新拉取字节（通常命中持久化磁盘缓存），只解码不建裙边
      const buffer = await this.fetchTerrain(x, y, zoom, signal, priority);
      const afterFetch = this.meshSourceCache.get(key);
      if (afterFetch) return afterFetch;
      if (signal.aborted) throw new Error("aborted");

      const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
      const params = {
        west: bounds.west,
        east: bounds.east,
        south: bounds.south,
        north: bounds.north,
        exaggeration: this.exaggeration,
        radius: this.gis.R,
        originMx: this.gis.originMx,
        originMy: this.gis.originMy,
        addSkirt: false,
        zoom,
      };
      const arrays = this.terrainMeshPool.available
        ? await this.terrainMeshPool.build(buffer, params)
        : this.decodeTerrainArraysSync(buffer, bounds, zoom);
      this.rememberSourceArrays(key, arrays);
      return arrays;
    })();
    this.sourceArraysLoading.set(key, promise);
    promise.then(
      () => this.sourceArraysLoading.delete(key),
      () => this.sourceArraysLoading.delete(key),
    );
    return promise;
  }

  /** Worker 不可用时在主线程同步解码出基准网格数组（诊断/降级路径） */
  private decodeTerrainArraysSync(
    buffer: ArrayBuffer,
    bounds: { west: number; east: number; south: number; north: number },
    zoom: number,
  ): TerrainMeshArrays {
    const decoded = parseQuantizedMesh(buffer);
    const { vertexCount, u, v, height, indices, minHeight, maxHeight } = decoded;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const heightRange = maxHeight - minHeight;
    const southMercator = this.gis.lngLatToMercator(
      0,
      THREE.MathUtils.clamp(bounds.south, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
    )[1];
    const northMercator = this.gis.lngLatToMercator(
      0,
      THREE.MathUtils.clamp(bounds.north, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
    )[1];
    const mercatorRange = Math.max(northMercator - southMercator, 1e-9);
    for (let i = 0; i < vertexCount; i++) {
      const lng = bounds.west + (u[i] / 32767) * (bounds.east - bounds.west);
      const lat = bounds.south + (v[i] / 32767) * (bounds.north - bounds.south);
      let alt = minHeight + (height[i] / 32767) * heightRange;
      if (this.exaggeration !== 1.0) alt *= this.exaggeration;
      const p = this.gis.lngLatToThree(lng, lat, alt);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      uvs[i * 2] = u[i] / 32767;
      const mercatorY = this.gis.lngLatToMercator(
        0,
        THREE.MathUtils.clamp(lat, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
      )[1];
      uvs[i * 2 + 1] = THREE.MathUtils.clamp((mercatorY - southMercator) / mercatorRange, 0, 1);
    }
    return { positions, uvs, indices, minHeight, maxHeight, vertexCount };
  }

  /** 记录一块瓦片的基准网格（LRU），供后续虚拟细分作高程源 */
  private rememberSourceArrays(key: TileKey, arrays: TerrainMeshArrays): void {
    if (this.meshSourceCache.has(key)) return;
    const base = arrays.base ?? arrays;
    this.meshSourceCache.set(key, base);
    while (this.meshSourceCache.size > MESH_SOURCE_CACHE_MAX) {
      const oldest = this.meshSourceCache.keys().next().value;
      if (oldest === undefined) break;
      this.meshSourceCache.delete(oldest);
    }
  }

  // ─── 网络请求 ───────────────────────────────────────────────

  private async initializeTerrainSource(): Promise<void> {
    // 初始化失败必须重试：元数据/Ion 交换走网络，代理抖动或单次超时（请求
    // 现在带 20s 超时）都会让首次尝试失败。此前失败只告警一次、整个图层
    // 永远停在"未就绪"（currentCamera 不赋值 → LOD/调度全部停摆，页面
    // 看似空白直到手动刷新）。退避 2s/5s/10s 共 4 次尝试。
    const delays = [0, 2000, 5000, 10000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await this.sleep(delays[attempt]);
      if (this.disposed) return;
      try {
        if (this.isCesiumIonUrl()) {
          // 打印 token 指纹，便于发现"浏览器内联的是旧 token"（env 更新后未重启 dev server）
          const fp =
            this.accessToken.length > 14
              ? `${this.accessToken.slice(0, 8)}…${this.accessToken.slice(-6)}`
              : "(空)";
          console.info(`[CesiumTerrainLayer] Ion token ${fp}，开始交换资源凭据…`);
          await this.resolveIonAssetEndpoint();
          console.info("[CesiumTerrainLayer] Ion 资源凭据交换成功");
        }
        await this.loadTilingScheme();
        return;
      } catch (error: unknown) {
        if (this.disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        const last = attempt === delays.length - 1;
        console.warn(
          `[CesiumTerrainLayer] 地形源初始化失败（第 ${attempt + 1}/${delays.length} 次）:`,
          message,
          last ? "—— 放弃，可刷新页面重试" : "—— 将退避重试",
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // dispose 时立刻结束等待，避免拖住资源释放
      this.lifecycleController.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  /**
   * 重新交换 Ion 资源 token（短期凭据过期时调用）。
   * 并发的 401 重试共享同一次刷新，避免风暴式重复交换。
   */
  private refreshIonToken(): Promise<void> {
    if (!this.ionTokenRefresh) {
      const pending = this.resolveIonAssetEndpoint().finally(() => {
        if (this.ionTokenRefresh === pending) this.ionTokenRefresh = null;
      });
      this.ionTokenRefresh = pending;
    }
    return this.ionTokenRefresh;
  }

  private async resolveIonAssetEndpoint(): Promise<void> {
    const endpoint = new URL("https://api.cesium.com/v1/assets/1/endpoint");
    endpoint.searchParams.set("access_token", this.accessToken);
    const response = await fetch(endpoint, {
      signal: this.metadataController.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      let reason = "";
      try {
        const payload = (await response.json()) as { code?: string; message?: string };
        reason = [payload.code, payload.message].filter(Boolean).join(": ");
      } catch {
        /* 响应体不是 JSON 时忽略 */
      }
      throw new Error(
        `Ion endpoint HTTP ${response.status}${reason ? ` — ${reason}` : ""}` +
          (response.status === 401
            ? "（Ion 默认 token 不能直接访问 asset depot，且需检查 token 是否有效）"
            : ""),
      );
    }
    const payload = (await response.json()) as {
      type?: string;
      url?: string;
      accessToken?: string;
    };
    if (payload.type !== "TERRAIN" || !payload.url || !payload.accessToken) {
      throw new Error("Ion endpoint did not return a terrain resource.");
    }
    const resourceUrl = new URL(payload.url);
    if (resourceUrl.protocol !== "https:") {
      throw new Error("Ion terrain endpoint must use HTTPS.");
    }
    if (this.hasExplicitTileTemplate) {
      const templateStart = this.terrainUrl.indexOf("{z}");
      if (templateStart < 0) throw new Error("Terrain template is missing {z}.");
      const templateSuffix = this.terrainUrl.slice(templateStart);
      this.terrainUrl = `${resourceUrl.toString().replace(/\/$/, "")}/${templateSuffix}`;
    } else {
      this.terrainUrl = resourceUrl.toString().replace(/\/$/, "");
      this.isTileUrlTemplate = false;
    }
    this.ionResourceToken = payload.accessToken;
  }

  private async loadTilingScheme(): Promise<void> {
    const timeout = setTimeout(() => this.metadataController.abort(), 5000);
    let succeeded = false;
    try {
      const response = await fetch(this.getTerrainMetadataUrl(), {
        signal: this.metadataController.signal,
        headers: this.getTerrainHeaders("application/json"),
      });
      if (!response.ok || this.disposed) {
        if (!this.disposed && (response.status === 401 || response.status === 403)) {
          // 打印服务端的具体原因（如 InvalidCredentials），帮助定位是
          // token 过期/被吊销还是资源无权限，而不是静默降级
          let reason = "";
          try {
            const payload = (await response.json()) as { message?: string; code?: string };
            reason = [payload.code, payload.message].filter(Boolean).join(": ");
          } catch {
            /* 响应体不是 JSON 时忽略 */
          }
          throw new Error(
            `Terrain authorization failed (HTTP ${response.status})${reason ? ` — ${reason}` : ""}.` +
              ` 请检查 CesiumTerrainLayer 的 accessToken（NEXT_PUBLIC_CESIUM_ION_TOKEN）是否有效。`,
          );
        }
        return;
      }
      const metadata = (await response.json()) as {
        scheme?: unknown;
        tiles?: unknown;
        version?: unknown;
        maxzoom?: unknown;
        available?: unknown;
        valid_bounds?: unknown;
      };
      if (Array.isArray(metadata.tiles) && typeof metadata.tiles[0] === "string") {
        this.terrainTileTemplate = metadata.tiles[0];
      }
      if (typeof metadata.version === "string") this.terrainVersion = metadata.version;
      if (typeof metadata.maxzoom === "number" && Number.isInteger(metadata.maxzoom)) {
        this.maxZoom = Math.min(this.maxZoom, metadata.maxzoom);
      }
      this.terrainAvailability = this.parseAvailability(metadata.available);
      this.terrainValidBounds = this.parseValidBounds(metadata.valid_bounds);
      if (metadata.scheme === "slippyMap") this.tileYOrigin = "north";
      else if (metadata.scheme === "tms") this.tileYOrigin = "south";
      succeeded = true;
    } catch (error: unknown) {
      if (this.ionResourceToken) throw error;
      // 鉴权失败必须让开发者看到（token 过期/无效是最常见的 401 原因）；
      // 其余错误（如老服务只有 .terrain 文件、无 layer.json）保持静默降级。
      if (error instanceof Error && error.message.includes("authorization")) {
        console.error(`[CesiumTerrainLayer] ${error.message}`);
      }
    } finally {
      clearTimeout(timeout);
      if (succeeded || !this.ionResourceToken) this.metadataReady = true;
    }
  }

  private getTerrainHeaders(accept: string): Record<string, string> {
    const isLocal = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)(?::|\/|$)/.test(this.terrainUrl);
    const isCesiumIon = this.isCesiumIonUrl();
    const headers: Record<string, string> = { Accept: accept };
    // 本地服务不需要认证，且 Authorization 头会触发 CORS 预检
    if (this.ionResourceToken) {
      headers.Authorization = `Bearer ${this.ionResourceToken}`;
    } else if (!isLocal && !isCesiumIon && this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  private getTerrainUrl(path: string): string {
    let url: string;
    if (this.isTileUrlTemplate) {
      const match = path.match(/^(\d+)\/(\d+)\/(\d+)\.terrain$/);
      if (!match) {
        throw new Error("A terrain URL template requires a z/x/y terrain path.");
      }
      url = this.terrainUrl
        .replaceAll("{z}", match[1])
        .replaceAll("{x}", match[2])
        .replaceAll("{y}", match[3]);
      // layer.json 报告的版本可能与模板里硬编码的 v= 不一致，
      // 过期版本号会被服务端 404；用元数据里的实际版本覆盖。
      if (this.terrainVersion) {
        url = url.replace(/([?&])v=[^&]*/, `$1v=${encodeURIComponent(this.terrainVersion)}`);
      }
    } else if (this.ionResourceToken && this.terrainTileTemplate) {
      const match = path.match(/^(\d+)\/(\d+)\/(\d+)\.terrain$/);
      if (!match) throw new Error("Invalid terrain tile path.");
      const tilePath = this.terrainTileTemplate
        .replaceAll("{z}", match[1])
        .replaceAll("{x}", match[2])
        .replaceAll("{y}", match[3])
        .replaceAll("{version}", this.terrainVersion ?? "");
      url = new URL(tilePath, `${this.terrainUrl}/`).toString();
    } else {
      url = `${this.terrainUrl}/${path.replace(/^\//, "")}`;
    }
    if (this.ionResourceToken) return url;
    const isCesiumIon = this.isCesiumIonUrl();
    if (!isCesiumIon || !this.accessToken) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}access_token=${encodeURIComponent(this.accessToken)}`;
  }

  private getTerrainMetadataUrl(): string {
    if (!this.isTileUrlTemplate) return this.getTerrainUrl("layer.json");

    const templateStart = this.terrainUrl.indexOf("{z}");
    if (templateStart < 0) {
      throw new Error("A terrain URL template is missing the {z} placeholder.");
    }

    // Ion's endpoint URL contains the tile template, while layer.json lives
    // beside that template. Strip the template path before requesting metadata
    // so explicit Ion templates can still use availability ranges.
    const baseUrl = this.terrainUrl.slice(0, templateStart).replace(/\/$/, "");
    let metadataUrl = `${baseUrl}/layer.json`;
    // .terrain 请求会在 getTerrainUrl 里追加 access_token，但 layer.json 的
    // 直拼路径不会——Ion asset depot 对元数据同样要求鉴权，缺 token 会 401，
    // 导致 availability/valid_bounds 全部丢失，后续请求落到不存在的瓦片上 404。
    // 注意：已通过 endpoint 交换持有短期资源 token 时（getTerrainHeaders 会带
    // Bearer 头）绝不能再往 URL 追加长期 token——服务端优先校验 query 参数，
    // 无效的长期 token 会压过头里有效的短期 token，导致 401。
    if (this.isCesiumIonUrl() && !this.ionResourceToken && this.accessToken) {
      metadataUrl += `?access_token=${encodeURIComponent(this.accessToken)}`;
    }
    return metadataUrl;
  }

  private isCesiumIonUrl(): boolean {
    return /(^|:\/\/)assets(?:\.ion)?\.cesium\.com(?:\/|$)/i.test(this.terrainUrl);
  }

  private parseAvailability(value: unknown): TileAvailability[][] | null {
    if (!Array.isArray(value)) return null;
    const levels: TileAvailability[][] = [];
    for (const level of value) {
      if (!Array.isArray(level)) return null;
      const ranges = level.filter(
        (range): range is TileAvailability =>
          typeof range === "object" &&
          range !== null &&
          Number.isInteger((range as TileAvailability).startX) &&
          Number.isInteger((range as TileAvailability).endX) &&
          Number.isInteger((range as TileAvailability).startY) &&
          Number.isInteger((range as TileAvailability).endY),
      );
      levels.push(ranges);
    }
    return levels;
  }

  private parseValidBounds(value: unknown): TerrainValidBounds | null {
    if (!Array.isArray(value) || value.length < 4) return null;
    const [west, south, east, north] = value.map(Number);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    return { west, south, east, north };
  }

  private resolveAvailableAncestor(
    x: number,
    y: number,
    zoom: number,
  ): { x: number; y: number; zoom: number } | null {
    let currentX = x;
    let currentY = y;
    let currentZoom = zoom;

    while (currentZoom >= this.minZoom) {
      if (this.isTileAvailable(currentX, currentY, currentZoom)) {
        return { x: currentX, y: currentY, zoom: currentZoom };
      }
      currentX = Math.floor(currentX / 2);
      currentY = Math.floor(currentY / 2);
      currentZoom--;
    }

    return null;
  }

  private isTileAvailable(x: number, y: number, zoom: number): boolean {
    const availability = this.terrainAvailability;
    if (availability) {
      const ranges = availability[zoom];
      if (
        !ranges ||
        !ranges.some(
          (range) => x >= range.startX && x <= range.endX && y >= range.startY && y <= range.endY,
        )
      )
        return false;
    }

    const validBounds = this.terrainValidBounds;
    if (!validBounds) return true;
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    return (
      bounds.east >= validBounds.west &&
      bounds.west <= validBounds.east &&
      bounds.north >= validBounds.south &&
      bounds.south <= validBounds.north
    );
  }

  /**
   * 地形瓦片请求，带超时。与影像子请求同理：挂起不回包的请求若无超时，
   * 瓦片会永久卡在 loading（地形没有 failedImagery 那样的退避入口），相机
   * 朝向它的区域就一直显示不出几何。超时抛 TimeoutError，由调用方记入
   * 退避重试；外部 signal 取消保持 AbortError 语义。
   */
  private fetchTerrainResponse(
    url: string,
    signal: AbortSignal,
    headers: HeadersInit,
    timeoutMs = 20000,
  ): Promise<Response> {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Task aborted.", "AbortError"));
    }
    const controller = new AbortController();
    let abortedByCaller = false;
    const onAbort = () => {
      abortedByCaller = true;
      controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    return fetch(url, { signal: controller.signal, headers }).finally(finish).then(
      (res) => res,
      (error) => {
        if (!abortedByCaller && controller.signal.aborted) {
          throw new DOMException("Terrain request timed out.", "TimeoutError");
        }
        throw error;
      },
    );
  }

  private fetchTerrain(
    x: number,
    y: number,
    zoom: number,
    signal: AbortSignal,
    priority: number,
    onStart?: () => void,
  ): Promise<ArrayBuffer> {
    const url = this.getTerrainUrl(`${zoom}/${x}/${y}.terrain`);
    const accept = "application/vnd.quantized-mesh,application/octet-stream;q=0.9";
    return requestScheduler.schedule({
      url,
      priority,
      signal,
      maximumRequestsPerServer: this.terrainMaximumRequestsPerServer,
      load: async () => {
        onStart?.();
        const cacheKey = this.getTerrainCacheKey(x, y, zoom);
        const disk = this.terrainDiskCache;

        // 1) 持久化缓存命中：整次网络往返都省掉（重复访问区域近乎瞬时）
        if (disk) {
          const cached = await disk.get(cacheKey);
          if (cached) {
            try {
              return await cached.arrayBuffer();
            } catch {
              void disk.delete(cacheKey);
            }
          }
        }

        // 请求成功即写入缓存；Blob 只在“下载完成”时产生，不会拖慢首帧
        const keep = (blob: Blob): Promise<ArrayBuffer> => {
          if (disk && !this.disposed) disk.put(cacheKey, blob);
          return blob.arrayBuffer();
        };

        const res = await this.fetchTerrainResponse(url, signal, this.getTerrainHeaders(accept));
        // Ion 资源 token 是短期凭据，长会话中会过期（表现为成批 401）。
        // 检测到 401 时重新走 endpoint 交换拿新 token，再重试一次。
        if (res.status === 401 && this.ionResourceToken && !signal.aborted) {
          await this.refreshIonToken();
          const retry = await this.fetchTerrainResponse(url, signal, this.getTerrainHeaders(accept));
          if (!retry.ok) throw new HttpStatusError(retry.status);
          return keep(await retry.blob());
        }
        if (!res.ok) throw new HttpStatusError(res.status);
        return keep(await res.blob());
      },
    });
  }

  /** 地形瓦片缓存键：版本 + 坐标系 + 瓦片坐标（与端点区域无关）。 */
  private getTerrainCacheKey(x: number, y: number, zoom: number): string {
    return `${this.terrainVersion ?? "0"}/${this.tileYOrigin}/${zoom}/${x}/${y}`;
  }

  /**
   * 多瓦片拼接影像（优化版）：
   * - 影像层级以相机目标层级为起点，所有地形瓦片共享同一影像层级，保证清晰度一致
   * - 仅当 Canvas 超过 MAX_CANVAS 时才逐级降低，避免低 LOD 瓦片产生过多请求
   * - 共享图片缓存：相邻地形瓦片复用相同 Mercator 影像，大幅减少网络请求
   * - Canvas 精确对齐地形瓦片边界，无缩放损失
   */
  private getImageryTilePriority(x: number, y: number, zoom: number): number {
    const bounds = getTileBounds(x, y, zoom);
    const center = this.gis.lngLatToThree(
      (bounds.west + bounds.east) / 2,
      (bounds.south + bounds.north) / 2,
      0,
    );
    const targetDistance = center.distanceTo(this.imageryPriorityTarget);
    if (!this.imageryPriorityCamera) return targetDistance;
    return Math.min(targetDistance, center.distanceTo(this.imageryPriorityCamera));
  }

  private isGeographicBoundsInFrustum(bounds: {
    west: number;
    east: number;
    south: number;
    north: number;
  }): boolean {
    const frustum = this.currentCameraFrustum;
    if (!frustum) return true;

    const height = this.maximumObservedSurfaceHeight;
    const box = new THREE.Box3().setFromPoints([
      this.gis.lngLatToThree(bounds.west, bounds.north, 0),
      this.gis.lngLatToThree(bounds.east, bounds.north, 0),
      this.gis.lngLatToThree(bounds.east, bounds.south, 0),
      this.gis.lngLatToThree(bounds.west, bounds.south, 0),
    ]);
    box.max.z = Math.max(box.max.z, height);
    return frustum.intersectsBox(box);
  }

  private fetchImagery(
    x: number,
    y: number,
    zoom: number,
    requestedImageryZoom: number,
    signal: AbortSignal,
    maxCanvasSize: number,
    priority = 1,
  ): Promise<ImageryFetchResult> {
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    const TILE_PX = 256;
    const MAX_CANVAS = maxCanvasSize;

    const lngToPixelX = (lng: number, n: number) => ((lng + 180) / 360) * n * TILE_PX;
    const latToPixelY = (lat: number, n: number) => {
      const clampedLat = THREE.MathUtils.clamp(
        lat,
        -WEB_MERCATOR_MAX_LATITUDE,
        WEB_MERCATOR_MAX_LATITUDE,
      );
      const rad = (clampedLat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TILE_PX;
    };

    // 从帧级影像层级开始，若 Canvas 过大则逐级降低
    let imageryZoom = requestedImageryZoom;
    let pxWest: number, pxEast: number, pxNorth: number, pxSouth: number;
    let canvasW: number, canvasH: number;

    while (imageryZoom >= zoom) {
      const n = Math.pow(2, imageryZoom);
      pxWest = lngToPixelX(bounds.west, n);
      pxEast = lngToPixelX(bounds.east, n);
      pxNorth = latToPixelY(bounds.north, n);
      pxSouth = latToPixelY(bounds.south, n);
      canvasW = Math.round(pxEast - pxWest);
      canvasH = Math.round(pxSouth - pxNorth);
      if (canvasW <= MAX_CANVAS && canvasH <= MAX_CANVAS) break;
      imageryZoom--;
    }
    // 兜底：至少使用地形层级 +1 的影像
    if (imageryZoom < zoom) imageryZoom = zoom;

    const n = Math.pow(2, imageryZoom);
    pxWest = lngToPixelX(bounds.west, n);
    pxEast = lngToPixelX(bounds.east, n);
    pxNorth = latToPixelY(bounds.north, n);
    pxSouth = latToPixelY(bounds.south, n);
    canvasW = Math.max(1, Math.round(pxEast - pxWest));
    canvasH = Math.max(1, Math.round(pxSouth - pxNorth));

    // 请求区域 = 视野 AABB 外扩 50% ∩ 瓦片范围：
    // - 剪裁：只请求视锥体（含余量）覆盖的子块，视野外不浪费请求；
    // - 余量：旋转/平移视角时新暴露的区域大概率已在请求范围内，
    //   覆盖度仍然满足 → 不触发重新请求，已加载瓦片纯 WebGL 渲染。
    // 画布仍对齐完整瓦片，纹理 UV 不受请求区域影响。
    const viewLng = this.currentViewLngBounds;
    const viewLat = this.currentViewLatBounds;
    let reqWest = bounds.west;
    let reqEast = bounds.east;
    let reqSouth = bounds.south;
    let reqNorth = bounds.north;
    if (viewLng && viewLat) {
      const lngSpan = viewLng[1] - viewLng[0];
      const latSpan = viewLat[1] - viewLat[0];
      reqWest = Math.min(bounds.east, Math.max(bounds.west, viewLng[0] - lngSpan * 0.5));
      reqEast = Math.max(bounds.west, Math.min(bounds.east, viewLng[1] + lngSpan * 0.5));
      reqSouth = Math.min(bounds.north, Math.max(bounds.south, viewLat[0] - latSpan * 0.5));
      reqNorth = Math.max(bounds.south, Math.min(bounds.north, viewLat[1] + latSpan * 0.5));
    }
    // 保守兜底：视野与瓦片无交集时请求完整瓦片
    if (reqWest > reqEast || reqSouth > reqNorth) {
      reqWest = bounds.west;
      reqEast = bounds.east;
      reqSouth = bounds.south;
      reqNorth = bounds.north;
    }
    const coverage = {
      west: reqWest,
      east: reqEast,
      south: reqSouth,
      north: reqNorth,
    };
    // 请求子块范围（仅覆盖请求区域）
    const tileXMin = Math.floor(lngToPixelX(reqWest, n) / TILE_PX);
    const tileXMax = Math.floor((lngToPixelX(reqEast, n) - 0.001) / TILE_PX);
    const tileYMin = Math.floor(latToPixelY(reqNorth, n) / TILE_PX);
    const tileYMax = Math.floor((latToPixelY(reqSouth, n) - 0.001) / TILE_PX);
    // 完整瓦片子块范围（用于父级缓存补绘整个画布）
    const fullXMin = Math.floor(pxWest / TILE_PX);
    const fullXMax = Math.floor((pxEast - 0.001) / TILE_PX);
    const fullYMin = Math.floor(pxNorth / TILE_PX);
    const fullYMax = Math.floor((pxSouth - 0.001) / TILE_PX);

    // 网络请求立即发出，但 drawImage 拼接与纹理创建延后进入 stitchQueue，
    // 由 update() 按每帧时间预算执行。放大后的升级风暴若直接在微任务里
    // 拼接（每块大画布上百次 drawImage + ~18MB 纹理上传），一帧内落地
    // 8 个就能把 FPS 拖到个位数。
    const readyOps: { img: ImageBitmap; tx: number; ty: number }[] = [];
    const pendingOps: Promise<{ img: ImageBitmap | null; tx: number; ty: number }>[] = [];
    let requestedImageCount = 0;
    for (let tx = tileXMin; tx <= tileXMax; tx++) {
      for (let ty = tileYMin; ty <= tileYMax; ty++) {
        const cacheKey = `${imageryZoom}/${tx}/${ty}`;

        const failure = this.failedImagery.get(cacheKey);
        if (failure?.permanent || (failure && Date.now() < failure.nextAttempt)) continue;

        // 缓存命中 → 无需网络请求
        const cached = this.imgCache.get(cacheKey);
        if (cached) {
          readyOps.push({ img: cached, tx, ty });
          continue;
        }

        const url = replaceTileTemplate(
          this.imageryUrlTemplate!,
          tx,
          ty,
          imageryZoom,
          this.imagerySubdomains,
        );

        requestedImageCount++;
        const p = this.getOrLoadImage(
          cacheKey,
          url,
          this.getImageryTilePriority(tx, ty, imageryZoom),
          this.getKey(x, y, zoom),
        )
          .then((img) => ({ img: signal.aborted ? null : img, tx, ty }))
          .catch(() => ({ img: null as ImageBitmap | null, tx, ty }));
        pendingOps.push(p);
      }
    }
    const allOps = Promise.all<{ img: ImageBitmap | null; tx: number; ty: number }>([
      ...readyOps,
      ...pendingOps,
    ]);

    return new Promise<ImageryFetchResult>((resolve, reject) => {
      void allOps.then((ops) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        /** ImageBitmap → 纹理：翻转已在 Worker 内烘焙进位图，flipY 必须为 false
         * （WebGL 对 ImageBitmap 源忽略 UNPACK_FLIP_Y_WEBGL）。 */
        const buildTextureFromBitmap = (bitmap: ImageBitmap): THREE.Texture => {
          const tex = new THREE.Texture(bitmap);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = true;
          tex.flipY = false;
          tex.needsUpdate = true;
          return tex;
        };
        /** 主线程同步拼接回退（诊断环境 / Worker 崩溃时使用，逻辑与旧路径一致） */
        const stitchOnMainThread = (): ImageryFetchResult => {
          const canvas = document.createElement("canvas");
          canvas.width = canvasW;
          canvas.height = canvasH;
          const ctx = canvas.getContext("2d")!;
          const drawnSlots = new Set<string>();
          let drawnImageCount = 0;

          // 用缓存中的父级瓦片放大补绘失败的子块（Google 影像父级必然存在），
          // 避免零星 404/限流在画布上留下透明洞。
          const fillFromAncestors = (tx: number, ty: number): boolean => {
            for (let az = imageryZoom - 1; az >= Math.max(0, imageryZoom - 4); az--) {
              const scale = Math.pow(2, imageryZoom - az);
              const ax = Math.floor(tx / scale);
              const ay = Math.floor(ty / scale);
              const ancestor = this.imgCache.get(`${az}/${ax}/${ay}`);
              if (!ancestor) continue;
              const sw = TILE_PX / scale;
              const sx = ((tx - ax * scale) * TILE_PX) / scale;
              const sy = ((ty - ay * scale) * TILE_PX) / scale;
              ctx.drawImage(
                ancestor,
                sx,
                sy,
                sw,
                sw,
                tx * TILE_PX - pxWest,
                ty * TILE_PX - pxNorth,
                TILE_PX,
                TILE_PX,
              );
              drawnSlots.add(`${tx}/${ty}`);
              drawnImageCount++;
              return true;
            }
            return false;
          };

          for (const op of ops) {
            if (!op.img) continue;
            ctx.drawImage(
              op.img,
              op.tx * TILE_PX - pxWest,
              op.ty * TILE_PX - pxNorth,
              TILE_PX,
              TILE_PX,
            );
            drawnSlots.add(`${op.tx}/${op.ty}`);
            drawnImageCount++;
          }
          // 失败/被剪裁的子块尽量用父级缓存补绘（无网络请求），
          // 让画布尽量不透明，避免透出下层灰色兜底网格
          for (let tx = fullXMin; tx <= fullXMax; tx++) {
            for (let ty = fullYMin; ty <= fullYMax; ty++) {
              if (drawnSlots.has(`${tx}/${ty}`)) continue;
              fillFromAncestors(tx, ty);
            }
          }
          if (drawnImageCount === 0) {
            throw new Error(
              `No imagery tiles loaded (${requestedImageCount} requests); keeping fallback visible.`,
            );
          }
          // 同步路径画布未烘焙翻转，沿用 CanvasTexture + flipY=true
          const syncTex = new THREE.CanvasTexture(canvas);
          syncTex.colorSpace = THREE.SRGBColorSpace;
          syncTex.minFilter = THREE.LinearMipmapLinearFilter;
          syncTex.magFilter = THREE.LinearFilter;
          syncTex.generateMipmaps = true;
          syncTex.flipY = true;
          return { texture: syncTex, zoom: imageryZoom, coverage };
        };
        const task: ImageryStitchTask = {
          priority,
          cancelled: false,
          onCancel: reject,
          run: () => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            // Worker 路径：drawImage 拼接 + 翻转 + 导出全部在 Worker 完成，
            // 主线程只创建纹理对象（真正的 GPU 上传发生在渲染时且走更快的
            // ImageBitmap 路径），不再有同步画布风暴。
            if (this.stitchPool.available) {
              // 父级补绘候选：imageryZoom-1 .. imageryZoom-4 中 imgCache 命中的祖先
              const ancestors: { key: string; img: ImageBitmap }[] = [];
              for (let d = 1; d <= Math.min(4, imageryZoom); d++) {
                const az = imageryZoom - d;
                const scale = Math.pow(2, d);
                const axMin = Math.floor(fullXMin / scale);
                const axMax = Math.floor(fullXMax / scale);
                const ayMin = Math.floor(fullYMin / scale);
                const ayMax = Math.floor(fullYMax / scale);
                for (let ax = axMin; ax <= axMax; ax++) {
                  for (let ay = ayMin; ay <= ayMax; ay++) {
                    const img = this.imgCache.get(`${az}/${ax}/${ay}`);
                    if (img) ancestors.push({ key: `${az}/${ax}/${ay}`, img });
                  }
                }
              }
              const stitchOps = ops.flatMap((op) =>
                op.img ? [{ img: op.img, tx: op.tx, ty: op.ty }] : [],
              );
              this.stitchInFlight++;
              this.stitchPool
                .stitch({
                  canvasW,
                  canvasH,
                  pxWest,
                  pxNorth,
                  imageryZoom,
                  tilePx: TILE_PX,
                  ops: stitchOps,
                  ancestors,
                })
                .then((res) => {
                  this.stitchInFlight--;
                  if (task.cancelled) {
                    res.bitmap.close();
                    return;
                  }
                  if (signal.aborted) {
                    res.bitmap.close();
                    reject(new Error("aborted"));
                    return;
                  }
                  if (res.drawnImageCount === 0) {
                    res.bitmap.close();
                    reject(
                      new Error(
                        `No imagery tiles loaded (${requestedImageCount} requests); keeping fallback visible.`,
                      ),
                    );
                    return;
                  }
                  resolve({
                    texture: buildTextureFromBitmap(res.bitmap),
                    zoom: imageryZoom,
                    coverage,
                  });
                })
                .catch((err: Error) => {
                  this.stitchInFlight--;
                  if (task.cancelled || signal.aborted) return;
                  // Worker 拼接失败 → 回退主线程同步路径
                  try {
                    resolve(stitchOnMainThread());
                  } catch (syncErr) {
                    reject((syncErr as Error) ?? err);
                  }
                });
              return;
            }
            // Worker 不可用：主线程同步拼接（诊断环境回退路径）
            try {
              resolve(stitchOnMainThread());
            } catch (err) {
              reject(err as Error);
            }
          },
        };
        this.stitchQueue.push(task);
      });
    });
  }

  private isImageryCoverageContained(
    coverage: ImageryCoverage | null,
    required: ImageryCoverage | null,
  ): boolean {
    if (!required) return true;
    if (!coverage) return false;
    const epsilon = 1e-9;
    return (
      coverage.west <= required.west + epsilon &&
      coverage.east >= required.east - epsilon &&
      coverage.south <= required.south + epsilon &&
      coverage.north >= required.north - epsilon
    );
  }

  /**
   * 当前是否真的需要影像纹理。
   *
   * 调试着色模式（debugColorByZoom）下恒为 false：既不请求影像，也不拼接，
   * 瓦片用层级纯色上屏。所有"是否需要影像"的判定都必须走这里，否则调试
   * 模式下会残留影像请求（慢）或让瓦片因 imageryReady=false 而永不上屏。
   */
  private needsImagery(): boolean {
    return this.imageryUrlTemplate !== undefined && !this.debugColorByZoom;
  }

  private getRequiredImageryCoverage(entry: TerrainTileEntry): ImageryCoverage | null {
    const viewLng = this.currentViewLngBounds;
    const viewLat = this.currentViewLatBounds;
    if (!viewLng || !viewLat) return null;
    const [x, y, zoom] = entry.key.split(",").map(Number);
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    const west = Math.max(bounds.west, viewLng[0]);
    const east = Math.min(bounds.east, viewLng[1]);
    const south = Math.max(bounds.south, viewLat[0]);
    const north = Math.min(bounds.north, viewLat[1]);
    if (west > east || south > north) return null;
    return { west, east, south, north };
  }

  private upgradeTileImagery(
    entry: TerrainTileEntry,
    imageryZoom: number,
    requiredCoverage: ImageryCoverage | null,
  ): boolean {
    // 画布上限曾把该瓦片的影像降级过 → 更高的目标层级注定再次降级，
    // 直接钳到可达层级，否则会形成“请求 → 降级 → 再请求”的永久循环。
    const effectiveTarget =
      entry.imageryZoomCap === null ? imageryZoom : Math.min(imageryZoom, entry.imageryZoomCap);
    const needsZoomUpgrade = effectiveTarget > entry.imageryZoom;
    const needsCoverage = !this.isImageryCoverageContained(entry.imageryCoverage, requiredCoverage);
    if ((!needsZoomUpgrade && !needsCoverage) || entry.pendingImageryZoom !== null) {
      return false;
    }
    // 失败退避：刚失败的瓦片不立刻重试（否则每 200ms 的视图更新都会
    // 重新拉起一轮网络请求 + 主线程画布拼接，把 FPS 拖到个位数）。
    if (Date.now() < entry.imageryRetryAt) return false;

    const requestedZoom = imageryZoom;
    const [x, y, zoom] = entry.key.split(",").map(Number);
    // 画布尺寸随屏幕投影走：远处瓦片用小画布（拼接与纹理上传成本∝面积）。
    const canvasSize = this.getTileImageryCanvasSize(x, y, zoom);
    entry.pendingImageryZoom = imageryZoom;
    const signal = this.lifecycleController.signal;
    void this.fetchImagery(x, y, zoom, imageryZoom, signal, canvasSize)
      .then(({ texture, zoom: loadedImageryZoom, coverage }) => {
        if (signal.aborted || !this.loadedTiles.has(entry.key)) {
          texture.dispose();
          return;
        }
        // 切到调试着色模式后迟到的影像：丢弃，避免盖掉层级纯色
        if (this.debugColorByZoom) {
          texture.dispose();
          entry.pendingImageryZoom = null;
          return;
        }
        const material = entry.mesh.material as THREE.MeshBasicMaterial;
        const previousTexture = material.map;
        material.map = texture;
        material.color.set(0xffffff); // 从兜底灰重置为白色，避免影像被染色
        material.needsUpdate = true;
        previousTexture?.dispose();
        entry.imageryZoom = loadedImageryZoom;
        entry.imageryCoverage = coverage;
        entry.pendingImageryZoom = null;
        entry.imageryFailures = 0;
        entry.imageryRetryAt = 0;
        // 只有"已经用满配置的画布上限"仍被降级，才说明该瓦片在此经纬度真的
        // 取不到更高层级（记录可达上限，避免无限重试）。因屏幕投影小而主动
        // 降级的情况不设上限——相机靠近后投影变大，画布会自动跟着长大。
        if (loadedImageryZoom < requestedZoom && canvasSize >= this.imageryMaxCanvasSize) {
          entry.imageryZoomCap =
            entry.imageryZoomCap === null
              ? loadedImageryZoom
              : Math.min(entry.imageryZoomCap, loadedImageryZoom);
        }
      })
      .catch(() => {
        /* Keep the current texture and retry on a later view update (with backoff). */
        entry.imageryFailures++;
        const backoff = Math.min(2000 * 2 ** Math.min(entry.imageryFailures - 1, 4), 30000);
        entry.imageryRetryAt = Date.now() + backoff;
      })
      .finally(() => {
        if (entry.pendingImageryZoom === imageryZoom) entry.pendingImageryZoom = null;
      });
    return true;
  }

  /**
   * 影像子块请求（fetch + blob 读取），带整体超时。
   *
   * 没有超时时，一个被代理/服务器"黑洞"挂住的请求会让 fetchImagery 的
   * Promise.all 永不落定 → pendingImageryZoom 永不清空 → upgradeTileImagery
   * 因 pendingImageryZoom !== null 永远拒绝重试，该瓦片永远隐形（op=0），
   * 父瓦片又被 hiddenCoveredAncestors 隐藏 —— 屏幕上留下一块永远不刷新的
   * 灰区（朝相机平移后实测出现）。超时按普通失败记入退避重试；生命周期
   * 取消（dispose）保持 AbortError 语义，不记失败。
   */
  private fetchImageryBlob(url: string, timeoutMs = 15000): Promise<Blob> {
    const lifecycle = this.lifecycleController.signal;
    if (lifecycle.aborted) {
      return Promise.reject(new DOMException("Layer disposed.", "AbortError"));
    }
    const controller = new AbortController();
    let lifecycleAborted = false;
    const onLifecycleAbort = () => {
      lifecycleAborted = true;
      controller.abort();
    };
    lifecycle.addEventListener("abort", onLifecycleAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      lifecycle.removeEventListener("abort", onLifecycleAbort);
    };
    return (async () => {
      try {
        const res = await fetch(url, { mode: "cors", signal: controller.signal });
        if (!res.ok) throw new HttpStatusError(res.status);
        return await res.blob();
      } catch (error) {
        if (!lifecycleAborted && controller.signal.aborted) {
          // 超时（非生命周期取消）：转成 TimeoutError，让上层记入退避重试
          throw new DOMException("Imagery sub-request timed out.", "TimeoutError");
        }
        throw error;
      } finally {
        finish();
      }
    })();
  }

  /** 从共享缓存获取或加载影像（createImageBitmap 在后台线程解码，不阻塞主线程） */
  private getOrLoadImage(
    key: string,
    url: string,
    priority: number,
    ownerKey: TileKey,
  ): Promise<ImageBitmap> {
    const cached = this.imgCache.get(key);
    if (cached) {
      // 命中即刷新次序：Map 保持插入序，淘汰取第一个，所以命中必须
      // delete + set 才是真 LRU。只按插入序淘汰（FIFO）时，旋转视角会
      // 首先淘汰最早进入、仍在使用中的那批热瓦片，等于系统性地把当前
      // 视野最需要的位图踢出去，随后只能重新解码/重下。
      this.imgCache.delete(key);
      this.imgCache.set(key, cached);
      return Promise.resolve(cached);
    }

    const failure = this.failedImagery.get(key);
    if (failure?.permanent || (failure && Date.now() < failure.nextAttempt)) {
      return Promise.reject(new Error("Imagery tile is temporarily unavailable."));
    }

    const loading = this.imgLoading.get(key);
    if (loading) {
      loading.owners.add(ownerKey);
      return loading.promise;
    }

    // The owner signal cancels only work still waiting in the scheduler. Once
    // transport starts, let it finish and populate the shared cache instead of
    // repeatedly aborting and re-requesting tiles as the camera moves.
    const queueAbortController = new AbortController();
    const loadingRequest: ImageryLoadingRequest = {
      promise: Promise.resolve(undefined as unknown as ImageBitmap),
      queueAbortController,
      owners: new Set([ownerKey]),
      started: false,
    };
    const request = requestScheduler
      .schedule({
        url,
        priority: priority + IMAGERY_REQUEST_PRIORITY_OFFSET,
        signal: queueAbortController.signal,
        requestGroup: this.imageryRequestGroup,
        maximumRequestsPerServer: this.imageryMaximumRequestsPerServer,
        load: async () => {
          loadingRequest.started = true;
          const disk = this.imageryDiskCache;
          // 1) 持久化缓存命中（键即瓦片 URL，同一瓦片二次访问零网络）
          if (disk) {
            const cached = await disk.get(url);
            if (cached) {
              try {
                return await createImageBitmap(cached);
              } catch {
                void disk.delete(url);
              }
            }
          }
          const blob = await this.fetchImageryBlob(url);
          if (disk && !this.disposed) disk.put(url, blob);
          return createImageBitmap(blob);
        },
      })
      .then((bitmap) => {
        if (this.disposed) {
          bitmap.close();
          throw new Error("Terrain layer disposed.");
        }
        // LRU 淘汰
        if (this.imgCache.size >= this.maxImgCacheSize) {
          const oldest = this.imgCache.keys().next().value;
          if (oldest !== undefined) {
            this.imgCache.get(oldest)?.close();
            this.imgCache.delete(oldest);
          }
        }
        this.failedImagery.delete(key);
        this.imgCache.set(key, bitmap);
        return bitmap;
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === "AbortError")) {
          const now = Date.now();
          const retries = (this.failedImagery.get(key)?.retries ?? 0) + 1;
          const status = error instanceof HttpStatusError ? error.status : null;
          const permanent = isPermanentHttpStatus(status);
          const backoff = permanent
            ? Number.POSITIVE_INFINITY
            : Math.min(
                this.retryCooldown * Math.pow(2, Math.min(retries - 1, 4)),
                this.maxRetryCooldown,
              );
          this.failedImagery.set(key, {
            retries,
            lastAttempt: now,
            nextAttempt: now + backoff,
            permanent,
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.imgLoading.get(key) === loadingRequest) {
          this.imgLoading.delete(key);
        }
      });
    loadingRequest.promise = request;
    this.imgLoading.set(key, loadingRequest);
    return request;
  }

  private cancelImageryExcept(visibleKeys: Set<TileKey>, fallbackKeys: Set<TileKey>): void {
    for (const [key, request] of this.imgLoading) {
      for (const owner of request.owners) {
        if (!visibleKeys.has(owner) && !fallbackKeys.has(owner)) {
          request.owners.delete(owner);
        }
      }
      if (request.owners.size > 0) continue;
      request.queueAbortController.abort();
      if (!request.started) this.imgLoading.delete(key);
    }
  }

  // ─── 几何构建 ───────────────────────────────────────────────

  private buildTerrainGeometry(
    data: QuantizedMeshData,
    bounds: { west: number; east: number; south: number; north: number },
    zoom: number,
  ): THREE.BufferGeometry {
    const { vertexCount, u, v, height, indices, minHeight, maxHeight } = data;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const heightRange = maxHeight - minHeight;
    const southMercator = this.gis.lngLatToMercator(
      0,
      THREE.MathUtils.clamp(bounds.south, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
    )[1];
    const northMercator = this.gis.lngLatToMercator(
      0,
      THREE.MathUtils.clamp(bounds.north, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
    )[1];
    const mercatorRange = Math.max(northMercator - southMercator, 1e-9);

    for (let i = 0; i < vertexCount; i++) {
      const lng = bounds.west + (u[i] / 32767) * (bounds.east - bounds.west);
      const lat = bounds.south + (v[i] / 32767) * (bounds.north - bounds.south);
      let alt = minHeight + (height[i] / 32767) * heightRange;
      if (this.exaggeration !== 1.0) alt *= this.exaggeration;

      const p = this.gis.lngLatToThree(lng, lat, alt);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;

      uvs[i * 2] = u[i] / 32767;
      const mercatorY = this.gis.lngLatToMercator(
        0,
        THREE.MathUtils.clamp(lat, -WEB_MERCATOR_MAX_LATITUDE, WEB_MERCATOR_MAX_LATITUDE),
      )[1];
      uvs[i * 2 + 1] = THREE.MathUtils.clamp((mercatorY - southMercator) / mercatorRange, 0, 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    if (!this.wireframe) this.addSkirt(geo, vertexCount, heightRange, zoom);

    return geo;
  }

  /** 裙边：沿边界向下延伸遮住裂缝 */
  private addSkirt(
    geo: THREE.BufferGeometry,
    originalVertexCount: number,
    heightRange: number,
    zoom: number,
  ) {
    const lodScale = THREE.MathUtils.clamp((zoom - 2) / 10, 0.25, 1);
    const skirtHeight = THREE.MathUtils.clamp(heightRange * 0.02, 2, 40) * lodScale;
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute;
    const uvAttr = geo.getAttribute("uv") as THREE.BufferAttribute;
    const indexAttr = geo.getIndex()!;

    // 收集边界顶点索引
    const edgeVerts: number[] = [];
    for (let i = 0; i < originalVertexCount; i++) {
      const uVal = uvAttr.getX(i);
      const vVal = uvAttr.getY(i);
      if (uVal < 0.001 || uVal > 0.999 || vVal < 0.001 || vVal > 0.999) {
        edgeVerts.push(i);
      }
    }
    if (edgeVerts.length < 4) return;

    // 按边界顺序排列
    const sorted = this.sortEdgeVertices(edgeVerts, uvAttr);
    if (sorted.length < 4) return;

    // 创建裙边顶点（下移）
    const skirtPositions: number[] = [];
    const skirtUvs: number[] = [];
    for (const vi of sorted) {
      skirtPositions.push(posAttr.getX(vi), posAttr.getY(vi), posAttr.getZ(vi) - skirtHeight);
      skirtUvs.push(uvAttr.getX(vi), uvAttr.getY(vi));
    }

    // 裙边三角形
    const skirtIndices: number[] = [];
    const base = posAttr.count; // 裙边顶点起始索引
    for (let i = 0; i < sorted.length - 1; i++) {
      const topA = sorted[i];
      const topB = sorted[i + 1];
      const botA = base + i;
      const botB = base + i + 1;
      skirtIndices.push(topA, botA, topB);
      skirtIndices.push(topB, botA, botB);
    }
    // 闭合
    const last = sorted.length - 1;
    skirtIndices.push(sorted[last], base + last, sorted[0]);
    skirtIndices.push(sorted[0], base + last, base);

    // 合并几何体
    const origPos = posAttr.array as Float32Array;
    const origUv = uvAttr.array as Float32Array;
    const origIdx = indexAttr.array as Uint32Array;

    const allPos = new Float32Array(origPos.length + skirtPositions.length);
    allPos.set(origPos);
    allPos.set(skirtPositions, origPos.length);

    const allUv = new Float32Array(origUv.length + skirtUvs.length);
    allUv.set(origUv);
    allUv.set(skirtUvs, origUv.length);

    const allIdx = new Uint32Array(origIdx.length + skirtIndices.length);
    allIdx.set(origIdx);
    allIdx.set(skirtIndices, origIdx.length);

    geo.setAttribute("position", new THREE.BufferAttribute(allPos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(allUv, 2));
    geo.setIndex(new THREE.BufferAttribute(allIdx, 1));
  }

  private sortEdgeVertices(edgeIndices: number[], uvAttr: THREE.BufferAttribute): number[] {
    const bottom: number[] = [];
    const right: number[] = [];
    const top: number[] = [];
    const left: number[] = [];

    for (const i of edgeIndices) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      if (v < 0.001) bottom.push(i);
      else if (u > 0.999) right.push(i);
      else if (v > 0.999) top.push(i);
      else if (u < 0.001) left.push(i);
    }

    bottom.sort((a, b) => uvAttr.getX(a) - uvAttr.getX(b));
    right.sort((a, b) => uvAttr.getY(a) - uvAttr.getY(b));
    top.sort((a, b) => uvAttr.getX(b) - uvAttr.getX(a));
    left.sort((a, b) => uvAttr.getY(b) - uvAttr.getY(a));

    return [...bottom, ...right, ...top, ...left];
  }

  // ─── LOD ────────────────────────────────────────────────────

  /**
   * 瓦片表面高程估计（供投影与 LOD 判据使用）。
   *
   * 只认「瓦片自身」，其次「从它向上最近的已加载祖先」，**不看后代**。
   *
   * 以前会把后代一并纳入取全局最大，带来两个问题：
   * 1. 正反馈：后代高程来自更密的网格采样，往往高于本级粗网格采到的峰值，
   *    于是「加载越多 → 估计越高 → pixelSize 越大 → 越要细分 → 加载更多」。
   *    实测同一瓦片、同一相机，仅加载历史不同，pixelSize 差 6 倍
   *    （617 vs 3659），判据在 512px 阈值附近乱跳，同一视角下 LOD 层级
   *    不稳定，深层级小瓦片泛滥。取「最近祖先」而非「所有祖先里的最大」，
   *    是为了不让远处山峰的峰值套到山脚下的瓦片上（祖先面积越小越贴合）。
   * 2. 性能：每次调用要遍历全部 loadedTiles + tileCache，而它在遍历中被
   *    每个候选节点调用一次（O(候选节点数 × 已加载瓦片数)）。
   * 现在按层级向上查表，复杂度 O(层级差)，且结果只取决于祖先是否已加载。
   */
  private estimateTileSurfaceHeight(x: number, y: number, zoom: number): number {
    if (zoom < this.minZoom) return 0;
    const own =
      this.loadedTiles.get(this.getKey(x, y, zoom)) ?? this.tileCache.get(this.getKey(x, y, zoom));
    if (own) return own.surfaceHeight;
    for (let z = zoom - 1; z >= this.minZoom; z--) {
      const scale = Math.pow(2, zoom - z);
      // 位运算会把 x > 2^31 的情况搞坏，这里层级差很小，用 floor 除法即可。
      const ancestorKey = this.getKey(Math.floor(x / scale), Math.floor(y / scale), z);
      const entry = this.loadedTiles.get(ancestorKey) ?? this.tileCache.get(ancestorKey);
      if (entry) return entry.surfaceHeight;
    }
    return 0;
  }

  private tileDistanceTo(
    x: number,
    y: number,
    zoom: number,
    target: THREE.Vector3,
    cameraPos?: THREE.Vector3,
  ): number {
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const center = this.gis.lngLatToThree(
      centerLng,
      centerLat,
      this.estimateTileSurfaceHeight(x, y, zoom),
    );
    const dTarget = center.distanceTo(target);
    if (!cameraPos) return dTarget;
    // 倾斜视角时，前景瓦片离相机近但离目标远，取两者最小值保证前景 LOD
    return Math.min(dTarget, center.distanceTo(cameraPos));
  }

  private getEffectiveZoom(distance: number, baseZoom: number, nearRadius: number): number {
    if (distance <= nearRadius) return baseZoom;
    const ratio = distance / nearRadius;
    const zoomOffset = Math.floor(Math.log2(ratio));
    const clampedOffset = Math.min(zoomOffset, this.maxLodLevels);
    return Math.max(this.minZoom, baseZoom - clampedOffset);
  }

  private getTileImageryZoom(x: number, y: number, terrainTileZoom: number): number {
    // A geographic terrain tile spans roughly one Web Mercator tile at z+1.
    // Start from that resolution, then add only the detail its projected size
    // can use. This prevents distant coarse terrain tiles from requesting a
    // full camera-level imagery pyramid.
    const terrainBaseZoom = terrainTileZoom + 1 + this.imageryZoomOffset;
    const cameraTargetZoom = Math.max(this.currentImageryZoom, terrainBaseZoom);
    let target = cameraTargetZoom;
    if (this.currentCamera) {
      const projection = this.getTerrainTileProjection(x, y, terrainTileZoom, this.currentCamera);
      // 用"裁剪到视口"的尺寸：屏幕外的角点不算用户能看到的大小。
      // 未裁剪时会高估远处粗瓦片的占屏尺寸，把影像目标层级抬高 1~2 级，
      // 单块子请求数因此翻 4~16 倍（倾斜/旋转时请求量失控的主因）。
      const projectedPixels = Math.max(projection.visiblePixelSize, 1);
      // 手势（拖拽/缩放）期间额外细节层归零：近处瓦片的目标层级因此等于
      // 初始层级（terrainZoom+1），画布 512px、子请求 4 个 —— 一块瓦片一个
      // 网络往返就能完整上屏。不加这个上限时，朝相机方向平移会源源不断
      // 露出"目标 2048 画布 / 64 子请求"的近处瓦片，单块完成要 2~3s，
      // 屏幕底部整条只能一直由粗层级兜底瓦片顶着（实测拖动全程 miss 5~11、
      // 拼接队列积压 31）。松手后目标层级恢复，upgradeTileImagery 按预算把
      // 这些瓦片细化到全分辨率 —— 即 Cesium 的"先粗后细"策略。
      const extraLevels = this.cameraInteracting
        ? 0
        : Math.max(0, Math.ceil(Math.log2(projectedPixels / 256)));
      target = Math.min(cameraTargetZoom, terrainBaseZoom + extraLevels);
    }
    return THREE.MathUtils.clamp(target, this.minZoom, this.maxZoom + 3);
  }

  private getInitialTileImageryZoom(terrainTileZoom: number, targetZoom: number): number {
    const baseZoom = terrainTileZoom + 1 + this.imageryZoomOffset;
    return THREE.MathUtils.clamp(Math.min(targetZoom, baseZoom), this.minZoom, this.maxZoom + 3);
  }

  /**
   * 该瓦片的影像画布上限，按屏幕投影尺寸推导。
   *
   * 固定用 imageryMaxCanvasSize（2048）会让 50~80km 外的瓦片也拼一张
   * 2048×2250 的画布 + 上传 ~18MB 纹理——而它在屏幕上可能只占几十像素。
   * 倾斜视角下这类远处瓦片有几十块，拼接队列因此积压（实测稳态积压 42 个），
   * 主线程被 drawImage 灌满 → FPS 掉到个位数。
   *
   * 规则：画布边长 ≈ 屏幕投影像素 × 2（留 mip 余量），量化到 256 的倍数，
   * 钳在 [256, imageryMaxCanvasSize]。近处瓦片仍然拿到 2048，远处自动降到
   * 512/256——画布越小，drawImage 次数（∝ 面积）与纹理上传量同步下降。
   */
  private getTileImageryCanvasSize(x: number, y: number, zoom: number): number {
    const camera = this.currentCamera;
    if (!camera) return this.imageryMaxCanvasSize;
    const projection = this.getTerrainTileProjection(x, y, zoom, camera);
    // 与影像目标层级同源：用视口裁剪后的可见尺寸。屏幕外的角点不该让一块
    // 瓦片拿到 2048 的大画布（多出的像素在屏幕外，纯浪费显存与拼接时间）。
    const projected = Math.max(projection.visiblePixelSize, 1);
    let size = 256;
    while (size < projected * 2 && size < this.imageryMaxCanvasSize) size *= 2;
    return Math.min(Math.max(size, 256), this.imageryMaxCanvasSize);
  }

  private getTerrainTileProjection(
    x: number,
    y: number,
    zoom: number,
    camera: THREE.PerspectiveCamera,
  ): {
    pixelSize: number;
    visiblePixelSize: number;
    visibleMinSize: number;
    distance: number;
    screenSpaceError: number;
    reliable: boolean;
  } {
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    const height = this.estimateTileSurfaceHeight(x, y, zoom);
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const center = this.gis.lngLatToThree(centerLng, centerLat, height);
    const points = [
      center,
      this.gis.lngLatToThree(bounds.west, bounds.north, height),
      this.gis.lngLatToThree(bounds.east, bounds.north, height),
      this.gis.lngLatToThree(bounds.east, bounds.south, height),
      this.gis.lngLatToThree(bounds.west, bounds.south, height),
    ];

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    // 裁剪到视口后的范围：屏幕外的角点会把"这块在屏幕上占多大"撑爆。
    // 粗瓦片常有 1~3 个角点落在视口外，未裁剪时算出的尺寸可达实际可见部分的
    // 数倍；据此推导的影像目标层级虚高（z8 兜底瓦片被抬到 z12），单块要拉
    // 8x8=64 个影像子块 —— 倾斜与旋转时请求量失控的主因。
    let vMinX = Infinity;
    let vMaxX = -Infinity;
    let vMinY = Infinity;
    let vMaxY = -Infinity;
    // 通过深度过滤的探针点数。可见尺寸只在「全部探针点都在相机前方」时才
    // 可信：角点落在相机背后的瓦片（贴着屏幕底边的近处瓦片就是这种）会被
    // 剔除几个点，剩下的点算出的包围盒偏小，据此拦细分会把屏幕底边的合法
    // 细化一并掐掉（正是此前"最下边不细化"的老毛病）。全部点都在前方时，
    // 裁剪只发生在视口四边（侧向出画），此时小可见尺寸确实是浪费。
    let projectedCount = 0;
    for (const point of points) {
      const projected = point.clone().project(camera);
      if (projected.z < -1 || projected.z > 1) continue;
      projectedCount++;
      minX = Math.min(minX, projected.x);
      maxX = Math.max(maxX, projected.x);
      minY = Math.min(minY, projected.y);
      maxY = Math.max(maxY, projected.y);

      const clampedX = THREE.MathUtils.clamp(projected.x, -1, 1);
      const clampedY = THREE.MathUtils.clamp(projected.y, -1, 1);
      vMinX = Math.min(vMinX, clampedX);
      vMaxX = Math.max(vMaxX, clampedX);
      vMinY = Math.min(vMinY, clampedY);
      vMaxY = Math.max(vMaxY, clampedY);
    }

    const pixelSize = Number.isFinite(minX)
      ? Math.max(
          ((maxX - minX) * this.currentViewportWidth) / 2,
          ((maxY - minY) * this.currentViewportHeight) / 2,
        )
      : 0;
    // 可见尺寸按两个轴分别算：只看最长边会把"细长条"（斜视时近地平线的
    // 瓦片被透视压扁，实测 1066x41、360x8）当成大瓦片放行，而它可用像素
    // 面积只有目标瓦片的百分之几。
    const visibleWidth = Number.isFinite(vMinX)
      ? ((vMaxX - vMinX) * this.currentViewportWidth) / 2
      : 0;
    const visibleHeight = Number.isFinite(vMinY)
      ? ((vMaxY - vMinY) * this.currentViewportHeight) / 2
      : 0;
    const visiblePixelSize = Math.max(visibleWidth, visibleHeight);
    const visibleMinSize = Math.min(visibleWidth, visibleHeight);
    const distance = center.distanceTo(camera.position);
    const geometricError = LEVEL_ZERO_GEOMETRIC_ERROR / Math.pow(2, zoom);
    const screenSpaceError =
      (geometricError * this.currentViewportHeight) /
      (Math.max(distance, 1) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    return {
      // pixelSize 保持"未裁剪"语义：地形 LOD 判据依赖它在"瓦片套住相机"
      // 这类退化情形下极大化，裁剪会阻止四叉树向下细分。
      pixelSize,
      visiblePixelSize,
      visibleMinSize,
      distance,
      screenSpaceError,
      reliable: projectedCount === points.length,
    };
  }

  private collectQuadtreeTerrainTiles(
    viewLngBounds: [number, number],
    viewLatBounds: [number, number],
    baseZoom: number,
    camera: THREE.PerspectiveCamera,
    target: THREE.Vector3,
    cameraPosition: THREE.Vector3 | undefined,
    visibleKeys: Set<TileKey>,
    tilesToLoad: {
      key: TileKey;
      x: number;
      y: number;
      zoom: number;
      priority: number;
      virtual?: boolean;
    }[],
  ): void {
    const [lngMin, lngMax] = viewLngBounds;
    const [latMin, latMax] = viewLatBounds;
    const startZoom = this.minZoom;
    const sw = lngLatToGeoTile(lngMin, latMin, startZoom, this.tileYOrigin);
    const ne = lngLatToGeoTile(lngMax, latMax, startZoom, this.tileYOrigin);
    const roots: Array<{ x: number; y: number; zoom: number; d: number }> = [];
    for (let x = Math.min(sw.x, ne.x); x <= Math.max(sw.x, ne.x); x++) {
      for (let y = Math.min(sw.y, ne.y); y <= Math.max(sw.y, ne.y); y++) {
        roots.push({
          x,
          y,
          zoom: startZoom,
          d: this.tileDistanceTo(x, y, startZoom, target, cameraPosition),
        });
      }
    }

    const rootCount = roots.length;
    const stack = roots;
    let visited = 0;
    const maxVisited = Math.max(this.maxTilesPerView * 8, 1024);
    let stoppedBy: "" | "visitedBudget" | "maxTilesPerView" = "";
    // 诊断计数：本帧每个节点"为什么没成为正选叶子"。guardBlocked 记录
    // 「判据要求细分、却被可见尺寸护栏拦下」的节点——这类节点会成为叶子，
    // 但它们解析到的可用祖先是粗瓦片，数量异常时说明护栏阈值过紧。
    let subdivided = 0;
    let prunedAABB = 0;
    let prunedFrustum = 0;
    let notSubdividable = 0;
    let guardBlocked = 0;
    const guardBlockSamples: string[] = [];
    while (stack.length > 0 && visited < maxVisited && visibleKeys.size < this.maxTilesPerView) {
      // Best-first（按离相机/目标最近优先出队），而非 LIFO DFS：
      // maxTilesPerView 预算耗尽时整棵遍历直接停止——LIFO 顺序下先弹出的
      // （任意一侧的）子树会把名额吃满，近处的精细子树可能根本没被访问，
      // 那块区域就不在可见集里，只能由底图毯/粗祖先顶着：视角转动、视野
      // 区域横扫时表现为大块不细化的糊斑（且拼接队列为空——那些粗瓦片
      // 自身目标层级就低，管线"自洽地"无事可做）。近者先出队后，预算
      // 优先花给近处精细瓦片，远处地平线瓦片用剩余名额兜底。
      let bestIdx = 0;
      for (let i = 1; i < stack.length; i++) {
        if (stack[i].d < stack[bestIdx].d) bestIdx = i;
      }
      const tile = stack.splice(bestIdx, 1)[0]!;
      visited++;
      const bounds = geoTileBounds(tile.x, tile.y, tile.zoom, this.tileYOrigin);
      // 预剪枝用"外扩 100% 的视野 AABB"，而非裸 AABB，也不是不剪：
      // - 裸 AABB（4 条屏幕角点射线与地面交点的经纬度包络）在山坡上包络
      //   系统性偏小，部分入画（中心在框外）的瓦片会被整体剪掉，整棵子树
      //   不加载，底部带只能由粗祖先顶着（永不细化的糊斑）——故需外扩。
      // - 完全不剪也不行：视锥柱体测试（z=0 ~ 最高观测高程）会放进数千
      //   公里外、柱体与视锥擦边的巨型低层级瓦片。它们距离远、sse 极小、
      //   直接成为正选叶子：粗网格弦横穿视野悬在真实地形上方，且没有精细
      //   后代（保持 depthWrite），深度测试压过近处全部清晰瓦片——表现为
      //   全屏模糊糊斑，且影像升级请求照常发出却永远显示不出来。
      // 外扩 100% 后，部分入画的邻近瓦片必过，怪物瓦片必挡。
      if (
        bounds.east < lngMin - (lngMax - lngMin) ||
        bounds.west > lngMax + (lngMax - lngMin) ||
        bounds.north < latMin - (latMax - latMin) ||
        bounds.south > latMax + (latMax - latMin)
      ) {
        prunedAABB++;
        continue;
      }
      if (!this.isGeographicBoundsInFrustum(bounds)) {
        prunedFrustum++;
        continue;
      }

      const projection = this.getTerrainTileProjection(tile.x, tile.y, tile.zoom, camera);
      const available = this.isTileAvailable(tile.x, tile.y, tile.zoom);
      // 细分上限：有 availability 元数据时允许细分到虚拟层级（含
      // availability 之下的上采样瓦片）；没有元数据时保持 maxZoom，
      // 避免对不存在的瓦片发出注定 404 的请求。
      const subdivisionCap = this.terrainAvailability
        ? this.terrainSubdivisionMaxZoom
        : this.maxZoom;
      const canSubdivide =
        tile.zoom < subdivisionCap &&
        (available || (this.terrainVirtualSubdivision && this.terrainAvailability !== null));
      if (!canSubdivide) notSubdividable++;
      // 可见尺寸护栏：细分判据里的 pixelSize 是「未裁剪」投影——一块九成在
      // 画面外、只有一条几十像素窄缝入画的瓦片，未裁剪投影照样很大（实测
      // 1px 宽的屏幕边缘条 px=817），于是被一路细分到高层级，子瓦片在屏幕
      // 上只剩几十像素，白花地形请求、几何与纹理内存。实测拖动中 18 块上屏
      // 瓦片里有 7 块属于这类碎片、却只覆盖屏幕 7% 的面积。
      //
      // 所以细分前还要求「裁剪到视口后的可见足迹」的**短边**仍大于一块瓦片
      // 的目标像素量（terrainTilePixelSize）：短边已不足一块瓦片时，子瓦片的
      // 短边只会更小，细分出来的必然是碎片。只看短边、不看长边是刻意的：
      // 远景下整屏常被一块比屏幕大得多的瓦片盖住，它的可见长边永远到不了
      // 2×目标值（被视口饱和截断），若拿长边做条件会把整个 LOD 卡死在
      // minZoom（实测整屏退化成 z7 马赛克）；而短边反映的是"这条瓦片在屏幕
      // 上有多厚"，不受饱和影响。豁免投影不可信（探针点被相机近平面剔除，
      // 贴着屏幕底边的近处瓦片就是这种）的情形。
      const visibleGuard =
        !projection.reliable ||
        projection.visibleMinSize > this.terrainTilePixelSize;
      if (
        canSubdivide &&
        !visibleGuard &&
        (projection.screenSpaceError > this.maximumScreenSpaceError ||
          projection.pixelSize > this.terrainTilePixelSize * 2)
      ) {
        guardBlocked++;
        if (guardBlockSamples.length < 5) {
          guardBlockSamples.push(
            `${tile.x},${tile.y},${tile.zoom} px=${Math.round(projection.pixelSize)} visMax=${Math.round(projection.visiblePixelSize)} visMin=${Math.round(projection.visibleMinSize)} rel=${projection.reliable}`,
          );
        }
      }
      const shouldSubdivide =
        canSubdivide &&
        visibleGuard &&
        (projection.screenSpaceError > this.maximumScreenSpaceError ||
          projection.pixelSize > this.terrainTilePixelSize * 2);

      if (shouldSubdivide) {
        subdivided++;
        const childZoom = tile.zoom + 1;
        for (const [cx, cy] of [
          [tile.x * 2, tile.y * 2],
          [tile.x * 2 + 1, tile.y * 2],
          [tile.x * 2, tile.y * 2 + 1],
          [tile.x * 2 + 1, tile.y * 2 + 1],
        ]) {
          stack.push({
            x: cx,
            y: cy,
            zoom: childZoom,
            d: this.tileDistanceTo(cx, cy, childZoom, target, cameraPosition),
          });
        }
        continue;
      }

      if (!available && this.terrainVirtualSubdivision && this.terrainAvailability) {
        // 虚拟叶子：availability 之下的层级继续细分（同 Cesium 上采样行为）。
        // 不解析到祖先瓦片，而是以本叶子自身作为可见瓦片：几何由最近可用
        // 祖先的基准网格重采样（不发地形请求），影像层级跟随虚拟层级走。
        // 祖先本身由 enqueueFallbackParents 作为兜底瓦片加载并垫在下方，
        // 虚拟瓦片就绪后被现有的遮挡/深度策略覆盖。
        const key = this.getKey(tile.x, tile.y, tile.zoom);
        if (!visibleKeys.has(key)) {
          visibleKeys.add(key);
          if (!this.loadedTiles.has(key) && !this.restoreFromCache(key)) {
            tilesToLoad.push({
              key,
              x: tile.x,
              y: tile.y,
              zoom: tile.zoom,
              priority: this.tileDistanceTo(tile.x, tile.y, tile.zoom, target, cameraPosition),
              virtual: true,
            });
          }
        }
        continue;
      }

      const resolved = this.resolveAvailableAncestor(tile.x, tile.y, tile.zoom);
      if (!resolved) continue;
      const key = this.getKey(resolved.x, resolved.y, resolved.zoom);
      if (visibleKeys.has(key)) continue;
      visibleKeys.add(key);
      if (this.loadedTiles.has(key)) continue;
      if (this.restoreFromCache(key)) continue;
      const priority = this.tileDistanceTo(
        resolved.x,
        resolved.y,
        resolved.zoom,
        target,
        cameraPosition,
      );
      tilesToLoad.push({
        key,
        x: resolved.x,
        y: resolved.y,
        zoom: resolved.zoom,
        priority,
      });
    }
    if (stack.length > 0) {
      stoppedBy = visited >= maxVisited ? "visitedBudget" : "maxTilesPerView";
    }
    this.traversalDebug = {
      roots: rootCount,
      visited,
      maxVisited,
      accepted: visibleKeys.size,
      stoppedBy,
      subdivided,
      prunedAABB,
      prunedFrustum,
      notSubdividable,
      guardBlocked,
      guardBlockSamples: guardBlockSamples.slice(),
    };
    tilesToLoad.sort((a, b) => a.priority - b.priority);
  }

  private toParentTile(
    x: number,
    y: number,
    baseZoom: number,
    effectiveZoom: number,
  ): { x: number; y: number } {
    const diff = baseZoom - effectiveZoom;
    if (diff <= 0) return { x, y };
    const scale = Math.pow(2, diff);
    return { x: Math.floor(x / scale), y: Math.floor(y / scale) };
  }

  /**
   * 快速跳层检测（防抖）。
   *
   * 用"本帧可见集里的最细层级"当 LOD 观测量：一次连续手势内累计跨越
   * ≥ LOD_FAST_MIN_LEVELS 级即进入快速模式；层级停止变化超过
   * LOD_FAST_TAIL_MS 后退出。两次变化间隔超过 LOD_BURST_GAP_MS 视为
   * 新的突发，重新以当前层级为基准——避免把"上午 z10、下午 z13"这类
   * 远隔的变化算成一次跳跃。
   */
  private updateFastZoomState(now: number, lodZoom: number): void {
    if (lodZoom !== this.lastLodZoom) {
      if (this.lastLodZoom < 0 || now - this.lodLastChangeAt > this.LOD_BURST_GAP_MS) {
        this.lodBurstBaseZoom = this.lastLodZoom < 0 ? lodZoom : this.lastLodZoom;
        this.lodBurstBaseAt = now;
      }
      this.lastLodZoom = lodZoom;
      this.lodLastChangeAt = now;
    }
    const jumped = Math.abs(lodZoom - this.lodBurstBaseZoom);
    this.fastZoomActive =
      jumped >= this.LOD_FAST_MIN_LEVELS && now - this.lodLastChangeAt <= this.LOD_FAST_TAIL_MS;
  }

  /** 当前是否处于快速跳层模式（诊断用）。 */
  public isFastZoomActive(): boolean {
    return this.fastZoomActive;
  }

  /** 瓦片是否处于"可渲染"状态（影像就绪 + 可见 + 未完全淡出） */
  private isTileRenderable(entry: TerrainTileEntry | undefined): boolean {
    if (!entry?.imageryReady || !entry.mesh.visible) return false;
    return (entry.mesh.material as THREE.MeshBasicMaterial).opacity > 0.001;
  }

  /**
   * 某区域是否已被 depth 层更细的可渲染后代完整覆盖。
   *
   * depth=1 → 检查 4 个直接子瓦片（常规逐级解锁）；depth=2 → 检查 16 个
   * 孙代瓦片。快速跳层时用 2 层：中间层级还没就绪也能被更细的一代直接把
   * 整块区域"接管"，不必等 4 个子块齐活再逐级退场。
   */
  private isRegionCoveredByDescendants(x: number, y: number, zoom: number, depth: number): boolean {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const cx = x * 2 + dx;
        const cy = y * 2 + dy;
        if (depth <= 1) {
          if (!this.isTileRenderable(this.loadedTiles.get(this.getKey(cx, cy, zoom + 1)))) {
            return false;
          }
        } else if (!this.isRegionCoveredByDescendants(cx, cy, zoom + 1, depth - 1)) {
          return false;
        }
      }
    }
    return true;
  }

  private hideCoveredAncestors(): void {
    // 快速跳层时允许"隔代覆盖"（孙代齐 → 直接撤祖辈），整条中间代际一次退场
    const depth = this.fastZoomActive ? 2 : 1;
    for (const key of [...this.loadedTiles.keys()]) {
      const parent = this.loadedTiles.get(key);
      if (!parent?.imageryReady || !parent.mesh.visible) continue;

      // 仍在"本帧可见集"里的瓦片是本帧 LOD 的正式成员，不能撤下：撤下后
      // 该区域会改由不在可见集里的兜底瓦片顶着，而兜底瓦片本来不参与影像
      // 升级 → 这一带永远停在初始的粗影像层级（实测整条屏幕带卡在 z15，
      // 目标 z16，且再也没有任何影像请求）。四象限的遮蔽由 childVisibility
      // 着色器负责，不依赖把瓦片撤出场景。
      if (this.currentVisibleKeys.has(key)) continue;

      const [x, y, zoom] = key.split(",").map(Number);
      if (!this.isRegionCoveredByDescendants(x, y, zoom, depth)) continue;

      this.loadedTiles.delete(key);
      this.cacheTile(key, parent);
    }
  }

  /**
   * Hide a coarse ancestor only inside quadrants where a rendered child tile
   * exists. This keeps the ancestor available for gaps while preventing its
   * larger triangles from poking through the higher-detail surface.
   *
   * 覆盖判定是递归的：象限自身不可渲染时，继续检查它的四个子象限，
   * 直到视野层级。否则底图毯这类"比视野层级粗好几级"的瓦片（其直接
   * 子瓦片永远不在加载集合里）会整块保持可见——粗网格的弦在山地处
   * 架在精细表面上方，深度测试获胜后就会以模糊斑块浮在清晰地形上。
   */
  private updateTerrainChildOcclusion(): void {
    // 目标层级 = 当前视野里最细的已加载瓦片层级
    let targetZoom = 0;
    for (const key of this.currentVisibleKeys) {
      const zoom = Number(key.split(",")[2]);
      if (zoom > targetZoom) targetZoom = zoom;
    }

    const isRenderable = (entry: TerrainTileEntry | undefined): boolean =>
      Boolean(
        entry &&
          entry.imageryReady &&
          entry.mesh.visible &&
          (entry.mesh.material as THREE.MeshBasicMaterial).opacity > 0.001,
      );

    // 1) 本帧可渲染瓦片集合。
    const renderableKeys = new Set<TileKey>();
    for (const [key, entry] of this.loadedTiles) {
      if (isRenderable(entry)) renderableKeys.add(key);
    }

    // 2) “含有可渲染后代”的祖先集合：从每个可渲染瓦片向上走有限层。
    //    这取代了原先无深度上限的递归——倾斜视角下视野会扩到几十公里，
    //    粗瓦片（底图毯 z9~z12）的子树要一路走到视野最深层，数万节点/帧，
    //    实测 updateTerrainChildOcclusion 高达 120ms/帧（FPS 个位数）。
    //    现在代价 = O(可渲染瓦片数 × 深度)，与视野大小无关。
    //    注意：这里不能按视野 AABB 过滤可渲染瓦片——AABB 按目标平面推导，
    //    相机贴近山坡时近处精细瓦片可能落在框外；跳过它们会让其粗祖先
    //    继续写深度，而粗网格的弦在山地上恰好“架”在精细表面上方，从上方
    //    赢得深度测试 → 糊斑盖住清晰地形（从地底下看精细瓦片反而清晰，
    //    视角相关的模糊覆盖）。回溯成本不受影响。
    const coveredAncestors = new Set<TileKey>();
    for (const key of renderableKeys) {
      const [x, y, zoom] = key.split(",").map(Number);
      let cx = x;
      let cy = y;
      let cz = zoom;
      for (let depth = 0; depth < MAX_ANCESTOR_WALK && cz > this.minZoom; depth++) {
        cx = Math.floor(cx / 2);
        cy = Math.floor(cy / 2);
        cz -= 1;
        coveredAncestors.add(this.getKey(cx, cy, cz));
      }
    }

    // 每帧 memo：递归判定共享，避免指数展开
    const memo = new Map<TileKey, boolean>();
    // 覆盖判定的递归深度上限：更深的粗瓦片不做象限剔除（保守保留，
    // 由深度写入策略保证它被精细瓦片覆盖），避免递归开销与误剔除
    const MAX_COVERAGE_DEPTH = 4;
    // 象限覆盖判定的节点预算：兜底保证单帧工作量有上限（预算耗尽后
    // 一律判“未覆盖”，即保守保留粗瓦片，不会挖出空洞）。
    let nodeBudget = MAX_OCCLUSION_NODES;

    const isRegionRenderable = (x: number, y: number, zoom: number, depth = 0): boolean => {
      const key = this.getKey(x, y, zoom);
      const cached = memo.get(key);
      if (cached !== undefined) return cached;

      let result: boolean;
      const entry = this.loadedTiles.get(key);
      if (entry) {
        result = isRenderable(entry);
      } else if (zoom >= targetZoom || depth >= MAX_COVERAGE_DEPTH) {
        // 已到视野层级（或超出递归上限）仍不可渲染 → 该区域需要兜底显示
        result = false;
      } else if (!coveredAncestors.has(key)) {
        // 该子树下根本没有可渲染瓦片 → 无需递归展开（省掉 4^4 节点）
        result = false;
      } else if (!this.isTileRegionInView(x, y, zoom)) {
        // 未证实被覆盖 → 保守保留粗瓦片。视野 AABB 在地平线方向按地平线
        // 距离裁剪，远处可见地形可能落在框外，此处判"已覆盖"会挖出空洞
        result = false;
      } else if (nodeBudget <= 0) {
        result = false;
      } else {
        nodeBudget--;
        result =
          isRegionRenderable(x * 2, y * 2, zoom + 1, depth + 1) &&
          isRegionRenderable(x * 2 + 1, y * 2, zoom + 1, depth + 1) &&
          isRegionRenderable(x * 2, y * 2 + 1, zoom + 1, depth + 1) &&
          isRegionRenderable(x * 2 + 1, y * 2 + 1, zoom + 1, depth + 1);
      }
      memo.set(key, result);
      return result;
    };

    for (const [key, parent] of this.loadedTiles) {
      const material = parent.mesh.material as THREE.MeshBasicMaterial;
      const [x, y, zoom] = key.split(",").map(Number);

      // 深度写入：粗瓦片只要被更精细的瓦片覆盖，就绝不能再写深度。
      // 粗网格的三角形弦在山地处几何上"架"在精细表面上方（采样稀疏所致），
      // 若它写入深度，后绘制的精细瓦片片段会被深度测试判为"更远"而丢弃，
      // 结果是模糊的粗瓦片盖住清晰地形——这就是视角相关的模糊覆盖。
      // 改为：精细瓦片靠绘制顺序（renderOrder=zoom，精细最后画）赢像素，
      // 粗瓦片只在精细瓦片缺席处兜底；独撑区域保留深度写入，避免
      // 让其它透明对象穿透地形。
      if (zoom >= targetZoom) {
        material.depthWrite = true;
      } else {
        // coveredAncestors.has(key) ⇔ 子树内存在可渲染的精细瓦片
        material.depthWrite = !coveredAncestors.has(key);
      }

      const childVisibility = material.userData.childVisibility as THREE.Vector4 | undefined;
      if (!childVisibility) continue;

      const southY = this.tileYOrigin === "south" ? y * 2 : y * 2 + 1;
      const northY = this.tileYOrigin === "south" ? y * 2 + 1 : y * 2;

      childVisibility.set(
        isRegionRenderable(x * 2, southY, zoom + 1) ? 1 : 0,
        isRegionRenderable(x * 2 + 1, southY, zoom + 1) ? 1 : 0,
        isRegionRenderable(x * 2, northY, zoom + 1) ? 1 : 0,
        isRegionRenderable(x * 2 + 1, northY, zoom + 1) ? 1 : 0,
      );
    }
  }

  /** 瓦片地理范围是否与当前视野 AABB 相交（无视野信息时返回 false 表示不剪枝） */
  private isTileRegionInView(x: number, y: number, zoom: number): boolean {
    const viewLng = this.currentViewLngBounds;
    const viewLat = this.currentViewLatBounds;
    if (!viewLng || !viewLat) return true;
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    return (
      bounds.east >= viewLng[0] &&
      bounds.west <= viewLng[1] &&
      bounds.north >= viewLat[0] &&
      bounds.south <= viewLat[1]
    );
  }

  // ─── 缓存 ───────────────────────────────────────────────────

  private cacheTile(key: TileKey, entry: TerrainTileEntry) {
    // 候场期间被撤下（转视角/淘汰）：直接从入场队列摘掉，别再占节拍槽位
    this.dropFromRevealQueue(entry);
    entry.mesh.visible = false;
    this.tileCache.set(key, entry);
    if (this.tileCache.size > this.maxCacheSize) {
      const oldest = this.tileCache.keys().next().value;
      if (oldest !== undefined) {
        const old = this.tileCache.get(oldest)!;
        this.tileCache.delete(oldest);
        this.disposeTileEntry(old);
      }
    }
  }

  private restoreFromCache(key: TileKey): boolean {
    const entry = this.tileCache.get(key);
    if (!entry) return false;
    this.tileCache.delete(key);
    // A cached terrain mesh is still useful before its imagery has arrived.
    entry.mesh.visible = true;
    // 重新 fade-in
    entry.bornAt = performance.now();
    // 从缓存回来的瓦片不进入场节拍：用户是转回视角，越快看到越好
    this.dropFromRevealQueue(entry);
    const mat = entry.mesh.material as THREE.MeshBasicMaterial;
    mat.transparent = true;
    mat.opacity = 0;
    this.loadedTiles.set(key, entry);
    return true;
  }

  // ─── Fallback ───────────────────────────────────────────────

  private computeFallbackKeys(visibleKeys: Set<TileKey>): Set<TileKey> {
    const retain = new Set<TileKey>();
    // Keep a loaded parent while a child is queued, loading, or failed. A
    // failed high-resolution request must fall back to the last good parent.
    const unresolved = [...visibleKeys]
      .map((key) => {
        const [x, y, zoom] = key.split(",").map(Number);
        return { key, x, y, zoom, entry: this.loadedTiles.get(key) };
      })
      .filter(
        (tile) => !tile.entry || (this.needsImagery() && !tile.entry.imageryReady),
      );
    if (unresolved.length === 0) return retain;

    for (const [key] of this.loadedTiles) {
      if (visibleKeys.has(key)) continue;
      const [tx, ty, tz] = key.split(",").map(Number);
      for (const tile of unresolved) {
        const { x: fx, y: fy, zoom: fz } = tile;
        if (this.isAncestor(tx, ty, tz, fx, fy, fz) || this.isAncestor(fx, fy, fz, tx, ty, tz)) {
          retain.add(key);
          break;
        }
      }
    }
    return retain;
  }

  private isAncestor(x: number, y: number, z: number, x2: number, y2: number, z2: number): boolean {
    if (z >= z2) return false;
    const scale = Math.pow(2, z2 - z);
    return Math.floor(x2 / scale) === x && Math.floor(y2 / scale) === y;
  }

  /** 当前是否有已加载的地形瓦片（用于外部判断是否隐藏平面底图） */
  public hasLoadedTiles(): boolean {
    return this.loadedTiles.size > 0;
  }

  /**
   * 迄今观测到的最大地形表面高度（已含夸张系数，局部坐标系绝对 Z）。
   *
   * 供调用方计算视野包围盒时做"近地补齐"：近处地形高于相机目标平面时，
   * 屏幕底边实际可见的地面会比「射线 ∩ 目标平面」的交点更靠近相机，
   * 不补齐的话这一条会落在视野包围盒之外，只能由底层级兜底瓦片顶着。
   */
  public getMaxObservedSurfaceHeight(): number {
    return this.maximumObservedSurfaceHeight;
  }

  /** 当前是否至少有一块已完成淡入的地形瓦片。 */
  public hasRenderableTiles(): boolean {
    for (const entry of this.loadedTiles.values()) {
      const material = entry.mesh.material as THREE.MeshBasicMaterial;
      if (entry.mesh.visible && material.opacity >= 1) return true;
    }
    return false;
  }

  /** Current visible target tiles and whether terrain plus imagery are ready. */
  public getViewportLoadState(): TerrainViewportLoadState {
    let loaded = 0;
    let pending = 0;
    let failed = 0;
    const failedKeys: string[] = [];
    const requiresImagery = this.needsImagery();

    for (const key of this.currentVisibleKeys) {
      const entry = this.loadedTiles.get(key);
      const isLoaded = Boolean(entry) && (!requiresImagery || entry!.imageryReady);
      if (isLoaded) {
        loaded++;
        continue;
      }

      const isPending =
        this.loading.has(key) ||
        this.pending.some((request) => request.key === key) ||
        (entry ? entry.pendingImageryZoom !== null : false);
      if (isPending) {
        pending++;
        continue;
      }

      failed++;
      failedKeys.push(key);
    }

    const total = this.currentVisibleKeys.size;
    return {
      total,
      loaded,
      pending,
      failed,
      complete: total > 0 && loaded === total,
      failedKeys,
    };
  }

  public isViewportComplete(): boolean {
    return this.getViewportLoadState().complete;
  }

  // ─── 调试着色（层级色块）验证模式 ─────────────────────────────

  /**
   * 运行时切换"层级着色"验证模式（见 debugColorByZoom 选项）。
   *
   * 开启：立即停掉影像请求/拼接，已加载瓦片改用层级纯色（色相=层级、
   * 明度=瓦片个体），于是"哪块区域实际由哪一级瓦片绘制"直接看图即可判定。
   * 关闭：恢复常规管线，已加载瓦片重新按当前目标层级拉影像（下一轮视图
   * 更新内触发）。
   */
  public setDebugColorMode(enabled: boolean): void {
    if (this.debugColorByZoom === enabled) return;
    this.debugColorByZoom = enabled;
    const applyTo = (entry: TerrainTileEntry): void => {
      const material = entry.mesh.material as THREE.MeshBasicMaterial;
      if (!material) return;
      material.map?.dispose();
      material.map = null;
      const [x, y, zoom] = entry.key.split(",").map(Number);
      if (enabled) {
        material.color.setHex(debugZoomColorHex(zoom, x, y));
        entry.imageryReady = true;
        entry.pendingImageryZoom = null;
      } else {
        material.color.setHex(TERRAIN_FALLBACK_COLOR);
        // imageryZoom 压到 -1：目标层级必然大于它，升级管线会在下一轮视图
        // 更新里重新请求影像。否则"已有同层级影像"会让它判定无事可做，
        // 瓦片永远停在调试色上。
        entry.imageryZoom = -1;
        entry.imageryCoverage = null;
        entry.imageryReady = false;
        entry.pendingImageryZoom = null;
        entry.imageryRetryAt = 0;
        entry.imageryFailures = 0;
      }
      material.needsUpdate = true;
    };
    for (const entry of this.loadedTiles.values()) applyTo(entry);
    for (const entry of this.tileCache.values()) applyTo(entry);
  }

  /** 当前是否处于层级着色验证模式。 */
  public isDebugColorMode(): boolean {
    return this.debugColorByZoom;
  }

  /**
   * 层级 → 颜色 + 计数，供图例/自动化断言使用。
   *
   * 三个数字刻意分开，避免把"兜底常驻"误读成"漏瓦片"：
   *   - `visible` 正选（本帧 LOD 集，含仍在加载的）
   *   - `backup`  已加载且可见、但**不在** LOD 集的瓦片：底图毯与粗祖先兜底。
   *               它们刻意常驻（请求不被取消、不 fade-out），且 `depthWrite=false`，
   *               只在精细瓦片覆盖不到的像素显色 —— 所以它数量大不等于画面糊。
   *   - `loaded`  实际提交绘制的瓦片数 = 正选中已加载的 + backup
   */
  public getZoomColorLegend(): Array<{
    zoom: number;
    color: string;
    visible: number;
    backup: number;
    loaded: number;
    /** 该层级瓦片到相机的最近空间距离（米）；倾斜视角下"屏幕下方"≠"距离近"，以此直读 LOD 依据 */
    minDist: number;
  }> {
    const selectedByZoom = new Map<number, number>();
    const backupByZoom = new Map<number, number>();
    const drawnByZoom = new Map<number, number>();
    const minDistByZoom = new Map<number, number>();
    const bump = (map: Map<number, number>, zoom: number) =>
      map.set(zoom, (map.get(zoom) ?? 0) + 1);

    for (const [key, entry] of this.loadedTiles) {
      if (!entry.mesh.visible) continue;
      const [x, y, zoom] = key.split(",").map(Number);
      bump(drawnByZoom, zoom);
      bump(this.currentVisibleKeys.has(key) ? selectedByZoom : backupByZoom, zoom);
      const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
      try {
        // 取四角+中心里离相机最近者：中心距离会高估"最近距离"（相机常正对
        // 瓦片边缘），导致相邻层级的距离排序失真、图例误导读图者
        const h = this.estimateTileSurfaceHeight(x, y, zoom);
        const camera = this.currentCamera;
        let d = -1;
        for (const [lng, lat] of [
          [bounds.west, bounds.south],
          [bounds.east, bounds.south],
          [bounds.west, bounds.north],
          [bounds.east, bounds.north],
          [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
        ]) {
          const p = this.gis.lngLatToThree(lng, lat, h);
          const cand = camera ? Math.round(p.distanceTo(camera.position)) : -1;
          if (cand >= 0 && (d < 0 || cand < d)) d = cand;
        }
        if (d >= 0) {
          const prev = minDistByZoom.get(zoom);
          if (prev === undefined || d < prev) minDistByZoom.set(zoom, d);
        }
      } catch {
        /* 投影失败忽略距离 */
      }
    }
    // 正选集里尚未加载完成的瓦片也要计入"正选"
    for (const key of this.currentVisibleKeys) {
      if (this.loadedTiles.has(key)) continue;
      bump(selectedByZoom, Number(key.split(",")[2]));
    }

    const zooms = [
      ...new Set([...selectedByZoom.keys(), ...backupByZoom.keys(), ...drawnByZoom.keys()]),
    ].sort((a, b) => a - b);
    return zooms.map((zoom) => ({
      zoom,
      color: `#${debugZoomColorHex(zoom).toString(16).padStart(6, "0")}`,
      visible: selectedByZoom.get(zoom) ?? 0,
      backup: backupByZoom.get(zoom) ?? 0,
      loaded: drawnByZoom.get(zoom) ?? 0,
      minDist: minDistByZoom.get(zoom) ?? -1,
    }));
  }

  // ─── 资源释放 ───────────────────────────────────────────────

  private disposeTileEntry(entry: TerrainTileEntry) {
    this.dropFromRevealQueue(entry);
    const mesh = entry.mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    this.disposeTerrainMesh(mesh);
    this.remove(mesh);
  }

  public clearAll() {
    for (const entry of this.loadedTiles.values()) this.disposeTileEntry(entry);
    this.loadedTiles.clear();
    for (const entry of this.tileCache.values()) this.disposeTileEntry(entry);
    this.tileCache.clear();
    for (const task of this.pendingTerrainRenders) {
      task.abortController.abort();
      this.disposePendingTerrainRender(task);
    }
    this.pendingTerrainRenders.length = 0;
    this.cancelStitchQueue("CesiumTerrainLayer cleared");
    this.revealQueue.length = 0;
    this.revealCredit = 1;
    this.revealLastAt = 0;
    this.revealSlotMs = 0;
    this.meshSourceCache.clear();
    this.sourceArraysLoading.clear();
  }

  /** 相机交互中（拖拽/缩放手势未结束）：限制影像升级重建规模，避免主线程画布风暴 */
  private cameraInteracting = false;
  /** 手势看门狗：交互态下相机最后移动时的位姿签名与时间戳（见 update() 顶部） */
  private interactCamSig = "";
  private interactCamMoveAt = 0;
  /**
   * 手势期间每次视图更新（200ms）最多放行的影像升级瓦片数。
   *
   * 原先是"手势内完全冻结"，但实测拖动全程清晰率只有 0~22%，松手后一次性
   * 补课会形成 160 req/s 持续数秒的突发，观感就是"转完视角请求不流畅"。
   * 调成 1 更保守，调成 0 可回到完全冻结的旧行为。
   */
  private imageryInteractingBudget = 2;

  /** 待执行的影像拼接任务队列（按 priority 升序执行）。 */
  private stitchQueue: ImageryStitchTask[] = [];
  /** 每帧影像拼接时间预算（毫秒）：超出则推迟到下一帧，防止帧雪崩。 */
  private readonly stitchBudgetMs = 8;
  /** 每帧最多执行的拼接任务数（每个任务产出一次 ~18MB 纹理上传）。 */
  private readonly stitchMaxTasksPerFrame = 2;
  /** 已派发到拼接 Worker、尚未返回的任务数（Worker 路径为异步，需限流防积压）。 */
  private stitchInFlight = 0;
  /** 拼接 Worker 在途任务上限：超出则推迟派发，避免 GPU 纹理上传风暴。 */
  private readonly stitchMaxInFlight = 4;

  /**
   * 按预算执行影像拼接任务。单个大画布拼接本身可能超过预算——
   * 预算在任务之间检查，保证每帧至少渲染一次，最坏情况一帧一个任务。
   */
  private processStitchQueue(): void {
    if (this.stitchQueue.length === 0) return;
    const frameStart = performance.now();
    let processed = 0;
    while (
      this.stitchQueue.length > 0 &&
      processed < this.stitchMaxTasksPerFrame &&
      performance.now() - frameStart < this.stitchBudgetMs
    ) {
      // Worker 拼接为异步：在途任务过多时暂停派发，任务留在队列中
      if (this.stitchInFlight >= this.stitchMaxInFlight) break;
      let best = 0;
      for (let i = 1; i < this.stitchQueue.length; i++) {
        if (this.stitchQueue[i].priority < this.stitchQueue[best].priority) best = i;
      }
      const task = this.stitchQueue.splice(best, 1)[0];
      if (task.cancelled) continue;
      task.run();
      processed++;
    }
  }

  /** 清空拼接队列并拒绝所有等待中的 promise。 */
  private cancelStitchQueue(reason: string): void {
    for (const task of this.stitchQueue) {
      task.cancelled = true;
      task.onCancel(new Error(reason));
    }
    this.stitchQueue.length = 0;
  }


  /**
   * 标记相机交互状态。交互中跳过"影像升级"（重建拼接画布 + 上传纹理的
   * 主线程大头），手势结束后由下一次视图更新一次性补齐（受
   * maxRequestsPerFrame 限制）。地形几何加载不受影响。
   */
  public setCameraInteracting(interacting: boolean): void {
    this.cameraInteracting = interacting;
  }

  /**
   * 缓存与预取状态快照（调试用）。
   * 关注 hits/misses 比值即可判断持久化缓存是否在起作用。
   */
  public getCacheStats() {
    return {
      terrain: this.terrainDiskCache?.getStats() ?? null,
      imagery: this.imageryDiskCache?.getStats() ?? null,
      prefetchedTiles: this.prefetchAttempted.size,
      prefetchInFlight: this.prefetchInFlight,
      memoryTerrainTiles: this.loadedTiles.size + this.tileCache.size,
      memoryImageryBitmaps: this.imgCache.size,
      stitchPending: this.stitchQueue.length,
      stitchInFlight: this.stitchInFlight,
      /** 已就绪、正在候场等待"入场节拍"的瓦片数 */
      revealPending: this.revealQueue.length,
      fastZoomActive: this.fastZoomActive,
      lodZoom: this.lastLodZoom,
      traversal: this.traversalDebug,
    };
  }

  public dispose() {
    this.disposed = true;
    this.metadataController.abort();
    this.lifecycleController.abort();
    this.terrainMeshPool.dispose();
    this.stitchPool.dispose();
    this.cancelStitchQueue("CesiumTerrainLayer disposed");
    this.cancelPrefetch();
    this.prefetchAttempted.clear();
    this.pending.length = 0;
    for (const task of this.pendingTerrainRenders) {
      task.abortController.abort();
      this.disposePendingTerrainRender(task);
    }
    this.pendingTerrainRenders.length = 0;
    for (const [, req] of this.loading) req.abortController.abort();
    this.loading.clear();
    this.failedTiles.clear();
    this.currentVisibleKeys.clear();
    for (const [, fading] of this.fadingOut) this.disposeTileEntry(fading.entry);
    this.fadingOut.clear();
    this.imgCache.forEach((bmp) => bmp.close());
    this.imgCache.clear();
    this.failedImagery.clear();
    for (const [, request] of this.imgLoading) request.queueAbortController.abort();
    this.imgLoading.clear();
    this.clearAll();
  }
}

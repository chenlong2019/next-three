import * as THREE from "three";
import { WEB_MERCATOR_MAX_LATITUDE, WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { requestScheduler } from "./RequestScheduler";
import { DEFAULT_TILE_SUBDOMAINS, replaceTileTemplate } from "./TileUrlTemplate";

type TileKey = string;

export type TerrainTileYOrigin = "north" | "south" | "auto";

const IMAGERY_REQUEST_PRIORITY_OFFSET = 1_000_000;

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
  /** 最低地形层级（默认0） */
  minZoom?: number;
  /** 最大地形层级（默认13，Cesium World Terrain 最高约 15） */
  maxZoom?: number;
  /** 最大LOD降级层数（默认2） */
  maxLodLevels?: number;
  /** LRU缓存最大瓦片数（默认96） */
  maxCacheSize?: number;
  /** 地形夸张系数（默认1.0） */
  exaggeration?: number;
  /** 影像URL模板（贴在地形上的卫星图，可选） */
  imageryUrlTemplate?: string;
  /** 影像 {s} 子域列表；Google 默认使用 0-3。 */
  imagerySubdomains?: readonly string[];
  /** auto 读取 layer.json 的 scheme；无元数据时保留 TMS（south）行为。 */
  tileYOrigin?: TerrainTileYOrigin;
  /** Geographic 地形相对 Web Mercator 影像的级别偏移，默认 -1。 */
  terrainZoomOffset?: number;
  /** 目标地形瓦片的影像拼接画布上限，默认 2048；父级 fallback 固定使用 512。 */
  imageryMaxCanvasSize?: number;
  /** 地形表面影像相对地形级别的额外请求偏移，默认 0。 */
  imageryZoomOffset?: number;
}

interface TerrainTileEntry {
  mesh: THREE.Mesh;
  key: TileKey;
  /** 加入场景的时间戳（用于 fade-in 动画） */
  bornAt: number;
  /** Geometry may be ready while its imagery is still loading. */
  imageryReady: boolean;
}

/** 正在 fade-out 的瓦片 */
interface FadingTile {
  entry: TerrainTileEntry;
  fadeStart: number;
}

interface PendingRequest {
  key: TileKey;
  x: number;
  y: number;
  zoom: number;
  priority: number;
  isFallback: boolean;
  abortController: AbortController;
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
  private ionResourceToken: string | null = null;
  private terrainTileTemplate: string | null = null;
  private terrainVersion: string | null = null;
  private terrainAvailability: TileAvailability[][] | null = null;
  private terrainValidBounds: TerrainValidBounds | null = null;
  private ionInitialization: Promise<void> | null = null;
  private metadataReady = false;
  private readonly metadataController = new AbortController();
  private readonly lifecycleController = new AbortController();
  private imageryUrlTemplate?: string;
  private imagerySubdomains: readonly string[];

  private loadedTiles = new Map<TileKey, TerrainTileEntry>();
  private tileCache = new Map<TileKey, TerrainTileEntry>();
  private pending: PendingRequest[] = [];
  private loading = new Map<TileKey, PendingRequest>();
  /** 失败记录：key → { retries, lastAttempt } */
  private failedTiles = new Map<TileKey, { retries: number; lastAttempt: number }>();
  /** 最大重试次数（超过后不再请求） */
  private maxRetries = 2;
  /** 重试冷却时间（ms），冷却期内不重新入队 */
  private retryCooldown = 10000;

  private maxConcurrent: number;
  private maxQueueSize: number;
  private maxRequestsPerFrame: number;
  private minZoom: number;
  private maxZoom: number;
  private maxLodLevels: number;
  private maxCacheSize: number;
  private exaggeration: number;
  private disposed = false;
  /** 当前帧统一影像层级（由 updateTilesInView 计算），所有瓦片使用相同影像分辨率 */
  private currentImageryZoom = 4;
  /** 共享影像图片缓存：相邻地形瓦片复用相同 Mercator 影像瓦片，避免重复请求 */
  private imgCache = new Map<string, ImageBitmap>();
  /** 正在下载的影像请求，避免同一缓存键并发重复请求。 */
  private imgLoading = new Map<string, Promise<ImageBitmap>>();
  private readonly maxImgCacheSize = 300;
  /** 正在 fade-out 的瓦片（动画结束后才真正移除） */
  private fadingOut = new Map<TileKey, FadingTile>();
  private readonly FADE_IN_MS = 300;
  private readonly FADE_OUT_MS = 200;

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
    this.terrainUrl = config.terrainUrl.replace(/\/$/, "");
    this.accessToken = config.accessToken;
    this.isTileUrlTemplate = /\{[xyz]\}/.test(this.terrainUrl);
    const yOrigin = options.tileYOrigin ?? "auto";
    this.tileYOrigin = yOrigin === "north" ? "north" : "south";
    // A full URL template has no layer.json path to probe. Its defaults are
    // intentionally compatible with Cesium Geographic/TMS services.
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

    this.maxConcurrent = options.maxConcurrent ?? 10;
    this.maxQueueSize = options.maxQueueSize ?? 128;
    this.maxRequestsPerFrame = options.maxRequestsPerFrame ?? 8;
    this.minZoom = options.minZoom ?? 1;
    this.maxZoom = options.maxZoom ?? 13;
    this.maxLodLevels = options.maxLodLevels ?? 2;
    this.maxCacheSize = options.maxCacheSize ?? 96;
    this.exaggeration = options.exaggeration ?? 1.0;
    if (!this.metadataReady || this.isCesiumIonUrl()) {
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
  ) {
    if (this.disposed || !this.metadataReady) return;

    const terrainZoom = THREE.MathUtils.clamp(
      baseZoom + this.terrainZoomOffset,
      this.minZoom,
      this.maxZoom,
    );
    // Keep imagery detailed enough for the terrain LOD without always
    // requesting the global maximum zoom. fetchImagery may lower it further
    // when the destination canvas would exceed its size limit.
    this.currentImageryZoom = Math.min(
      this.maxZoom + 3 + this.imageryZoomOffset,
      terrainZoom + 4 + this.imageryZoomOffset,
    );
    const [lngMin, lngMax] = viewLngBounds;
    const [latMin, latMax] = viewLatBounds;
    const target = cameraTarget ?? new THREE.Vector3(0, 0, 0);
    const camPos = cameraPosition;
    // 扩大高精度覆盖范围：3 倍相机距离内都用最高 LOD，减少倾斜视角下的低等级瓦片
    const nearRadius = (cameraDistance ?? 50000) * 3;

    const swTile = lngLatToGeoTile(lngMin, latMin, terrainZoom, this.tileYOrigin);
    const neTile = lngLatToGeoTile(lngMax, latMax, terrainZoom, this.tileYOrigin);

    const xStart = Math.min(swTile.x, neTile.x);
    const xEnd = Math.max(swTile.x, neTile.x);
    const yStart = Math.min(swTile.y, neTile.y);
    const yEnd = Math.max(swTile.y, neTile.y);

    const MAX_TILES = 1024;
    const totalTiles = (xEnd - xStart + 1) * (yEnd - yStart + 1);

    const visibleKeys = new Set<TileKey>();
    const tilesToLoad: { key: TileKey; x: number; y: number; zoom: number; priority: number }[] =
      [];

    if (totalTiles <= MAX_TILES) {
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

    const fallbackParentKeys = this.enqueueFallbackParents(tilesToLoad, visibleKeys);

    for (const tile of tilesToLoad) {
      this.enqueue(tile.key, tile.x, tile.y, tile.zoom, tile.priority);
    }

    this.cancelExcept(visibleKeys, fallbackParentKeys);

    const fallbackKeys = this.computeFallbackKeys(visibleKeys);

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

    // 不再可见的瓦片 → 开始 fade-out（而非立即移除）
    for (const [key, entry] of this.loadedTiles) {
      if (!visibleKeys.has(key) && !fallbackKeys.has(key)) {
        this.loadedTiles.delete(key);
        const mat = entry.mesh.material as THREE.MeshBasicMaterial;
        mat.transparent = true;
        this.fadingOut.set(key, { entry, fadeStart: performance.now() });
      }
    }

    this.processQueue();
  }

  /**
   * 每帧调用：驱动 LOD 过渡动画（fade-in / fade-out）
   * 应在渲染循环中调用，不受 200ms 节流限制
   */
  public update() {
    const now = performance.now();

    // fade-in：新瓦片透明度 0 → 1
    for (const [, entry] of this.loadedTiles) {
      const mat = entry.mesh.material as THREE.MeshBasicMaterial;
      if (!mat.transparent) continue; // 已完成
      const t = (now - entry.bornAt) / this.FADE_IN_MS;
      if (t >= 1) {
        mat.opacity = 1;
        mat.transparent = false; // 关闭透明，避免排序问题
      } else {
        mat.opacity = t;
      }
    }

    // fade-out：旧瓦片透明度 1 → 0，结束后缓存
    for (const [key, fading] of this.fadingOut) {
      const mat = fading.entry.mesh.material as THREE.MeshBasicMaterial;
      const t = (now - fading.fadeStart) / this.FADE_OUT_MS;
      if (t >= 1) {
        this.fadingOut.delete(key);
        mat.opacity = 0;
        this.cacheTile(key, fading.entry);
      } else {
        mat.opacity = 1 - t;
      }
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
  ) {
    if (this.loading.has(key)) return;

    // 失败重试保护：超过最大重试次数则永久跳过；冷却期内不重新入队
    const failRecord = this.failedTiles.get(key);
    if (failRecord) {
      if (failRecord.retries >= this.maxRetries) return;
      if (Date.now() - failRecord.lastAttempt < this.retryCooldown) return;
    }

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
      abortController: new AbortController(),
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

  private cancelExcept(visibleKeys: Set<TileKey>, retainedKeys: Set<TileKey> = new Set()) {
    this.pending = this.pending.filter((r) => visibleKeys.has(r.key) || retainedKeys.has(r.key));
    for (const [key, req] of this.loading) {
      if (!visibleKeys.has(key) && !retainedKeys.has(key)) {
        req.abortController.abort();
        this.loading.delete(key);
      }
    }
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

  private async startLoad(req: PendingRequest) {
    this.loading.set(req.key, req);
    const { x, y, zoom, key } = req;
    const signal = req.abortController.signal;

    try {
      const terrainBuffer = await this.fetchTerrain(x, y, zoom, signal, req.priority);
      if (signal.aborted || !this.loading.has(key)) return;

      const decoded = parseQuantizedMesh(terrainBuffer);
      const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
      const geo = this.buildTerrainGeometry(decoded, bounds);

      // 先用纯色立即显示地形，不等影像；初始透明，由 update() 做 fade-in
      const mat = new THREE.MeshBasicMaterial({
        color: 0x8b9467,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -(zoom + 2),
        polygonOffsetUnits: -1,
        transparent: true,
        opacity: 0,
      });

      const mesh = new THREE.Mesh(geo, mat);
      const requiresImagery = Boolean(this.imageryUrlTemplate);
      // Cesium keeps the textured ancestor visible until the child's imagery
      // is ready. Showing an untextured solid-color mesh causes the whole view
      // to flash yellow whenever the camera changes.
      mesh.visible = !requiresImagery;
      mesh.renderOrder = zoom;

      this.loading.delete(key);
      this.failedTiles.delete(key);
      const entry: TerrainTileEntry = {
        mesh,
        key,
        bornAt: performance.now(),
        imageryReady: !requiresImagery,
      };
      this.loadedTiles.set(key, entry);
      this.add(mesh);

      // 影像异步加载，完成后替换纹理
      if (this.imageryUrlTemplate) {
        const imageryCanvasSize = req.isFallback
          ? Math.min(512, this.imageryMaxCanvasSize)
          : this.imageryMaxCanvasSize;
        this.fetchImagery(x, y, zoom, signal, req.priority, imageryCanvasSize)
          .then((texture) => {
            if (signal.aborted) {
              texture.dispose();
              return;
            }
            if (!this.loadedTiles.has(key) && !this.tileCache.has(key)) {
              texture.dispose();
              return;
            }
            mat.map = texture;
            mat.color.set(0xffffff);
            mat.needsUpdate = true;
            entry.imageryReady = true;
            mesh.visible = this.loadedTiles.has(key);
          })
          .catch(() => {
            /* Keep the textured ancestor visible on failure. */
          });
      }
    } catch (err: unknown) {
      if (signal.aborted) return;
      this.loading.delete(key);
      const errorName = err instanceof Error ? err.name : undefined;
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorName !== "AbortError") {
        const record = this.failedTiles.get(key);
        if (record) {
          record.retries++;
          record.lastAttempt = Date.now();
        } else {
          this.failedTiles.set(key, { retries: 1, lastAttempt: Date.now() });
        }
        const retries = this.failedTiles.get(key)!.retries;
        if (retries <= this.maxRetries) {
          console.warn(
            `[CesiumTerrainLayer] 加载失败 ${key} (${retries}/${this.maxRetries}):`,
            errorMessage,
          );
        }
      }
    }
  }

  // ─── 网络请求 ───────────────────────────────────────────────

  private async initializeTerrainSource(): Promise<void> {
    try {
      if (this.isCesiumIonUrl()) await this.resolveIonAssetEndpoint();
      await this.loadTilingScheme();
    } catch (error: unknown) {
      if (!this.disposed) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[CesiumTerrainLayer] Cesium Ion 初始化失败:", message);
      }
    }
  }

  private async resolveIonAssetEndpoint(): Promise<void> {
    const endpoint = new URL("https://api.cesium.com/v1/assets/1/endpoint");
    endpoint.searchParams.set("access_token", this.accessToken);
    const response = await fetch(endpoint, {
      signal: this.metadataController.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Ion endpoint HTTP ${response.status}`);
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
    this.terrainUrl = resourceUrl.toString().replace(/\/$/, "");
    this.isTileUrlTemplate = false;
    this.ionResourceToken = payload.accessToken;
  }

  private async loadTilingScheme(): Promise<void> {
    const timeout = setTimeout(() => this.metadataController.abort(), 5000);
    let succeeded = false;
    try {
      const response = await fetch(this.getTerrainUrl("layer.json"), {
        signal: this.metadataController.signal,
        headers: this.getTerrainHeaders("application/json"),
      });
      if (!response.ok || this.disposed) {
        if (!this.disposed && response.status === 401) {
          throw new Error("Terrain resource authorization returned HTTP 401.");
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
      // Older services may expose only .terrain files. Keep the TMS default.
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

  private fetchTerrain(
    x: number,
    y: number,
    zoom: number,
    signal: AbortSignal,
    priority: number,
  ): Promise<ArrayBuffer> {
    const url = this.getTerrainUrl(`${zoom}/${x}/${y}.terrain`);
    const headers = this.getTerrainHeaders(
      "application/vnd.quantized-mesh,application/octet-stream;q=0.9",
    );
    return requestScheduler.schedule({
      url,
      priority,
      signal,
      load: async () => {
        const res = await fetch(url, { signal, headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      },
    });
  }

  /**
   * 多瓦片拼接影像（优化版）：
   * - 影像层级以相机目标层级为起点，所有地形瓦片共享同一影像层级，保证清晰度一致
   * - 仅当 Canvas 超过 MAX_CANVAS 时才逐级降低，避免低 LOD 瓦片产生过多请求
   * - 共享图片缓存：相邻地形瓦片复用相同 Mercator 影像，大幅减少网络请求
   * - Canvas 精确对齐地形瓦片边界，无缩放损失
   */
  private fetchImagery(
    x: number,
    y: number,
    zoom: number,
    signal: AbortSignal,
    priority: number,
    maxCanvasSize: number,
  ): Promise<THREE.Texture> {
    const bounds = geoTileBounds(x, y, zoom, this.tileYOrigin);
    const TILE_PX = 256;
    const MAX_CANVAS = maxCanvasSize;

    const lngToPixelX = (lng: number, n: number) => ((lng + 180) / 360) * n * TILE_PX;
    const latToPixelY = (lat: number, n: number) => {
      const rad = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TILE_PX;
    };

    // 从帧级影像层级开始，若 Canvas 过大则逐级降低
    let imageryZoom = this.currentImageryZoom;
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

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;

    // 先铺底色，防止瓦片缝隙/加载失败处出现纯黑像素
    ctx.fillStyle = "#6B7355";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 需要加载的 Mercator 瓦片范围
    const tileXMin = Math.floor(pxWest / TILE_PX);
    const tileXMax = Math.floor((pxEast - 0.001) / TILE_PX);
    const tileYMin = Math.floor(pxNorth / TILE_PX);
    const tileYMax = Math.floor((pxSouth - 0.001) / TILE_PX);

    // 并行加载（命中缓存则同步绘制）
    const promises: Promise<void>[] = [];
    for (let tx = tileXMin; tx <= tileXMax; tx++) {
      for (let ty = tileYMin; ty <= tileYMax; ty++) {
        const drawX = tx * TILE_PX - pxWest;
        const drawY = ty * TILE_PX - pxNorth;
        const cacheKey = `${imageryZoom}/${tx}/${ty}`;

        // 缓存命中 → 直接绘制，无需网络请求
        const cached = this.imgCache.get(cacheKey);
        if (cached) {
          ctx.drawImage(cached, drawX, drawY, TILE_PX, TILE_PX);
          continue;
        }

        const url = replaceTileTemplate(
          this.imageryUrlTemplate!,
          tx,
          ty,
          imageryZoom,
          this.imagerySubdomains,
        );

        const p = this.getOrLoadImage(cacheKey, url, priority)
          .then((img) => {
            if (img && !signal.aborted) {
              ctx.drawImage(img, drawX, drawY, TILE_PX, TILE_PX);
            }
          })
          .catch(() => {
            /* 单块失败不阻塞 */
          });
        promises.push(p);
      }
    }

    return Promise.all(promises).then(() => {
      if (signal.aborted) throw new Error("aborted");
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      tex.flipY = true;
      return tex;
    });
  }

  /** 从共享缓存获取或加载影像（createImageBitmap 在后台线程解码，不阻塞主线程） */
  private getOrLoadImage(key: string, url: string, priority: number): Promise<ImageBitmap> {
    const cached = this.imgCache.get(key);
    if (cached) return Promise.resolve(cached);

    const loading = this.imgLoading.get(key);
    if (loading) return loading;

    // The shared request intentionally outlives one tile's abort signal. A
    // neighboring terrain tile may still need the same image after a view change.
    const signal = this.lifecycleController.signal;
    const request = requestScheduler
      .schedule({
        url,
        priority: priority + IMAGERY_REQUEST_PRIORITY_OFFSET,
        signal,
        load: async () => {
          const res = await fetch(url, { mode: "cors", signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return createImageBitmap(await res.blob());
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
        this.imgCache.set(key, bitmap);
        return bitmap;
      })
      .finally(() => {
        if (this.imgLoading.get(key) === request) this.imgLoading.delete(key);
      });
    this.imgLoading.set(key, request);
    return request;
  }

  // ─── 几何构建 ───────────────────────────────────────────────

  private buildTerrainGeometry(
    data: QuantizedMeshData,
    bounds: { west: number; east: number; south: number; north: number },
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

    this.addSkirt(geo, vertexCount, heightRange);

    return geo;
  }

  /** 裙边：沿边界向下延伸遮住裂缝 */
  private addSkirt(geo: THREE.BufferGeometry, originalVertexCount: number, heightRange: number) {
    const skirtHeight = Math.max(80, heightRange * 0.2);
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
    geo.computeVertexNormals();
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
    const center = this.gis.lngLatToThree(centerLng, centerLat, 0);
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

  // ─── 缓存 ───────────────────────────────────────────────────

  private cacheTile(key: TileKey, entry: TerrainTileEntry) {
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
    entry.mesh.visible = entry.imageryReady;
    // 重新 fade-in
    entry.bornAt = performance.now();
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
        (tile) => !tile.entry || (Boolean(this.imageryUrlTemplate) && !tile.entry.imageryReady),
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

  /** 当前是否至少有一块已完成淡入的地形瓦片。 */
  public hasRenderableTiles(): boolean {
    for (const entry of this.loadedTiles.values()) {
      const material = entry.mesh.material as THREE.MeshBasicMaterial;
      if (entry.mesh.visible && material.opacity >= 1) return true;
    }
    return false;
  }

  // ─── 资源释放 ───────────────────────────────────────────────

  private disposeTileEntry(entry: TerrainTileEntry) {
    const mesh = entry.mesh;
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.map) mat.map.dispose();
    mat.dispose();
    this.remove(mesh);
  }

  public clearAll() {
    for (const entry of this.loadedTiles.values()) this.disposeTileEntry(entry);
    this.loadedTiles.clear();
    for (const entry of this.tileCache.values()) this.disposeTileEntry(entry);
    this.tileCache.clear();
  }

  public dispose() {
    this.disposed = true;
    this.metadataController.abort();
    this.lifecycleController.abort();
    this.pending.length = 0;
    for (const [, req] of this.loading) req.abortController.abort();
    this.loading.clear();
    for (const [, fading] of this.fadingOut) this.disposeTileEntry(fading.entry);
    this.fadingOut.clear();
    this.imgCache.forEach((bmp) => bmp.close());
    this.imgCache.clear();
    this.imgLoading.clear();
    this.clearAll();
  }
}

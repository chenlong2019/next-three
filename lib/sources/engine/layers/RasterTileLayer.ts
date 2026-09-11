import * as THREE from "three";
import { getTileBounds, lngLatToTile } from "../utils/gis-utils";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";
import { TileRequestQueue, TileRequest, TileRequestQueueOptions } from "./TileRequestQueue";

type TileKey = string;

/**
 * 栅格瓦片图层通用配置
 */
export interface RasterTileLayerOptions {
  /** 本图层最多同时在途的请求数；共享调度器仍按 origin 限制网络并发。 */
  maxConcurrent?: number;
  /** 等待队列容量（默认256） */
  maxQueueSize?: number;
  /** 每帧最多新发起请求数（默认4） */
  maxRequestsPerFrame?: number;
  /** 最低瓦片层级（远处LOD下限，默认1） */
  minZoom?: number;
  /** 最高瓦片层级（默认22）。 */
  maxZoom?: number;
  /** 最大LOD降级层数（默认4） */
  maxLodLevels?: number;
  /** LRU缓存最大瓦片数（默认200） */
  maxCacheSize?: number;
  /** 单次视口更新允许保留的瓦片数量上限（默认512）。 */
  maxTilesPerView?: number;
  /** 平面影像的固定海拔高度，单位为米（默认0） */
  altitude?: number;
  /** 影像颜色乘数，可用于夜景压暗或色调统一（默认白色） */
  color?: THREE.ColorRepresentation;
  /** 影像图层透明度，范围 0-1（默认1） */
  opacity?: number;
  /** {s} 子域列表；Google 默认使用 0-3。 */
  subdomains?: readonly string[];
  /** Keep full-resolution tiles within this multiple of camera distance. */
  lodNearRadiusMultiplier?: number;
}

/** 传给基类的队列构造参数（由子类决定 urlTemplate 或 buildUrl） */
type QueueConfig = Pick<TileRequestQueueOptions, "urlTemplate" | "buildUrl" | "subdomains">;

/**
 * 栅格瓦片图层抽象基类
 *
 * 统一实现：优先级队列调度、多级LOD、LRU缓存、父级Fallback、
 * 网格几何构建、固定地表高度、视口更新循环。
 *
 * 子类只需通过 QueueConfig 决定如何构建瓦片请求URL：
 * - TileLayer：XYZ 模板（urlTemplate）
 * - WMSLayer：OGC GetMap（buildUrl）
 */
export abstract class RasterTileLayer extends THREE.Group {
  protected gis: WebMercatorGIS;
  /** 当前正在显示的瓦片 */
  protected loadedTiles = new Map<TileKey, THREE.Mesh>();
  /** LRU缓存：离开视口但保留在内存中的瓦片（visible=false） */
  protected tileCache = new Map<TileKey, THREE.Mesh>();
  protected queue: TileRequestQueue;
  protected minZoom: number;
  protected maxZoom: number;
  protected maxLodLevels: number;
  protected maxCacheSize: number;
  protected maxTilesPerView: number;
  protected altitude: number;
  protected color: THREE.Color;
  protected opacity: number;
  protected lodNearRadiusMultiplier: number;
  private enabled = true;

  constructor(gis: WebMercatorGIS, queueConfig: QueueConfig, options: RasterTileLayerOptions = {}) {
    super();
    this.gis = gis;
    this.minZoom = options.minZoom ?? 1;
    this.maxZoom = options.maxZoom ?? 22;
    this.maxLodLevels = options.maxLodLevels ?? 4;
    this.maxCacheSize = options.maxCacheSize ?? 200;
    this.maxTilesPerView = options.maxTilesPerView ?? 512;
    this.altitude = options.altitude ?? 0;
    this.color = new THREE.Color(options.color ?? 0xffffff);
    this.opacity = options.opacity ?? 1;
    this.lodNearRadiusMultiplier = options.lodNearRadiusMultiplier ?? 1;
    if (!Number.isFinite(this.altitude)) {
      throw new TypeError("Raster tile altitude must be a finite number.");
    }
    if (!Number.isFinite(this.opacity) || this.opacity < 0 || this.opacity > 1) {
      throw new RangeError("Raster tile opacity must be between 0 and 1.");
    }
    if (!Number.isFinite(this.lodNearRadiusMultiplier) || this.lodNearRadiusMultiplier <= 0) {
      throw new RangeError("Raster tile lodNearRadiusMultiplier must be greater than 0.");
    }
    if (!Number.isInteger(this.maxZoom) || this.maxZoom < this.minZoom) {
      throw new RangeError("Raster tile maxZoom must be an integer >= minZoom.");
    }
    if (!Number.isInteger(this.maxTilesPerView) || this.maxTilesPerView < 16) {
      throw new RangeError("Raster tile maxTilesPerView must be an integer of at least 16.");
    }

    this.queue = new TileRequestQueue({
      ...queueConfig,
      subdomains: options.subdomains ?? queueConfig.subdomains,
      maxConcurrent: options.maxConcurrent ?? 50,
      maxQueueSize: options.maxQueueSize ?? 256,
      maxRequestsPerFrame: options.maxRequestsPerFrame ?? 4,
      onLoad: (req, texture) => this.onTileLoaded(req, texture),
      onError: (req, err) => {
        console.warn(`[${this.constructor.name}] 瓦片加载失败 ${req.key}:`, err.message);
      },
    });
  }

  protected getKey(x: number, y: number, zoom: number): TileKey {
    return `${x},${y},${zoom}`;
  }

  // ─── 缓存管理 ───────────────────────────────────────────────

  /**
   * 将瓦片从显示列表移入缓存（隐藏但不销毁）
   */
  protected cacheTile(key: TileKey, mesh: THREE.Mesh) {
    mesh.visible = false;
    this.tileCache.set(key, mesh);
    if (this.tileCache.size > this.maxCacheSize) {
      const oldest = this.tileCache.keys().next().value;
      if (oldest !== undefined) {
        const oldMesh = this.tileCache.get(oldest)!;
        this.tileCache.delete(oldest);
        this.disposeTile(oldMesh);
      }
    }
  }

  /**
   * 尝试从缓存恢复瓦片（免网络请求）
   */
  protected restoreFromCache(key: TileKey): boolean {
    const mesh = this.tileCache.get(key);
    if (!mesh) return false;
    this.tileCache.delete(key);
    mesh.visible = true;
    this.loadedTiles.set(key, mesh);
    return true;
  }

  // ─── Fallback 判断 ──────────────────────────────────────────

  /**
   * 判断 (x,y,z) 是否是 (x2,y2,z2) 的祖先
   */
  protected isAncestor(
    x: number,
    y: number,
    z: number,
    x2: number,
    y2: number,
    z2: number,
  ): boolean {
    if (z >= z2) return false;
    const scale = Math.pow(2, z2 - z);
    return Math.floor(x2 / scale) === x && Math.floor(y2 / scale) === y;
  }

  /**
   * 判断 (x,y,z) 是否是 (x2,y2,z2) 的后代
   */
  protected isDescendant(
    x: number,
    y: number,
    z: number,
    x2: number,
    y2: number,
    z2: number,
  ): boolean {
    return this.isAncestor(x2, y2, z2, x, y, z);
  }

  /**
   * 计算需要保留为fallback的瓦片key集合（防止zoom切换白屏）
   */
  protected computeFallbackKeys(
    visibleKeys: Set<TileKey>,
    tilesToLoad: { key: TileKey; x: number; y: number; zoom: number }[],
  ): Set<TileKey> {
    const retain = new Set<TileKey>();
    // Keep a loaded parent while its child is queued, loading, or failed.
    // A failed child must not make the already-valid fallback disappear.
    const unresolved = tilesToLoad.filter((tile) => !this.loadedTiles.has(tile.key));
    if (unresolved.length === 0) return retain;

    for (const [key] of this.loadedTiles) {
      if (visibleKeys.has(key)) continue;
      const [tx, ty, tz] = key.split(",").map(Number);
      for (const ft of unresolved) {
        if (
          this.isAncestor(tx, ty, tz, ft.x, ft.y, ft.zoom) ||
          this.isDescendant(tx, ty, tz, ft.x, ft.y, ft.zoom)
        ) {
          retain.add(key);
          break;
        }
      }
    }
    return retain;
  }

  // ─── 瓦片加载回调 ───────────────────────────────────────────

  /**
   * 瓦片纹理加载完成 → 构建Mesh加入场景
   */
  protected onTileLoaded(req: TileRequest, texture: THREE.Texture) {
    const { x, y, zoom, key } = req;
    if (this.loadedTiles.has(key)) {
      texture.dispose();
      return;
    }

    const bounds = getTileBounds(x, y, zoom);
    const sw = this.gis.lngLatToThree(bounds.west, bounds.south, this.altitude);
    const se = this.gis.lngLatToThree(bounds.east, bounds.south, this.altitude);
    const ne = this.gis.lngLatToThree(bounds.east, bounds.north, this.altitude);
    const nw = this.gis.lngLatToThree(bounds.west, bounds.north, this.altitude);

    const positions = new Float32Array([
      sw.x,
      sw.y,
      sw.z,
      se.x,
      se.y,
      se.z,
      ne.x,
      ne.y,
      ne.z,

      ne.x,
      ne.y,
      ne.z,
      nw.x,
      nw.y,
      nw.z,
      sw.x,
      sw.y,
      sw.z,
    ]);
    const uvs = new Float32Array([
      0,
      0, // SW
      1,
      0, // SE
      1,
      1, // NE

      1,
      1, // NE
      0,
      1, // NW
      0,
      0, // SW
    ]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      color: this.color,
      opacity: this.opacity,
      side: THREE.DoubleSide,
      transparent: this.opacity < 1,
      polygonOffset: true,
      // Parent fallback tiles can overlap their higher-resolution children
      // for one or more frames. Push detail tiles toward the camera so the
      // transition never produces depth fighting.
      polygonOffsetFactor: -Math.max(zoom, 1) * 2,
      polygonOffsetUnits: -2,
    });

    const mesh = new THREE.Mesh(geo, mat);
    // Render coarse fallback tiles first and detailed tiles last. The depth
    // offset above handles the remaining coplanar overlap.
    mesh.renderOrder = zoom;
    this.add(mesh);
    this.loadedTiles.set(key, mesh);
  }

  // ─── LOD 计算 ───────────────────────────────────────────────

  protected tileDistanceTo(x: number, y: number, zoom: number, target: THREE.Vector3): number {
    const bounds = getTileBounds(x, y, zoom);
    const centerLng = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const center = this.gis.lngLatToThree(centerLng, centerLat, this.altitude);
    return center.distanceTo(target);
  }

  /**
   * 根据距离计算有效zoom：近处保持baseZoom，每翻倍距离降一级
   */
  protected getEffectiveZoom(distance: number, baseZoom: number, nearRadius: number): number {
    if (distance <= nearRadius) return baseZoom;
    const ratio = distance / nearRadius;
    const zoomOffset = Math.floor(Math.log2(ratio));
    const clampedOffset = Math.min(zoomOffset, this.maxLodLevels);
    return Math.max(this.minZoom, baseZoom - clampedOffset);
  }

  /**
   * 将baseZoom下的瓦片坐标转换为effectiveZoom下的父级瓦片坐标
   */
  protected toParentTile(
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

  // ─── 核心更新入口 ───────────────────────────────────────────

  /**
   * 根据当前视口更新瓦片（多级LOD + 缓存 + Fallback）
   */
  public updateTilesInView(
    viewLngBounds: [number, number],
    viewLatBounds: [number, number],
    baseZoom: number,
    cameraTarget?: THREE.Vector3,
    cameraDistance?: number,
  ) {
    if (!this.enabled) return;
    baseZoom = Math.max(this.minZoom, Math.min(this.maxZoom, Math.floor(baseZoom)));
    const [lngMin, lngMax] = viewLngBounds;
    const [latMin, latMax] = viewLatBounds;
    const target = cameraTarget ?? new THREE.Vector3(0, 0, 0);
    const nearRadius = (cameraDistance ?? 50000) * this.lodNearRadiusMultiplier;

    const swTile = lngLatToTile(lngMin, latMin, baseZoom);
    const neTile = lngLatToTile(lngMax, latMax, baseZoom);

    const xStart = Math.min(swTile.x, neTile.x);
    const xEnd = Math.max(swTile.x, neTile.x);
    const yStart = Math.min(swTile.y, neTile.y);
    const yEnd = Math.max(swTile.y, neTile.y);

    const totalTiles = (xEnd - xStart + 1) * (yEnd - yStart + 1);

    const visibleKeys = new Set<TileKey>();
    const tilesToLoad: { key: TileKey; x: number; y: number; zoom: number; priority: number }[] =
      [];

    if (totalTiles <= this.maxTilesPerView) {
      for (let x = xStart; x <= xEnd; x++) {
        for (let y = yStart; y <= yEnd; y++) {
          const dist = this.tileDistanceTo(x, y, baseZoom, target);
          const effectiveZoom = this.getEffectiveZoom(dist, baseZoom, nearRadius);
          const parent = this.toParentTile(x, y, baseZoom, effectiveZoom);
          const key = this.getKey(parent.x, parent.y, effectiveZoom);

          if (visibleKeys.has(key)) continue;
          visibleKeys.add(key);
          if (this.loadedTiles.has(key)) continue;
          if (this.restoreFromCache(key)) continue;
          tilesToLoad.push({ key, x: parent.x, y: parent.y, zoom: effectiveZoom, priority: dist });
        }
      }
    } else {
      let fallbackZoom = Math.max(this.minZoom, baseZoom - this.maxLodLevels);
      while (fallbackZoom > this.minZoom) {
        const factor = Math.pow(2, baseZoom - fallbackZoom);
        const estimatedTiles =
          Math.ceil((xEnd - xStart + 1) / factor) * Math.ceil((yEnd - yStart + 1) / factor);
        if (estimatedTiles <= this.maxTilesPerView) break;
        fallbackZoom--;
      }
      const swF = lngLatToTile(lngMin, latMin, fallbackZoom);
      const neF = lngLatToTile(lngMax, latMax, fallbackZoom);
      const fxStart = Math.min(swF.x, neF.x);
      const fxEnd = Math.max(swF.x, neF.x);
      const fyStart = Math.min(swF.y, neF.y);
      const fyEnd = Math.max(swF.y, neF.y);

      for (let x = fxStart; x <= fxEnd; x++) {
        for (let y = fyStart; y <= fyEnd; y++) {
          const key = this.getKey(x, y, fallbackZoom);
          if (visibleKeys.has(key)) continue;
          visibleKeys.add(key);
          if (this.loadedTiles.has(key)) continue;
          if (this.restoreFromCache(key)) continue;
          const dist = this.tileDistanceTo(x, y, fallbackZoom, target);
          tilesToLoad.push({ key, x, y, zoom: fallbackZoom, priority: dist });
        }
      }
    }

    for (const tile of tilesToLoad) {
      this.queue.enqueue(tile.key, tile.x, tile.y, tile.zoom, tile.priority);
    }

    this.queue.cancelExcept(visibleKeys);

    const fallbackKeys = this.computeFallbackKeys(visibleKeys, tilesToLoad);

    for (const [key, mesh] of this.loadedTiles) {
      if (!visibleKeys.has(key) && !fallbackKeys.has(key)) {
        this.loadedTiles.delete(key);
        this.cacheTile(key, mesh);
      }
    }

    this.queue.processQueue();
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.queue.cancelAll();
      this.clearAll();
    }
  }

  // ─── 资源释放 ───────────────────────────────────────────────

  protected disposeTile(mesh: THREE.Mesh) {
    const geo = mesh.geometry;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (mat.map) mat.map.dispose();
    geo.dispose();
    mat.dispose();
    this.remove(mesh);
  }

  /**
   * 清空所有瓦片（包括缓存）
   */
  public clearAll() {
    for (const mesh of this.loadedTiles.values()) this.disposeTile(mesh);
    this.loadedTiles.clear();
    for (const mesh of this.tileCache.values()) this.disposeTile(mesh);
    this.tileCache.clear();
  }

  /**
   * 销毁图层：取消所有请求 + 清空全部资源
   */
  public dispose() {
    this.queue.dispose();
    this.clearAll();
  }
}

import * as THREE from "three";
import { requestScheduler } from "./RequestScheduler";
import { DEFAULT_TILE_SUBDOMAINS, replaceTileTemplate } from "./TileUrlTemplate";

/**
 * 瓦片加载状态
 */
export enum TileLoadState {
  /** 在队列中等待加载 */
  PENDING = "pending",
  /** 正在网络请求中 */
  LOADING = "loading",
  /** 加载完成 */
  LOADED = "loaded",
  /** 加载失败 */
  FAILED = "failed",
}

/**
 * 单个瓦片请求描述
 */
export interface TileRequest {
  key: string;
  x: number;
  y: number;
  zoom: number;
  /** 优先级：值越小越优先（通常为到相机目标点的距离） */
  priority: number;
  state: TileLoadState;
  abortController: AbortController | null;
}

export interface TileRequestQueueOptions {
  /** 本图层最多同时在途的请求数；真实网络并发由共享调度器按 origin 限制。 */
  maxConcurrent?: number;
  /** 等待队列最大容量（默认256） */
  maxQueueSize?: number;
  /** 每帧最多新发起的请求数（默认4，避免单帧阻塞） */
  maxRequestsPerFrame?: number;
  /** 瓦片图片URL模板（XYZ瓦片服务用，与 buildUrl 二选一） */
  urlTemplate?: string;
  /** 自定义URL构建器（WMS/WMTS等服务用），优先级高于 urlTemplate */
  buildUrl?: (req: TileRequest) => string;
  /** {s} 子域列表；默认使用 Google 的 0-3。 */
  subdomains?: readonly string[];
  /** 跨子域共享的调度组，例如天地图的 t0-t7 共用一个限流额度。 */
  requestGroup?: string;
  /** 指定调度组的最大并发；用于限制浏览器端 tk 的请求速率。 */
  maximumRequestsPerServer?: number;
  /** 失败瓦片再次入队前的冷却时间（毫秒）。 */
  failureCooldownMs?: number;
  /** 瓦片加载成功回调 */
  onLoad: (req: TileRequest, texture: THREE.Texture) => void;
  /** 瓦片加载失败回调 */
  onError?: (req: TileRequest, error: Error) => void;
}

/**
 * 仿Cesium的瓦片请求队列
 *
 * 核心机制：
 * 1. 优先级排序 —— 距相机目标点近的瓦片优先加载
 * 2. 并发控制 —— 限制同时进行的网络请求数
 * 3. 帧预算 —— 每帧最多启动 N 个新请求，避免主线程卡顿
 * 4. 可取消 —— 离开视口的瓦片立即取消pending/loading请求
 * 5. 去重 —— 同一瓦片不会重复入队
 */
export class TileRequestQueue {
  private pending: TileRequest[] = [];
  private loading = new Map<string, TileRequest>();
  private urlTemplate?: string;
  private buildUrl?: (req: TileRequest) => string;
  private subdomains: readonly string[];
  private requestGroup?: string;
  private maximumRequestsPerServer?: number;
  private failureCooldownMs: number;
  private failedAt = new Map<string, number>();
  private maxConcurrent: number;
  private maxQueueSize: number;
  private maxRequestsPerFrame: number;
  private onLoad: (req: TileRequest, texture: THREE.Texture) => void;
  private onError: (req: TileRequest, error: Error) => void;
  private disposed = false;

  constructor(options: TileRequestQueueOptions) {
    this.urlTemplate = options.urlTemplate;
    this.buildUrl = options.buildUrl;
    this.subdomains = options.subdomains?.length ? options.subdomains : DEFAULT_TILE_SUBDOMAINS;
    this.requestGroup = options.requestGroup;
    this.maximumRequestsPerServer = options.maximumRequestsPerServer;
    this.failureCooldownMs = options.failureCooldownMs ?? 0;
    this.maxConcurrent = options.maxConcurrent ?? 50;
    this.maxQueueSize = options.maxQueueSize ?? 256;
    this.maxRequestsPerFrame = options.maxRequestsPerFrame ?? 4;
    this.onLoad = options.onLoad;
    this.onError = options.onError ?? (() => {});
  }

  /** 当前正在加载的数量 */
  get activeCount(): number {
    return this.loading.size;
  }

  /** 等待队列中的数量 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 指定瓦片是否正在加载中 */
  isLoading(key: string): boolean {
    return this.loading.has(key);
  }

  /** 指定瓦片是否在等待队列中 */
  isQueued(key: string): boolean {
    return this.pending.some((r) => r.key === key);
  }

  /** 指定瓦片是否正在加载或排队中（尚未完成） */
  isInFlight(key: string): boolean {
    return this.loading.has(key) || this.pending.some((r) => r.key === key);
  }

  /**
   * 入队或更新优先级（每帧对可见瓦片调用）
   * 如果瓦片已在队列中，仅更新priority；如果已在加载/已完成，忽略
   */
  enqueue(key: string, x: number, y: number, zoom: number, priority: number) {
    if (this.disposed) return;
    const failedAt = this.failedAt.get(key);
    if (failedAt !== undefined && performance.now() - failedAt < this.failureCooldownMs) return;
    // 已在加载中，不重复入队
    if (this.loading.has(key)) return;

    const existing = this.pending.find((r) => r.key === key);
    if (existing) {
      // 更新优先级（相机移动后距离可能变化）
      existing.priority = priority;
      return;
    }

    // 队列满时丢弃优先级最低的
    if (this.pending.length >= this.maxQueueSize) {
      // 找到优先级最低（priority最大）的请求
      let worstIdx = 0;
      for (let i = 1; i < this.pending.length; i++) {
        if (this.pending[i].priority > this.pending[worstIdx].priority) {
          worstIdx = i;
        }
      }
      if (priority >= this.pending[worstIdx].priority) return; // 新请求优先级更低，丢弃
      this.pending.splice(worstIdx, 1); // 踢掉最差的
    }

    this.pending.push({
      key,
      x,
      y,
      zoom,
      priority,
      state: TileLoadState.PENDING,
      abortController: null,
    });
  }

  /**
   * 取消指定瓦片的pending请求
   */
  cancel(key: string) {
    const idx = this.pending.findIndex((r) => r.key === key);
    if (idx !== -1) {
      this.pending.splice(idx, 1);
      return;
    }
    // 如果正在加载，abort
    const active = this.loading.get(key);
    if (active) {
      active.abortController?.abort();
      this.loading.delete(key);
    }
  }

  /**
   * 取消所有不在visibleKeys中的请求（pending + loading）
   * 每帧调用，清理离开视口的瓦片
   */
  cancelExcept(visibleKeys: Set<string>) {
    // 清理pending
    this.pending = this.pending.filter((r) => visibleKeys.has(r.key));

    // Let active image requests finish. Aborting and immediately re-creating
    // Image objects while the camera moves can exhaust browser resources;
    // completed tiles are cached and stale meshes are removed on the next view update.
  }

  cancelAll() {
    this.pending.length = 0;
    for (const [, req] of this.loading) req.abortController?.abort();
    this.loading.clear();
  }

  /**
   * 每帧调用：按优先级排序，启动新请求直到达到并发上限
   */
  processQueue() {
    if (this.disposed) return;

    // 按priority升序排列（距离近的排前面）
    this.pending.sort((a, b) => a.priority - b.priority);

    let startedThisFrame = 0;
    while (
      this.pending.length > 0 &&
      this.loading.size < this.maxConcurrent &&
      startedThisFrame < this.maxRequestsPerFrame
    ) {
      const req = this.pending.shift()!;
      this.startLoad(req);
      startedThisFrame++;
    }
  }

  /**
   * 发起单个瓦片的网络请求
   */
  private startLoad(req: TileRequest) {
    req.state = TileLoadState.LOADING;
    const ac = new AbortController();
    req.abortController = ac;
    this.loading.set(req.key, req);

    const template = this.buildUrl ? this.buildUrl(req) : (this.urlTemplate ?? "");
    const url = replaceTileTemplate(template, req.x, req.y, req.zoom, this.subdomains);

    this.fetchImage(url, ac.signal, req.priority)
      .then((texture) => {
        // 加载完成后检查是否已被取消
        if (!this.loading.has(req.key)) {
          texture.dispose();
          return;
        }
        this.loading.delete(req.key);
        req.state = TileLoadState.LOADED;
        req.abortController = null;
        this.failedAt.delete(req.key);
        this.onLoad(req, texture);
      })
      .catch((err: Error) => {
        if (!this.loading.has(req.key)) return; // 已取消，忽略
        this.loading.delete(req.key);
        req.state = TileLoadState.FAILED;
        req.abortController = null;
        if (this.failureCooldownMs > 0) this.failedAt.set(req.key, performance.now());
        this.onError(req, err);
      });
  }

  /**
   * 使用Image元素加载瓦片图片（兼容性好，支持AbortController取消）
   * 与THREE.TextureLoader内部机制一致，避免fetch对CORS的额外限制
   */
  private fetchImage(url: string, signal: AbortSignal, priority: number): Promise<THREE.Texture> {
    return requestScheduler.schedule({
      url,
      priority,
      signal,
      requestGroup: this.requestGroup,
      maximumRequestsPerServer: this.maximumRequestsPerServer,
      load: () =>
        new Promise<THREE.Texture>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }

          const img = new Image();
          img.crossOrigin = "anonymous";

          const onAbort = () => {
            img.src = "";
            reject(new Error("aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });

          img.onload = () => {
            signal.removeEventListener("abort", onAbort);
            const texture = new THREE.Texture(img);
            texture.needsUpdate = true;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = 4;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = true;
            resolve(texture);
          };

          img.onerror = () => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error(`Failed to load: ${url}`));
          };

          img.src = url;
        }),
    });
  }

  /**
   * 销毁队列，取消所有请求
   */
  dispose() {
    this.disposed = true;
    this.pending.length = 0;
    for (const [, req] of this.loading) {
      req.abortController?.abort();
    }
    this.loading.clear();
    this.failedAt.clear();
  }
}

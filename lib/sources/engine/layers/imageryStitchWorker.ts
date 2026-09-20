/**
 * 影像拼接 Worker（OffscreenCanvas）
 *
 * 把"多块影像子块 drawImage 拼到大画布 + 父级缓存补绘 + 竖直翻转 +
 * 导出 ImageBitmap"的像素密集型工作从主线程移到 Worker，配合
 * THREE.ImageBitmapTexture 让主线程彻底零 drawImage、零画布创建。
 *
 * 实现说明（与 terrainMeshWorker 相同的模式）：
 * - Worker 通过 Blob URL 创建（经典 Worker），不依赖打包器的 worker 加载
 *   特性，任何打包配置（webpack / turbopack / 静态导出）下均可工作。
 * - 源 ImageBitmap 通过结构化克隆传入（不 transfer）——imgCache 中的
 *   位图是跨任务复用的（父级补绘、相邻瓦片共享），转移会使其失效。
 * - 输出 ImageBitmap 以 Transferable 返回，零拷贝。
 * - 竖直翻转入画布：WebGL 对 ImageBitmap 源忽略 UNPACK_FLIP_Y_WEBGL，
 *   方向必须在位图内烘焙好（等价于旧 CanvasTexture 的 flipY=true），
 *   主线程侧纹理使用 flipY=false。
 * - Worker 不可用时（Node 诊断环境 / 极少数 CSP 限制）available === false，
 *   调用方回退到主线程同步拼接路径。
 */

/** 拼接任务参数（img 为 imgCache 中的 ImageBitmap，结构化克隆传入） */
export interface ImageryStitchParams {
  canvasW: number;
  canvasH: number;
  /** 画布西北角的像素坐标（imageryZoom 层级的全局像素空间） */
  pxWest: number;
  pxNorth: number;
  /** 影像层级（用于父级回溯） */
  imageryZoom: number;
  /** 单块影像子块的边长（像素，通常 256） */
  tilePx: number;
  /** 已就绪的子块绘制操作 */
  ops: { img: ImageBitmap; tx: number; ty: number }[];
  /** 父级补绘可用的祖先瓦片（imageryZoom-1 .. imageryZoom-4 中缓存命中的） */
  ancestors: { key: string; img: ImageBitmap }[];
}

export interface ImageryStitchResult {
  /** 竖直方向已烘焙翻转的合成结果，可直接交给 THREE.ImageBitmapTexture */
  bitmap: ImageBitmap;
  /** 实际绘制的子块数（0 表示全部失败，调用方应保持兜底可见并拒绝） */
  drawnImageCount: number;
}

/**
 * Worker 主体。
 *
 * 注意：本函数会被 `toString()` 序列化为 Worker 脚本源码，因此必须完全
 * 自包含——不能引用任何闭包外的标识符或 import。
 * 导出仅用于测试（在支持 OffscreenCanvas 的 Node 环境中直接驱动）。
 */
export function imageryStitchWorkerMain(ctx: {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}): void {
  type StitchParams = ImageryStitchParams;

  ctx.onmessage = (event: { data: unknown }) => {
    const msg = event.data as { id: number; params?: StitchParams };
    if (!msg.params) return;
    const p = msg.params;
    try {
      if (typeof OffscreenCanvas === "undefined") {
        throw new Error("OffscreenCanvas is unavailable in worker.");
      }
      const canvas = new OffscreenCanvas(p.canvasW, p.canvasH);
      const ctx2d = canvas.getContext("2d")!;
      const drawnSlots = new Set<string>();
      let drawnImageCount = 0;

      // 用缓存中的父级瓦片放大补绘失败的子块（与主线程旧路径一致），
      // 避免零星 404/限流在画布上留下透明洞。
      const ancestorMap = new Map<string, ImageBitmap>();
      for (const a of p.ancestors) ancestorMap.set(a.key, a.img);

      const fillFromAncestors = (tx: number, ty: number): boolean => {
        for (let az = p.imageryZoom - 1; az >= Math.max(0, p.imageryZoom - 4); az--) {
          const scale = Math.pow(2, p.imageryZoom - az);
          const ax = Math.floor(tx / scale);
          const ay = Math.floor(ty / scale);
          const ancestor = ancestorMap.get(`${az}/${ax}/${ay}`);
          if (!ancestor) continue;
          const sw = p.tilePx / scale;
          const sx = ((tx - ax * scale) * p.tilePx) / scale;
          const sy = ((ty - ay * scale) * p.tilePx) / scale;
          ctx2d.drawImage(
            ancestor,
            sx,
            sy,
            sw,
            sw,
            tx * p.tilePx - p.pxWest,
            ty * p.tilePx - p.pxNorth,
            p.tilePx,
            p.tilePx,
          );
          drawnSlots.add(`${tx}/${ty}`);
          drawnImageCount++;
          return true;
        }
        return false;
      };

      for (const op of p.ops) {
        if (!op.img) continue;
        ctx2d.drawImage(
          op.img,
          op.tx * p.tilePx - p.pxWest,
          op.ty * p.tilePx - p.pxNorth,
          p.tilePx,
          p.tilePx,
        );
        drawnSlots.add(`${op.tx}/${op.ty}`);
        drawnImageCount++;
      }
      // 失败/被剪裁的子块尽量用父级缓存补绘（无网络请求），
      // 让画布尽量不透明，避免透出下层灰色兜底网格
      const fullXMin = Math.floor(p.pxWest / p.tilePx);
      const fullXMax = Math.floor((p.pxWest + p.canvasW - 0.001) / p.tilePx);
      const fullYMin = Math.floor(p.pxNorth / p.tilePx);
      const fullYMax = Math.floor((p.pxNorth + p.canvasH - 0.001) / p.tilePx);
      for (let tx = fullXMin; tx <= fullXMax; tx++) {
        for (let ty = fullYMin; ty <= fullYMax; ty++) {
          if (drawnSlots.has(`${tx}/${ty}`)) continue;
          fillFromAncestors(tx, ty);
        }
      }

      if (drawnImageCount === 0) {
        ctx.postMessage({ id: msg.id, ok: false, error: "No imagery tiles loaded.", drawnImageCount: 0 });
        return;
      }

      // 竖直翻转入第二块画布后导出 ImageBitmap：
      // WebGL 对 ImageBitmap 源忽略 UNPACK_FLIP_Y_WEBGL，翻转必须在
      // 位图内烘焙（等价旧 CanvasTexture 的 flipY=true）。
      const flipped = new OffscreenCanvas(p.canvasW, p.canvasH);
      const fctx = flipped.getContext("2d")!;
      fctx.setTransform(1, 0, 0, -1, 0, p.canvasH);
      fctx.drawImage(canvas, 0, 0);
      const bitmap = flipped.transferToImageBitmap();
      ctx.postMessage({ id: msg.id, ok: true, result: { bitmap, drawnImageCount } }, [bitmap]);
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
  resolve: (result: ImageryStitchResult) => void;
  reject: (error: Error) => void;
}

/**
 * 影像拼接 Worker 池。Worker / OffscreenCanvas 不可用时
 * `available === false`，调用方回退到主线程同步拼接。
 */
export class ImageryStitchPool {
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
    if (typeof OffscreenCanvas === "undefined") return;

    let url: string;
    try {
      const source = `(${imageryStitchWorkerMain.toString()})(self);`;
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
        result?: ImageryStitchResult;
        error?: string;
      };
      const job = this.pending.get(msg.id);
      if (!job) return; // 已被取消
      this.pending.delete(msg.id);
      if (msg.ok && msg.result) {
        job.resolve(msg.result);
      } else {
        job.reject(new Error(msg.error || "Imagery stitch worker failed."));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      for (const [id, job] of this.pending) {
        job.reject(new Error(event.message || "Imagery stitch worker crashed."));
        this.pending.delete(id);
      }
    };
    return worker;
  }

  /**
   * 拼接一块瓦片画布。ops / ancestors 中的 ImageBitmap 会被结构化克隆
   * （不 transfer，源位图仍留在 imgCache 中跨任务复用）。
   */
  stitch(params: ImageryStitchParams): Promise<ImageryStitchResult> {
    if (!this.available || this.workers.length === 0) {
      return Promise.reject(new Error("Imagery stitch pool is unavailable."));
    }
    const id = this.nextId++;
    const worker = this.workers[this.roundRobin++ % this.workers.length];
    return new Promise<ImageryStitchResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, params });
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
      job.reject(new Error("Imagery stitch pool disposed."));
    }
    this.pending.clear();
  }
}

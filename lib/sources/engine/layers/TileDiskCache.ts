/**
 * 基于 IndexedDB 的瓦片二进制缓存（跨刷新 / 跨会话持久化）。
 *
 * 为什么需要它：
 * 浏览器 HTTP 缓存只在“同一次会话 + 缓存未被挤出”时有效，而瓦片是
 * 天然不可变的大批量小文件——换个区域再回来、刷新页面、重新打开应用，
 * 都会重新走一遍网络往返。把瓦片字节落到 IndexedDB 后，第二次访问
 * 同一区域基本是零网络。
 *
 * 设计要点：
 * - 按命名空间分库（地形服务 / 每个影像服务各一个库），便于整体清理；
 * - meta store 单独记录字节数与最后访问时间，淘汰时不必读取 blob 本体；
 * - 有总字节预算，超限按 LRU 批量淘汰（默认清到 80%，配额报错时清到 50%）；
 * - 任何异常（隐私模式、无 IndexedDB、写配额被拒）都自动降级为“不缓存”，
 *   调用方无需处理，拿到的就是 null / 静默忽略。
 */

const BLOB_STORE = "blobs";
const META_STORE = "meta";
const DB_VERSION = 1;
/** 单个文件超过 maxBytes / 该系数就不缓存，避免个别大对象挤占配额。 */
const SINGLE_ENTRY_DIVISOR = 8;
const MIN_SINGLE_ENTRY_BYTES = 64 * 1024;

interface TileMetaRecord {
  key: string;
  bytes: number;
  lastAccess: number;
}

interface TileEntryInfo {
  bytes: number;
  lastAccess: number;
}

export interface TileDiskCacheStats {
  namespace: string;
  count: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  disabled: boolean;
}

const instances = new Map<string, TileDiskCache>();

/**
 * 获取（或创建）某个命名空间的共享缓存实例。
 * 同一命名空间在多个图层间共享，避免重复打开数据库。
 */
export function getTileDiskCache(namespace: string, maxBytes: number): TileDiskCache | null {
  if (maxBytes <= 0 || typeof indexedDB === "undefined") return null;
  const existing = instances.get(namespace);
  if (existing) {
    existing.raiseBudget(maxBytes);
    return existing;
  }
  const created = new TileDiskCache(namespace, maxBytes);
  instances.set(namespace, created);
  return created;
}

/** 清空所有已创建的瓦片缓存（例如“清理离线数据”入口）。 */
export async function clearAllTileDiskCaches(): Promise<void> {
  await Promise.all([...instances.values()].map((cache) => cache.clear()));
}

export class TileDiskCache {
  private readonly namespace: string;
  private maxBytes: number;
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;
  private indexReady: Promise<void> | null = null;
  private disabled = false;
  private writeFailures = 0;

  /** key → 字节数 / 最后访问时间（内存镜像，淘汰判定用） */
  private entries = new Map<string, TileEntryInfo>();
  private totalBytes = 0;

  private writeChain: Promise<void> = Promise.resolve();
  private trimming = false;
  private trimRequested = false;
  private trimAggressive = false;

  private hits = 0;
  private misses = 0;

  constructor(namespace: string, maxBytes: number) {
    this.namespace = namespace;
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  public getStats(): TileDiskCacheStats {
    return {
      namespace: this.namespace,
      count: this.entries.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      disabled: this.disabled,
    };
  }

  public raiseBudget(maxBytes: number): void {
    if (maxBytes > this.maxBytes) {
      this.maxBytes = maxBytes;
      this.requestTrim(false);
    }
  }

  /** 读取缓存；未命中返回 null。 */
  public async get(key: string): Promise<Blob | null> {
    if (this.disabled) return null;
    await this.ensureIndex();
    const db = this.db;
    if (!db) return null;

    const blob = await new Promise<Blob | null>((resolve) => {
      try {
        const tx = db.transaction(BLOB_STORE, "readonly");
        const request = tx.objectStore(BLOB_STORE).get(key);
        request.onsuccess = () => resolve((request.result as Blob | undefined) ?? null);
        request.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });

    if (!blob) {
      this.misses++;
      return null;
    }
    this.hits++;
    const info = this.entries.get(key);
    if (info) {
      info.lastAccess = Date.now();
      this.touchMeta(key, info.lastAccess);
    }
    return blob;
  }

  /** 写入缓存（fire-and-forget，串行化以保持字节统计准确）。 */
  public put(key: string, blob: Blob): void {
    if (this.disabled || !blob || blob.size === 0) return;
    const singleLimit = Math.max(MIN_SINGLE_ENTRY_BYTES, Math.floor(this.maxBytes / SINGLE_ENTRY_DIVISOR));
    if (blob.size > singleLimit) return;
    this.writeChain = this.writeChain.then(() => this.writeEntry(key, blob)).catch(() => undefined);
  }

  /** 删除单条（例如发现缓存内容损坏）。 */
  public async delete(key: string): Promise<void> {
    await this.ensureIndex();
    const db = this.db;
    if (!db) return;
    const ok = await this.deleteMany(db, [key]);
    if (ok) {
      const info = this.entries.get(key);
      if (info) {
        this.totalBytes -= info.bytes;
        this.entries.delete(key);
      }
    }
  }

  public async clear(): Promise<void> {
    await this.ensureIndex();
    const db = this.db;
    if (!db) return;
    await this.deleteMany(db, [...this.entries.keys()]);
    this.entries.clear();
    this.totalBytes = 0;
  }

  // ─── 内部实现 ───────────────────────────────────────────────

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return Promise.resolve(this.db);
    if (this.disabled) return Promise.resolve(null);
    if (this.opening) return this.opening;

    this.opening = new Promise<IDBDatabase | null>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(`wb-tiles:${this.namespace}`, DB_VERSION);
      } catch {
        this.disabled = true;
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          // blob 本体用外部键（key 作为主键），meta 单独存，避免淘汰时读取大对象
          db.createObjectStore(BLOB_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onclose = () => {
          this.db = null;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        this.disabled = true;
        resolve(null);
      };
      // 其它标签页正在升级数据库：本次放弃缓存，不影响渲染
      request.onblocked = () => resolve(null);
    });
    return this.opening;
  }

  private ensureIndex(): Promise<void> {
    if (this.indexReady) return this.indexReady;
    this.indexReady = (async () => {
      const db = await this.open();
      if (!db) return;
      const records = await new Promise<TileMetaRecord[]>((resolve) => {
        try {
          const tx = db.transaction(META_STORE, "readonly");
          const request = tx.objectStore(META_STORE).getAll();
          request.onsuccess = () => resolve((request.result as TileMetaRecord[] | undefined) ?? []);
          request.onerror = () => resolve([]);
          tx.onabort = () => resolve([]);
        } catch {
          resolve([]);
        }
      });
      for (const record of records) {
        if (!record || typeof record.key !== "string" || !Number.isFinite(record.bytes)) continue;
        this.entries.set(record.key, {
          bytes: record.bytes,
          lastAccess: Number.isFinite(record.lastAccess) ? record.lastAccess : 0,
        });
        this.totalBytes += record.bytes;
      }
      if (this.totalBytes > this.maxBytes) this.requestTrim(false);
    })();
    return this.indexReady;
  }

  private async writeEntry(key: string, blob: Blob): Promise<void> {
    await this.ensureIndex();
    const db = this.db;
    if (!db || this.disabled) return;

    const now = Date.now();
    const previous = this.entries.get(key)?.bytes ?? 0;
    const ok = await this.runTransaction(db, "readwrite", (tx) => {
      tx.objectStore(BLOB_STORE).put(blob, key);
      tx.objectStore(META_STORE).put({ key, bytes: blob.size, lastAccess: now } satisfies TileMetaRecord);
    });

    if (!ok) {
      this.writeFailures++;
      // 配额被拒（隐私模式 / 磁盘满）：激进淘汰后还能试着继续，连续失败就彻底停用
      if (this.writeFailures >= 3) {
        this.disabled = true;
        return;
      }
      this.requestTrim(true);
      return;
    }

    this.entries.set(key, { bytes: blob.size, lastAccess: now });
    this.totalBytes += blob.size - previous;
    this.writeFailures = 0;
    if (this.totalBytes > this.maxBytes) this.requestTrim(false);
  }

  private touchMeta(key: string, lastAccess: number): void {
    const db = this.db;
    if (!db) return;
    const info = this.entries.get(key);
    if (!info) return;
    this.writeChain = this.writeChain
      .then(() =>
        this.runTransaction(db, "readwrite", (tx) => {
          tx.objectStore(META_STORE).put({
            key,
            bytes: info.bytes,
            lastAccess,
          } satisfies TileMetaRecord);
        }),
      )
      .then(
        () => undefined,
        () => undefined,
      );
  }

  private requestTrim(aggressive: boolean): void {
    this.trimRequested = true;
    this.trimAggressive = this.trimAggressive || aggressive;
    if (this.trimming) return;
    this.trimming = true;
    void this.trim().finally(() => {
      this.trimming = false;
      if (this.trimRequested) this.requestTrim(false);
    });
  }

  private async trim(): Promise<void> {
    if (!this.trimRequested) return;
    const aggressive = this.trimAggressive;
    this.trimRequested = false;
    this.trimAggressive = false;

    const db = this.db;
    if (!db) return;
    const target = Math.floor(this.maxBytes * (aggressive ? 0.5 : 0.8));
    if (this.totalBytes <= target) return;

    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const doomed: string[] = [];
    let freed = 0;
    for (const [key, info] of sorted) {
      if (this.totalBytes - freed <= target) break;
      doomed.push(key);
      freed += info.bytes;
    }
    if (doomed.length === 0) return;

    const ok = await this.deleteMany(db, doomed);
    if (!ok) return;
    for (const key of doomed) {
      const info = this.entries.get(key);
      if (!info) continue;
      this.totalBytes -= info.bytes;
      this.entries.delete(key);
    }
  }

  private deleteMany(db: IDBDatabase, keys: string[]): Promise<boolean> {
    if (keys.length === 0) return Promise.resolve(true);
    return this.runTransaction(db, "readwrite", (tx) => {
      const blobs = tx.objectStore(BLOB_STORE);
      const meta = tx.objectStore(META_STORE);
      for (const key of keys) {
        blobs.delete(key);
        meta.delete(key);
      }
    });
  }

  private runTransaction(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    body: (tx: IDBTransaction) => void,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction([BLOB_STORE, META_STORE], mode);
        body(tx);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }
}

export interface RequestSchedulerOptions {
  /** Maximum number of active requests across all servers. */
  maximumRequests?: number;
  /** Maximum number of active requests for a single server origin. */
  maximumRequestsPerServer?: number;
}

export interface ScheduledRequestOptions<T> {
  url: string;
  /** Lower values are scheduled first. */
  priority: number;
  signal?: AbortSignal;
  /** Keep the request under the per-server limit. Defaults to true. */
  throttleByServer?: boolean;
  load: (signal?: AbortSignal) => Promise<T>;
}

interface ScheduledTask {
  id: number;
  serverKey: string;
  priority: number;
  signal?: AbortSignal;
  throttleByServer: boolean;
  started: boolean;
  cancelled: boolean;
  run: () => void;
  cancelQueued: () => void;
}

function createAbortError(): Error {
  return new DOMException("The request was aborted.", "AbortError");
}

export function getRequestServerKey(url: string): string {
  try {
    const base = typeof window !== "undefined" ? window.location.href : undefined;
    const parsed = new URL(url, base);
    return parsed.origin === "null" ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}

/**
 * Shared request scheduler modeled after Cesium's RequestScheduler.
 *
 * The browser controls the actual transport queue. This scheduler prevents the
 * application from filling that queue with a burst that can starve visible
 * terrain and imagery tiles. Limits are shared by every layer using the
 * exported requestScheduler instance.
 */
export class RequestScheduler {
  private pending: ScheduledTask[] = [];
  private activeByServer = new Map<string, number>();
  private activeRequests = 0;
  private nextTaskId = 0;
  private pumpScheduled = false;
  private maximumRequests: number;
  private maximumRequestsPerServer: number;

  constructor(options: RequestSchedulerOptions = {}) {
    this.maximumRequests = options.maximumRequests ?? 50;
    this.maximumRequestsPerServer = options.maximumRequestsPerServer ?? 6;
    if (!Number.isInteger(this.maximumRequests) || this.maximumRequests < 1) {
      throw new RangeError("maximumRequests must be an integer greater than 0.");
    }
    if (!Number.isInteger(this.maximumRequestsPerServer) || this.maximumRequestsPerServer < 1) {
      throw new RangeError("maximumRequestsPerServer must be an integer greater than 0.");
    }
  }

  get activeRequestCount(): number {
    return this.activeRequests;
  }

  get pendingRequestCount(): number {
    return this.pending.length;
  }

  getActiveRequestCountFor(url: string): number {
    return this.activeByServer.get(getRequestServerKey(url)) ?? 0;
  }

  schedule<T>(options: ScheduledRequestOptions<T>): Promise<T> {
    const serverKey = getRequestServerKey(options.url);
    const throttleByServer = options.throttleByServer !== false;

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        options.signal?.removeEventListener("abort", onAbort);
      };

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
      };

      const release = () => {
        cleanup();
        this.activeRequests--;
        if (throttleByServer) {
          const nextCount = (this.activeByServer.get(serverKey) ?? 1) - 1;
          if (nextCount <= 0) this.activeByServer.delete(serverKey);
          else this.activeByServer.set(serverKey, nextCount);
        }
        this.schedulePump();
      };

      const task: ScheduledTask = {
        id: this.nextTaskId++,
        serverKey,
        priority: options.priority,
        signal: options.signal,
        throttleByServer,
        started: false,
        cancelled: false,
        run: () => {
          if (task.cancelled) return;
          task.started = true;
          this.activeRequests++;
          if (throttleByServer) {
            this.activeByServer.set(serverKey, (this.activeByServer.get(serverKey) ?? 0) + 1);
          }

          let request: Promise<T>;
          try {
            request = options.load(options.signal);
          } catch (error: unknown) {
            settle(() => reject(error));
            release();
            return;
          }

          void request
            .then(
              (value) => settle(() => resolve(value)),
              (error: unknown) => settle(() => reject(error)),
            )
            .finally(release);
        },
        cancelQueued: () => {
          if (task.started || task.cancelled) return;
          task.cancelled = true;
          const index = this.pending.indexOf(task);
          if (index !== -1) this.pending.splice(index, 1);
          cleanup();
          settle(() => reject(createAbortError()));
        },
      };

      const onAbort = () => task.cancelQueued();
      if (options.signal?.aborted) {
        settle(() => reject(createAbortError()));
        return;
      }

      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(task);
      this.schedulePump();
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.activeRequests >= this.maximumRequests) return;
    this.pending.sort((a, b) => a.priority - b.priority || a.id - b.id);

    let index = 0;
    while (index < this.pending.length && this.activeRequests < this.maximumRequests) {
      const task = this.pending[index];
      const serverCount = task.throttleByServer
        ? (this.activeByServer.get(task.serverKey) ?? 0)
        : 0;
      const serverHasCapacity =
        !task.throttleByServer || serverCount < this.maximumRequestsPerServer;

      if (!serverHasCapacity) {
        index++;
        continue;
      }

      this.pending.splice(index, 1);
      task.run();
    }
  }
}

export const requestScheduler = new RequestScheduler();

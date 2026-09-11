type DrawTask = () => Promise<void>;
type StateListener = (isRunning: boolean) => void;

export class DrawingManager {
  private taskQueue: DrawTask[] = [];
  private isRunning = false;
  private abortController?: AbortController;
  // 状态变更监听器列表
  private stateListeners: Set<StateListener> = new Set();

  /** 订阅绘制状态变更，返回取消订阅函数 */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // 立即推送当前状态
    listener(this.isRunning);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private emitState() {
    this.stateListeners.forEach((fn) => fn(this.isRunning));
  }

  addTask(task: DrawTask): Promise<void> {
    return new Promise((resolve, reject) => {
      const wrappedTask = async () => {
        try {
          await task();
          resolve();
        } catch (err) {
          reject(err);
        }
      };
      this.taskQueue.push(wrappedTask);
      this.runQueue();
    });
  }

  private async runQueue() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emitState();

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift()!;
      try {
        await task();
      } catch (e) {
        console.error("绘制任务执行失败:", e);
      }
    }

    this.isRunning = false;
    this.emitState();
  }

  clearQueue() {
    this.taskQueue = [];
  }

  get isDrawing() {
    return this.isRunning;
  }

  startFreeDraw(onLoop: () => Promise<void>) {
    this.abortController = new AbortController();
    const loop = async () => {
      while (!this.abortController?.signal.aborted) {
        await onLoop();
      }
    };
    loop().catch(console.error);
  }

  stopFreeDraw() {
    this.abortController?.abort();
  }
}

export const drawingManager = new DrawingManager();

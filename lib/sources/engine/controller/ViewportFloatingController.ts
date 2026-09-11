type Placement = "top" | "bottom" | "left" | "right";
interface FloatingOptions {
  /** 锚点元素 */
  anchor: HTMLElement;
  /** 悬浮浮层容器 */
  floatEl: HTMLElement;
  /** 初始优先方向 */
  placement: Placement;
  /** 浮层与锚点间距 */
  gap?: number;
  /** 视口安全缓冲边距（防止贴屏幕边缘） */
  viewportPadding?: number;
  /** 防抖延迟 ms */
  debounceDelay?: number;
  /** 是否自动监听滚动/resize */
  autoListen?: boolean;
  /** 浮层最大zIndex */
  maxZIndex?: number;
  /** 位置切换回调 */
  onPlacementChange?: (newPlacement: Placement) => void;
}

class ViewportFloatingController {
  private anchor: HTMLElement;
  private floatEl: HTMLElement;
  private gap: number;
  private viewportPadding: number;
  private debounceDelay: number;
  private maxZIndex: number;
  private originPlacement: Placement;
  private currentPlacement: Placement;
  private onPlacementChange?: (p: Placement) => void;

  private debounceTimer: number | null = null;
  private scrollHandler: () => void;
  private resizeHandler: () => void;
  private originZIndex: string | null = null;
  private isShow = false;

  constructor(options: FloatingOptions) {
    const {
      anchor,
      floatEl,
      placement,
      gap = 8,
      viewportPadding = 16,
      debounceDelay = 80,
      autoListen = true,
      maxZIndex = 9999,
      onPlacementChange,
    } = options;

    this.anchor = anchor;
    this.floatEl = floatEl;
    this.originPlacement = placement;
    this.currentPlacement = placement;
    this.gap = gap;
    this.viewportPadding = viewportPadding;
    this.debounceDelay = debounceDelay;
    this.maxZIndex = maxZIndex;
    this.onPlacementChange = onPlacementChange;

    // 绑定防抖处理函数
    this.scrollHandler = this.debounce(() => this.updatePosition());
    this.resizeHandler = this.debounce(() => this.updatePosition());

    if (autoListen) {
      this.bindEvent();
    }
  }

  /** 防抖封装 */
  private debounce<T extends (...args: never[]) => void>(fn: T) {
    return (...args: Parameters<T>) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => {
        fn.apply(this, args);
      }, this.debounceDelay);
    };
  }

  /** 绑定全局滚动、窗口大小事件 */
  bindEvent() {
    window.addEventListener("scroll", this.scrollHandler, true);
    window.addEventListener("resize", this.resizeHandler);
  }

  /** 解除事件监听 */
  unbindEvent() {
    window.removeEventListener("scroll", this.scrollHandler, true);
    window.removeEventListener("resize", this.resizeHandler);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 显示浮层，提升层级 */
  show() {
    if (this.isShow) return;
    this.isShow = true;
    this.originZIndex = this.floatEl.style.zIndex;
    this.floatEl.style.zIndex = String(this.maxZIndex);
    this.floatEl.style.display = "";
    this.updatePosition();
  }

  /** 隐藏浮层，还原层级 */
  hide() {
    if (!this.isShow) return;
    this.isShow = false;
    this.floatEl.style.display = "none";
    if (this.originZIndex !== null) {
      this.floatEl.style.zIndex = this.originZIndex;
    }
  }

  /** 切换显示状态 */
  toggle() {
    if (this.isShow) this.hide();
    else this.show();
  }

  /** 核心：重新计算位置 + 自动切换方向 */
  updatePosition() {
    if (!this.isShow) return;

    const anchorRect = this.anchor.getBoundingClientRect();
    const floatRect = this.floatEl.getBoundingClientRect();
    const floatW = floatRect.width;
    const floatH = floatRect.height;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const pad = this.viewportPadding;
    const gap = this.gap;

    let targetPlacement: Placement = this.originPlacement;

    // 边界检测，判断原方向空间是否足够，不足切换反向
    switch (this.originPlacement) {
      case "bottom": {
        const needBottom = anchorRect.bottom + gap + floatH;
        const availableBottom = vpH - pad;
        const availableTop = anchorRect.top - gap - pad;
        if (needBottom > availableBottom && availableTop > floatH) {
          targetPlacement = "top";
        }
        break;
      }
      case "top": {
        const needTop = anchorRect.top - gap - floatH;
        const availableTop = pad;
        const availableBottom = vpH - anchorRect.bottom - gap - pad;
        if (needTop < availableTop && availableBottom > floatH) {
          targetPlacement = "bottom";
        }
        break;
      }
      case "right": {
        const needRight = anchorRect.right + gap + floatW;
        const availableRight = vpW - pad;
        const availableLeft = anchorRect.left - gap - pad;
        if (needRight > availableRight && availableLeft > floatW) {
          targetPlacement = "left";
        }
        break;
      }
      case "left": {
        const needLeft = anchorRect.left - gap - floatW;
        const availableLeft = pad;
        const availableRight = vpW - anchorRect.right - gap - pad;
        if (needLeft < availableLeft && availableRight > floatW) {
          targetPlacement = "right";
        }
        break;
      }
    }

    // 方向发生变化触发回调
    if (targetPlacement !== this.currentPlacement) {
      this.currentPlacement = targetPlacement;
      this.onPlacementChange?.(targetPlacement);
    }

    // 计算坐标
    let left = 0;
    let top = 0;
    const rect = anchorRect;

    switch (this.currentPlacement) {
      case "bottom":
        left = rect.left + rect.width / 2 - floatW / 2;
        top = rect.bottom + gap;
        break;
      case "top":
        left = rect.left + rect.width / 2 - floatW / 2;
        top = rect.top - gap - floatH;
        break;
      case "right":
        left = rect.right + gap;
        top = rect.top + rect.height / 2 - floatH / 2;
        break;
      case "left":
        left = rect.left - gap - floatW;
        top = rect.top + rect.height / 2 - floatH / 2;
        break;
    }

    // 水平方向二次边界修正（居中后左右越界）
    left = Math.max(pad, Math.min(left, vpW - floatW - pad));
    // 垂直方向二次边界修正
    top = Math.max(pad, Math.min(top, vpH - floatH - pad));

    // 应用样式，浮层必须 fixed 定位
    Object.assign(this.floatEl.style, {
      position: "fixed",
      left: `${left}px`,
      top: `${top}px`,
    });
  }

  /** 销毁实例，释放事件、还原样式 */
  destroy() {
    this.unbindEvent();
    this.hide();
  }
}

export default ViewportFloatingController;

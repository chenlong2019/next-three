import * as THREE from "three";
import { HELPER_LAYER } from "../globleValue";

/**
 * 绘制模式枚举
 */
export enum DrawMode {
  /** 无绘制操作，空闲状态 */
  NONE,
  /** 单点标记 */
  POINT,
  /** 闭合多边形 */
  POLYGON,
  /** 开放折线 */
  POLYLINE,
}

/**
 * 绘制完成后输出实体数据结构
 */
export type DrawEntity = {
  /** 实体唯一ID */
  id: string;
  /** 实体业务类型标识 */
  type: string;
  /** 顶点世界坐标数组 */
  positions: { x: number; y: number; z: number }[];
  /** 实体自定义扩展属性 */
  props: Record<string, unknown>;
};

/**
 * 三维场景交互式绘制管理器
 * @remarks
 * 支持：单点标记 / 折线 / 闭合多边形绘制
 * 交互规则：
 * 1. 左键点击添加顶点
 * 2. 鼠标移动实时预览线条
 * 3. 双击结束当前图形
 * 4. 拾取时自动忽略 HELPER_LAYER 辅助对象
 * 坐标系：Z轴向上
 */
export class DrawingManager {
  /** @internal 当前绘制模式 */
  private mode = DrawMode.NONE;
  /** @internal 已拾取顶点集合 */
  private points: THREE.Vector3[] = [];
  /** @internal 动态预览线对象 */
  private previewLine: THREE.Line | null = null;
  /**
   * @internal
   * 鼠标交互状态
   * 0 = 空闲未绘制
   * 1 = 正在绘制中
   */
  private mouseState: number = 0;

  /** 鼠标标准化NDC坐标（用于射线计算） */
  public mouse: THREE.Vector2;
  /** 射线投射器，用于拾取场景交点 */
  public raycaster: THREE.Raycaster;

  /**
   * 构造绘制管理器
   * @param scene 主场景实例
   * @param camera 用于拾取的相机
   * @param dom 接收鼠标事件的Canvas容器DOM
   */
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private dom: HTMLElement,
  ) {
    this.mouse = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.bindEvent();
  }

  /**
   * @internal
   * 绑定容器鼠标指针事件
   */
  private bindEvent() {
    this.dom.addEventListener("pointerdown", (e: PointerEvent) => {
      // 仅绘制状态才响应点击
      if (this.mouseState !== 1) return;
      const point = this.getWorldPoint(e);
      if (!point) return;
      this.handleClick(point);
    });

    this.dom.addEventListener("pointermove", (e: PointerEvent) => {
      // 仅绘制状态才更新预览
      if (this.mouseState !== 1) return;
      const point = this.getWorldPoint(e);
      if (point) {
        this.updatePreview(point);
      }
    });

    this.dom.addEventListener("dblclick", () => {
      // 绘制中双击结束当前图形
      if (this.mouseState === 1) {
        this.finish();
      }
    });
  }

  /**
   * @internal
   * 根据鼠标当前坐标更新预览线条几何体
   * @param mousePoint 当前鼠标拾取世界点
   */
  private updatePreview(mousePoint: THREE.Vector3) {
    if (!this.previewLine || this.points.length === 0) return;
    const arr = [...this.points, mousePoint];
    const positions: number[] = [];
    arr.forEach((p) => {
      positions.push(p.x, p.y, p.z);
    });
    this.previewLine.geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    this.previewLine.geometry.attributes.position.needsUpdate = true;
    this.previewLine.geometry.computeBoundingSphere();
  }

  /**
   * @internal
   * 左键点击处理：新增顶点
   * @param point 拾取得到的世界坐标点
   */
  private handleClick(point: THREE.Vector3) {
    if (this.mode === DrawMode.NONE || this.mouseState !== 1) return;
    this.points.push(point.clone());
    this.updatePreview(point);
  }

  /**
   * @internal
   * 创建预览线并加入场景
   */
  private createPreview() {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.LineBasicMaterial({
      color: 0x00ffff,
    });
    this.previewLine = new THREE.Line(geometry, material);
    this.scene.add(this.previewLine);
  }

  /**
   * 移除并销毁预览线资源
   */
  public removePreview() {
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }
  }

  /**
   * 双击结束绘制，生成实体数据并停止绘制
   * @returns 绘制实体；顶点数量不足最小要求时返回 null
   */
  public finish(): DrawEntity | null {
    if (this.mouseState !== 1) return null;

    // 区分绘制类型最小顶点数量
    let minPoints = 2;
    if (this.mode === DrawMode.POLYGON) minPoints = 3;
    if (this.mode === DrawMode.POINT) minPoints = 1;

    if (this.points.length < minPoints) {
      this.stop();
      return null;
    }

    let entityType = "";
    let entityProps: Record<string, unknown> = {};
    switch (this.mode) {
      case DrawMode.POLYGON:
        entityType = "wall";
        entityProps = { depth: 5 };
        break;
      case DrawMode.POLYLINE:
        entityType = "line";
        entityProps = { width: 0.3 };
        break;
      case DrawMode.POINT:
        entityType = "marker";
        entityProps = { size: 1 };
        break;
    }

    const entity: DrawEntity = {
      id: crypto.randomUUID(),
      type: entityType,
      positions: this.points.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z,
      })),
      props: entityProps,
    };
    console.log("create entity", entity);
    this.stop();
    return entity;
  }

  /**
   * 根据鼠标指针事件进行场景拾取，获取世界坐标点
   * @param event PointerEvent
   * @returns 拾取点；只拾取非HELPER_LAYER对象，无交点返回null
   */
  getWorldPoint(event: PointerEvent): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    if (hits.length > 0) {
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].object.userData?.layer !== HELPER_LAYER) {
          return hits[i].point.clone();
        }
      }
    }
    return null;
  }

  /**
   * 启动闭合多边形绘制模式
   */
  startPolygon() {
    this.mode = DrawMode.POLYGON;
    this.mouseState = 1;
    this.points = [];
    this.removePreview();
    this.createPreview();
  }

  /**
   * 启动开放折线绘制模式
   */
  startLine() {
    this.mode = DrawMode.POLYLINE;
    this.mouseState = 1;
    this.points = [];
    this.removePreview();
    this.createPreview();
  }

  /**
   * 启动单点标记绘制模式
   */
  startPoint() {
    this.mode = DrawMode.POINT;
    this.mouseState = 1;
    this.points = [];
    this.removePreview();
    this.createPreview();
  }

  /**
   * 强制停止绘制，重置所有绘制状态并销毁预览线
   */
  stop() {
    this.mode = DrawMode.NONE;
    this.mouseState = 0;
    this.points = [];
    this.removePreview();
  }

  /**
   * 获取当前绘制模式
   * @returns DrawMode 枚举值
   */
  public getDrawMode(): DrawMode {
    return this.mode;
  }

  /**
   * 获取当前鼠标交互状态
   * @returns 0 空闲 / 1 绘制中
   */
  public getMouseState(): number {
    return this.mouseState;
  }
}

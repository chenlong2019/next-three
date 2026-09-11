import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * 航向、俯仰角结构（单位：弧度）
 * @remarks
 * Z-Up 坐标系，对齐Cesium语义
 * heading：绕Z轴水平旋转（偏航）
 * pitch：视线上下俯仰角
 * roll：暂不支持（OrbitControls无相机翻滚）
 */
export interface HeadingPitchRoll {
  /** 航向角(rad)，绕Z轴旋转 */
  heading: number;
  /** 俯仰角(rad)，视线上下 */
  pitch: number;
}

/**
 * 相机飞行动画选项
 */
export interface CameraFlyOptions {
  /** 动画持续时间，单位毫秒 */
  duration?: number;
  /** 飞行结束后相机距离目标点距离；不填使用目标位置原有距离 */
  distance?: number;
  /**
   * 动画中断回调
   * @remarks
   * 主动调用cancelFlyAnimation、再次调用flyTo/zoomTo会触发中断
   */
  onInterrupt?: () => void;
}

/**
 * 相机定位目标参数（扩展支持heading/pitch姿态）
 */
export interface CameraViewTarget {
  /** 目标观察点（世界坐标） */
  target: THREE.Vector3;
  /** 相机到目标的距离 */
  distance?: number;
  /** 姿态：航向+俯仰角（弧度），不传保持当前姿态 */
  orientation?: HeadingPitchRoll;
}

/**
 * 仿Cesium相机控制器
 * @remarks
 * 基于Three.js OrbitControls封装，坐标系 Z-Up
 * 提供 Cesium 风格接口：flyTo / zoomTo / getHeadingPitchRoll / lookAt
 * 支持平滑插值动画、航向俯仰姿态控制、动画中断回调
 * 内置远近距离边界限制，飞行不会突破OrbitControls minDistance/maxDistance
 * OrbitControls 不支持roll翻滚，暂不实现roll
 */
export class CameraController {
  /** 透视相机实例 */
  private readonly camera: THREE.PerspectiveCamera;
  /** 轨道控制器 */
  private readonly controls: OrbitControls;

  /** 当前进行中的动画请求ID */
  private animFrameId: number | null = null;
  /** 动画起始时间戳 */
  private startTime = 0;
  /** 保存当前动画中断回调 */
  private activeInterruptCb?: () => void;

  // 常量 Z-Up 向上向量
  private readonly Z_UP = new THREE.Vector3(0, 0, 1);

  /**
   * 构造相机控制器
   * @param camera 透视相机
   * @param controls orbit控制器实例（已设置camera.up = Z_UP）
   */
  constructor(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    this.camera = camera;
    this.controls = controls;
  }

  /**
   * 立刻定位到目标（无动画，对应Cesium zoomTo）
   * @param view 目标观察配置（支持orientation航向俯仰）
   */
  zoomTo(view: CameraViewTarget): void {
    this.cancelFlyAnimation();

    const target = view.target.clone();
    const rawDistance = view.distance ?? this.camera.position.distanceTo(this.controls.target);
    // 边界钳位，限制在控制器最小/最大距离之间
    const distance = THREE.MathUtils.clamp(
      rawDistance,
      this.controls.minDistance,
      this.controls.maxDistance,
    );

    let offset: THREE.Vector3;
    if (view.orientation) {
      offset = this.hprToOffset(view.orientation, distance);
    } else {
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      offset = dir.multiplyScalar(distance);
    }

    const newCamPos = target.clone().add(offset);
    this.camera.position.copy(newCamPos);
    this.controls.target.copy(target);
    this.controls.update();
  }

  /**
   * 平滑飞行至目标（对应Cesium flyTo）
   * @param view 目标观察配置（支持orientation航向俯仰）
   * @param options 动画参数（支持onInterrupt中断回调）
   */
  flyTo(view: CameraViewTarget, options: CameraFlyOptions = {}): void {
    // 触发上一次动画中断回调
    this.cancelFlyAnimation();
    this.activeInterruptCb = options.onInterrupt;

    const duration = options.duration ?? 1000;
    const targetPoint = view.target.clone();
    const rawTargetDistance =
      view.distance ?? this.camera.position.distanceTo(this.controls.target);
    const targetDistance = THREE.MathUtils.clamp(
      rawTargetDistance,
      this.controls.minDistance,
      this.controls.maxDistance,
    );

    // 起点状态
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();
    const startHpr = this.getHeadingPitchRoll();

    // 终点偏移
    let endOffset: THREE.Vector3;
    if (view.orientation) {
      endOffset = this.hprToOffset(view.orientation, targetDistance);
    } else {
      const dir = startPos.clone().sub(startTarget).normalize();
      endOffset = dir.multiplyScalar(targetDistance);
    }
    const endPos = targetPoint.clone().add(endOffset);
    const endHpr = view.orientation ?? startHpr;

    this.startTime = performance.now();

    const animate = (timestamp: number) => {
      const elapsed = timestamp - this.startTime;
      let t = Math.min(elapsed / duration, 1);
      // ease-in-out 缓动
      t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

      // 位置插值
      this.camera.position.lerpVectors(startPos, endPos, t);
      this.controls.target.lerpVectors(startTarget, targetPoint, t);

      // 姿态插值
      if (view.orientation) {
        const curHeading = THREE.MathUtils.lerp(startHpr.heading, endHpr.heading, t);
        const curPitch = THREE.MathUtils.lerp(startHpr.pitch, endHpr.pitch, t);
        const curOffset = this.hprToOffset(
          { heading: curHeading, pitch: curPitch },
          targetDistance,
        );
        this.camera.position.copy(this.controls.target).add(curOffset);
      }

      this.controls.update();

      if (t < 1) {
        this.animFrameId = requestAnimationFrame(animate);
      } else {
        this.animFrameId = null;
        this.activeInterruptCb = undefined;
      }
    };

    this.animFrameId = requestAnimationFrame(animate);
  }

  /**
   * 快捷看向目标点（无动画，仅修改lookAt目标，保持当前视距与姿态）
   * @param point 观察目标世界坐标
   */
  lookAt(point: THREE.Vector3): void {
    this.cancelFlyAnimation();
    this.controls.target.copy(point);
    this.controls.update();
  }

  /**
   * 获取当前相机的航向与俯仰角
   * @returns HeadingPitchRoll（弧度）
   */
  getHeadingPitchRoll(): HeadingPitchRoll {
    const offset = this.camera.position.clone().sub(this.controls.target);
    return this.offsetToHpr(offset);
  }

  /**
   * 取消正在执行的飞行动画，触发中断回调
   */
  cancelFlyAnimation(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
      // 执行中断回调
      if (this.activeInterruptCb) {
        this.activeInterruptCb();
        this.activeInterruptCb = undefined;
      }
    }
  }

  /**
   * 获取当前控制器观察目标点
   * @returns 目标向量副本
   */
  getTarget(): THREE.Vector3 {
    return this.controls.target.clone();
  }

  /**
   * 销毁动画资源
   */
  dispose(): void {
    this.cancelFlyAnimation();
  }

  //#region 内部数学转换 Z-Up 坐标系
  /**
   * 偏移向量 → HeadingPitchRoll(Z-Up)
   * @internal
   */
  private offsetToHpr(offset: THREE.Vector3): HeadingPitchRoll {
    const horizontal = new THREE.Vector2(offset.x, offset.y);
    const heading = Math.atan2(horizontal.y, horizontal.x);
    const radius2d = horizontal.length();
    const pitch = Math.atan2(-offset.z, radius2d);
    return { heading, pitch };
  }

  /**
   * HeadingPitchRoll → 相对目标点的偏移向量(Z-Up)
   * @internal
   */
  private hprToOffset(hpr: HeadingPitchRoll, distance: number): THREE.Vector3 {
    const { heading, pitch } = hpr;
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cosHeading = Math.cos(heading);
    const sinHeading = Math.sin(heading);

    const offset = new THREE.Vector3();
    offset.x = distance * cosPitch * cosHeading;
    offset.y = distance * cosPitch * sinHeading;
    offset.z = -distance * sinPitch;
    return offset;
  }
  //#endregion
}

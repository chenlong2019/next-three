import * as THREE from "three";
import { Scene } from "./Scene";
import { WebMercatorGIS } from "../gis/WebMercatorGIS";
import {
  getViewGroundCorners,
  cornersToLngLatBounds,
  getSuggestZoom,
} from "../engine/utils/camera-utils";

/** 保存原生 Map 引用（类名 Map 会遮蔽全局 Map） */
const NativeMap = globalThis.Map;

// ─── 事件类型定义 ─────────────────────────────────────────────

export interface MapMouseEvent {
  /** 地理坐标 [经度, 纬度] */
  lngLat: [number, number];
  /** 屏幕像素坐标 */
  point: { x: number; y: number };
  /** Three.js 地面交点 */
  groundPoint: THREE.Vector3;
  /** 原始 DOM 事件 */
  originalEvent: MouseEvent;
}

export interface MapMoveEvent {
  /** 当前中心点 [经度, 纬度] */
  center: [number, number];
  /** 当前 zoom 层级 */
  zoom: number;
  /** 当前视口范围 */
  bounds: { west: number; east: number; south: number; north: number };
}

type MapEventMap = {
  click: MapMouseEvent;
  dblclick: MapMouseEvent;
  mousemove: MapMouseEvent;
  mousedown: MapMouseEvent;
  mouseup: MapMouseEvent;
  contextmenu: MapMouseEvent;
  move: MapMoveEvent;
  moveend: MapMoveEvent;
  zoom: MapMoveEvent;
};

type MapEventName = keyof MapEventMap;
type MapPointerEventName = Exclude<MapEventName, "move" | "moveend" | "zoom">;
type MapEventHandler<T> = (event: T) => void;
type StoredMapEventHandler = MapEventHandler<MapEventMap[MapEventName]>;

// ─── Map 主类 ─────────────────────────────────────────────────

/**
 * 地图控制器（仿 Mapbox GL JS Map API）
 *
 * 提供：
 * - 发布订阅事件系统：click / mousemove / move / zoom / moveend
 * - 地图状态查询：getCenter / getZoom / getBounds
 * - 地图操作：flyTo / setCenter / setZoom
 *
 * 用法：
 * ```ts
 * const map = new Map(scene, gis, container);
 * map.on('click', (e) => console.log('点击了', e.lngLat));
 * const center = map.getCenter();
 * ```
 */
export class Map {
  private scene: Scene;
  private gis: WebMercatorGIS;
  private container: HTMLElement;
  private listeners = new NativeMap<MapEventName, Set<StoredMapEventHandler>>();
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly domListeners: Array<{
    type: MapPointerEventName;
    listener: (event: MouseEvent) => void;
  }> = [];
  private disposed = false;

  /** 上一帧的相机距离（用于检测zoom变化） */
  private lastDistance = 0;
  /** 上一帧的目标点（用于检测move） */
  private lastTarget = new THREE.Vector3();
  /** moveend 防抖定时器 */
  private moveEndTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(scene: Scene, gis: WebMercatorGIS, container: HTMLElement) {
    this.scene = scene;
    this.gis = gis;
    this.container = container;

    this.bindMouseEvents();
    this.bindFrameUpdate();
  }

  // ─── 发布订阅 ─────────────────────────────────────────────

  /**
   * 注册事件监听
   */
  on<K extends MapEventName>(event: K, handler: MapEventHandler<MapEventMap[K]>): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as StoredMapEventHandler);
    return this;
  }

  /**
   * 移除事件监听
   */
  off<K extends MapEventName>(event: K, handler: MapEventHandler<MapEventMap[K]>): this {
    this.listeners.get(event)?.delete(handler as StoredMapEventHandler);
    return this;
  }

  /**
   * 注册一次性事件监听（触发后自动移除）
   */
  once<K extends MapEventName>(event: K, handler: MapEventHandler<MapEventMap[K]>): this {
    const wrapper: MapEventHandler<MapEventMap[K]> = (e) => {
      this.off(event, wrapper);
      handler(e);
    };
    return this.on(event, wrapper);
  }

  /**
   * 触发事件
   */
  private emit<K extends MapEventName>(event: K, data: MapEventMap[K]) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      (handler as MapEventHandler<MapEventMap[K]>)(data);
    }
  }

  // ─── 地图状态查询 API ─────────────────────────────────────

  /**
   * 获取当前视口地理范围
   */
  getBounds(): { west: number; east: number; south: number; north: number } | null {
    const camera = this.scene.getCamera();
    if (!camera) return null;

    const corners = getViewGroundCorners(camera);
    if (corners.length < 3) return null;

    return cornersToLngLatBounds(corners, this.gis);
  }

  /**
   * 获取当前 zoom 层级（基于相机距离动态计算）
   */
  getZoom(): number {
    const gisCtrl = this.scene.getGisController();
    const camera = this.scene.getCamera();
    if (!gisCtrl || !camera) return 1;

    const distance = camera.position.distanceTo(gisCtrl.controls.target);
    const [, lat] = gisCtrl.getTargetLngLat();
    return getSuggestZoom(distance, 75, this.container.clientHeight || 900, lat);
  }

  /**
   * 获取当前地图中心点 [经度, 纬度]
   */
  getCenter(): [number, number] {
    const gisCtrl = this.scene.getGisController();
    if (!gisCtrl) return [0, 0];
    const [lng, lat] = gisCtrl.getTargetLngLat();
    return [lng, lat];
  }

  /**
   * 获取相机到目标点的距离（米）
   */
  getCameraDistance(): number {
    const gisCtrl = this.scene.getGisController();
    const camera = this.scene.getCamera();
    if (!gisCtrl || !camera) return 0;
    return camera.position.distanceTo(gisCtrl.controls.target);
  }

  // ─── 地图操作 API ─────────────────────────────────────────

  /**
   * 飞行定位到指定经纬度
   * @param lng 经度
   * @param lat 纬度
   * @param eyeHeight 相机高度（米），可选
   */
  flyTo(lng: number, lat: number, eyeHeight?: number) {
    const height = eyeHeight ?? (this.getCameraDistance() || 50000);
    this.scene.flyTo(lng, lat, height);
  }

  /**
   * 设置地图中心（不改变高度）
   */
  setCenter(lng: number, lat: number) {
    this.flyTo(lng, lat);
  }

  /**
   * 屏幕像素坐标 → 地理坐标
   * @param x 屏幕X（左起）
   * @param y 屏幕Y（上起）
   * @returns [经度, 纬度] 或 null（射线未命中地面）
   */
  unproject(x: number, y: number): [number, number] | null {
    const camera = this.scene.getCamera();
    if (!camera) return null;

    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(ndc, camera);
    const point = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, point)) {
      const [lng, lat] = this.gis.threeToLngLat(point);
      return [lng, lat];
    }
    return null;
  }

  /**
   * 地理坐标 → 屏幕像素坐标
   * @param lng 经度
   * @param lat 纬度
   * @returns { x, y } 屏幕坐标
   */
  project(lng: number, lat: number): { x: number; y: number } | null {
    const camera = this.scene.getCamera();
    if (!camera) return null;

    const pos = this.gis.lngLatToThree(lng, lat, 0);
    const projected = pos.project(camera as THREE.PerspectiveCamera);

    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((projected.x + 1) / 2) * rect.width + rect.left,
      y: ((-projected.y + 1) / 2) * rect.height + rect.top,
    };
  }

  // ─── 内部：鼠标事件绑定 ───────────────────────────────────

  private bindMouseEvents() {
    const eventTypes: MapPointerEventName[] = [
      "click",
      "dblclick",
      "mousemove",
      "mousedown",
      "mouseup",
      "contextmenu",
    ];

    for (const type of eventTypes) {
      const listener = (event: MouseEvent): void => {
        this.handleMouseEvent(type, event);
      };
      this.domListeners.push({ type, listener });
      this.container.addEventListener(type, listener);
    }
  }

  private handleMouseEvent(eventName: MapPointerEventName, e: MouseEvent) {
    if (this.disposed) return;
    const camera = this.scene.getCamera();
    if (!camera) return;

    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );

    this.raycaster.setFromCamera(ndc, camera);
    const groundPoint = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, groundPoint);

    if (!hit) return;

    const [lng, lat] = this.gis.threeToLngLat(groundPoint);

    const mapEvent: MapMouseEvent = {
      lngLat: [lng, lat],
      point: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      groundPoint: groundPoint.clone(),
      originalEvent: e,
    };

    this.emit(eventName, mapEvent);
  }

  // ─── 内部：帧更新（检测 move / zoom） ─────────────────────

  private bindFrameUpdate() {
    this.scene.addFrameCallback("mapEventUpdate", () => {
      this.checkCameraChange();
    });
  }

  private checkCameraChange() {
    const gisCtrl = this.scene.getGisController();
    const camera = this.scene.getCamera();
    if (!gisCtrl || !camera) return;

    const target = gisCtrl.controls.target;
    const distance = camera.position.distanceTo(target);

    const moved = !this.lastTarget.equals(target);
    const zoomed = Math.abs(distance - this.lastDistance) > distance * 0.001;

    if (moved || zoomed) {
      this.lastTarget.copy(target);
      this.lastDistance = distance;

      const [lng, lat] = gisCtrl.getTargetLngLat();
      const zoom = this.getZoom();
      const bounds = this.getBounds();

      const moveEvent: MapMoveEvent = {
        center: [lng, lat],
        zoom,
        bounds: bounds ?? { west: -180, east: 180, south: -85, north: 85 },
      };

      this.emit("move", moveEvent);
      if (zoomed) this.emit("zoom", moveEvent);

      // moveend 防抖：相机停止变化 150ms 后触发
      if (this.moveEndTimer) clearTimeout(this.moveEndTimer);
      this.moveEndTimer = setTimeout(() => {
        this.emit("moveend", moveEvent);
      }, 150);
    }
  }

  // ─── 销毁 ─────────────────────────────────────────────────

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.removeFrameCallback("mapEventUpdate");
    for (const { type, listener } of this.domListeners) {
      this.container.removeEventListener(type, listener);
    }
    this.domListeners.length = 0;
    this.listeners.clear();
    if (this.moveEndTimer) clearTimeout(this.moveEndTimer);
    this.moveEndTimer = null;
  }
}

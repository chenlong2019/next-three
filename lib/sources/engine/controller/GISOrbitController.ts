import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { WebMercatorGIS } from "../../gis/WebMercatorGIS";

export interface GISOrbitControllerOptions {
  minDistance?: number;
  maxDistance?: number;
  zoomSpeed?: number;
  /** Minimum OrbitControls polar angle in radians. */
  minPolarAngle?: number;
  /** Maximum OrbitControls polar angle in radians. */
  maxPolarAngle?: number;
}

export class GISOrbitController {
  public controls: OrbitControls;
  public camera: THREE.PerspectiveCamera;
  public gis: WebMercatorGIS;

  public minDistance: number;
  public maxDistance: number;
  public minPolarAngle: number;
  public maxPolarAngle: number;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    gis: WebMercatorGIS,
    opts: GISOrbitControllerOptions = {},
  ) {
    this.camera = camera;
    this.gis = gis;
    this.minDistance = opts.minDistance ?? 5;
    this.maxDistance = opts.maxDistance ?? 200000;
    this.minPolarAngle = opts.minPolarAngle ?? THREE.MathUtils.degToRad(5);
    this.maxPolarAngle = opts.maxPolarAngle ?? THREE.MathUtils.degToRad(88);

    this.controls = new OrbitControls(camera, domElement);
    this.setupGISParams();

    if (opts.zoomSpeed !== undefined) {
      this.controls.zoomSpeed = opts.zoomSpeed;
    }
  }

  private setupGISParams() {
    const c = this.controls;
    c.enableDamping = true;
    c.dampingFactor = 0.05;

    c.enableRotate = true;
    c.enablePan = true;
    c.enableZoom = true;

    c.minDistance = this.minDistance;
    c.maxDistance = this.maxDistance;

    // Z-Up俯仰角限制，不允许钻到地面下方
    c.minPolarAngle = this.minPolarAngle;
    c.maxPolarAngle = this.maxPolarAngle;

    // 原生内置鼠标位置缩放（不再手写wheel）
    c.zoomToCursor = true;
    c.screenSpacePanning = false; // GIS关键：沿地平面平移
    c.rotateSpeed = 0.6;
    c.panSpeed = 0.7;
    c.zoomSpeed = 0.8;
  }

  /**
   * 定位飞至经纬度 Z-Up
   * @param lng,lat WGS84
   * @param eyeHeight 相机距离目标点空间高度（米）
   * @param alt 目标点地面高程
   */
  flyTo(lng: number, lat: number, eyeHeight = 50000, alt = 0) {
    const targetPos = this.gis.lngLatToThree(lng, lat, alt);
    this.controls.target.copy(targetPos);
    // Z-Up：相机在目标上方 +Z方向
    this.camera.position.copy(targetPos).add(new THREE.Vector3(0, 0, eyeHeight));
    this.controls.update();
  }

  // 获取当前中心点经纬度
  getTargetLngLat(): [number, number, number] {
    return this.gis.threeToLngLat(this.controls.target);
  }

  update() {
    this.controls.update();
  }

  dispose() {
    this.controls.dispose();
  }
}

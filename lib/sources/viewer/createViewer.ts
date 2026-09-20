import * as THREE from "three";
import { Scene } from "../core/Scene";
import { WebMercatorGIS } from "../gis/WebMercatorGIS";
import { TileLayer, type TileLayerOptions } from "../engine/layers/TileLayer";
import {
  CesiumTerrainLayer,
  type CesiumTerrainLayerOptions,
} from "../engine/layers/CesiumTerrainLayer";
import { Tiles3DLayer, type Tiles3DLayerOptions } from "../engine/layers/Tiles3DLayer";
import {
  GeoJSONLayer,
  type GeoJSONLayerOptions,
} from "../engine/layers/GeoJSONLayer";
import type { ThreeUtilsOptions } from "../engine/three-utils";
import {
  cornersToLngLatBounds,
  getSuggestZoom,
  getViewGroundCorners,
} from "../engine/utils/camera-utils";

/** 容器：DOM 元素，或元素 id（可带 `#` 前缀）。 */
export type ViewerContainer = HTMLElement | string;

/** 单条影像底图配置。 */
export interface ViewerImageryOptions {
  /** XYZ 模板，例如 `https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}`。 */
  url: string;
  /** 相对自动推算层级的偏移，注记图层常用负值。 */
  zoomOffset?: number;
  /** 透传给 `TileLayer` 的细粒度选项。 */
  options?: TileLayerOptions;
}

/** 地形配置：`terrainUrl` + `accessToken` 必填，其余透传 `CesiumTerrainLayer`。 */
export interface ViewerTerrainOptions extends CesiumTerrainLayerOptions {
  /** Cesium quantized-mesh 服务地址，支持端点或 `{z}/{x}/{y}.terrain` 模板。 */
  terrainUrl: string;
  /** Cesium Ion 受限 token。 */
  accessToken: string;
  /**
   * 贴在地形上的影像模板。缺省自动复用第一条影像底图的 url，
   * 让地形与底图共用同一套瓦片。
   */
  imageryUrlTemplate?: string;
}

/** 3D Tiles 配置：`url` 必填，其余透传 `Tiles3DLayer`。 */
export interface ViewerTiles3DOptions extends Tiles3DLayerOptions {
  /** tileset.json 地址。 */
  url: string;
}

/** `setView` / `flyTo` 的视口参数。 */
export interface ViewerViewOptions {
  /** 目标中心 `[经度, 纬度]`。 */
  center?: readonly [number, number];
  /** 相机视高（米）。 */
  height?: number;
  /** 俯角（度）：90 = 正俯视，45 = 斜视。 */
  pitch?: number;
  /** 航向角（度）：0 = 正北朝上，顺时针为正。 */
  heading?: number;
}

export interface ViewerOptions extends ViewerViewOptions {
  /**
   * 局部坐标原点，缺省与 `center` 相同。
   * 只在"大范围漫游且需要更小浮点误差"时才需要单独指定。
   */
  origin?: readonly [number, number];
  /** 影像底图：字符串模板、配置对象，或两者的数组。 */
  imagery?:
    | string
    | ViewerImageryOptions
    | readonly (string | ViewerImageryOptions)[];
  /** 地形；传 `false` 显式关闭。 */
  terrain?: ViewerTerrainOptions | false;
  /** 3D Tiles：字符串 url、配置对象，或两者的数组。 */
  tiles3d?: string | ViewerTiles3DOptions | readonly (string | ViewerTiles3DOptions)[];
  /** GeoJSON 覆盖层（水系 / 道路 / 铁路）。 */
  geojson?: readonly GeoJSONLayerOptions[];
  /** 场景背景色。 */
  backgroundColor?: THREE.ColorRepresentation;
  /**
   * 图层选片与瓦片调度的节流间隔（毫秒），默认 200（5fps）。
   * 调小更跟手但更耗 CPU；0 表示每帧都算。
   */
  updateIntervalMs?: number;
  /** 透传给底层 `ThreeUtils`（相机 fov/near/far、后期处理、控制器选项等）。 */
  three?: ThreeUtilsOptions;
}

/** 已装配的图层引用，便于运行时增删改。 */
export interface ViewerLayers {
  readonly imagery: TileLayer[];
  readonly terrain: CesiumTerrainLayer | null;
  readonly tiles3d: Tiles3DLayer[];
  readonly geojson: GeoJSONLayer[];
}

/**
 * 一站式三维场景句柄。
 *
 * 除 `scene` / `gis` / `camera` 等底层对象外，还提供 Cesium 风格的
 * `setView` / `flyTo`，并已内置图层帧循环——调用方不需要自己算视口边界、
 * 自己接 `addFrameCallback`。
 */
export interface Viewer {
  readonly container: HTMLElement;
  readonly scene: Scene;
  readonly gis: WebMercatorGIS;
  readonly camera: THREE.PerspectiveCamera;
  readonly layers: ViewerLayers;
  /** 瞬时切换视口（无动画）。 */
  setView(options?: ViewerViewOptions): void;
  /** 带动画飞向目标视口。 */
  flyTo(options?: ViewerViewOptions): void;
  /** 追加任意 Three.js 对象到场景。 */
  add(object: THREE.Object3D): Viewer;
  /** 释放 WebGL、图层、事件与帧循环。 */
  destroy(): void;
}

const DEFAULT_CENTER: readonly [number, number] = [116.4, 39.9];
const DEFAULT_HEIGHT = 10000;
const DEFAULT_UPDATE_INTERVAL_MS = 200;
/**
 * 控制器默认把相机限制在 20 万米内、俯角最多到 5°。
 * 一站式入口要支持"从太空看地球"这类视高（Cesium 的 setView 常见用法），
 * 所以这里放开：最远 20000 km（足以看到整颗地球），并允许接近正俯视。
 * 需要更贴近地表的交互手感时，用 `three.gisControllerOptions` 覆盖即可。
 */
const DEFAULT_MAX_DISTANCE = 20_000_000;
const DEFAULT_MIN_POLAR_ANGLE = THREE.MathUtils.degToRad(0.5);
/** 帧循环标识，独立于业务自己注册的回调。 */
const FRAME_KEY = "__three-gis-viewer";

function resolveContainer(container: ViewerContainer): HTMLElement {
  if (typeof container === "string") {
    const id = container.startsWith("#") ? container.slice(1) : container;
    const element =
      typeof document === "undefined" ? null : document.getElementById(id);
    if (!element) {
      throw new Error(`createViewer: 找不到容器 "#${id}"。`);
    }
    return element;
  }
  if (!container) {
    throw new Error("createViewer: 容器不能为空。");
  }
  return container;
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined || value === false) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

/**
 * 三行代码把三维地球跑起来。
 *
 * ```ts
 * const viewer = await createViewer("app", {
 *   center: [116.4, 39.9],
 *   height: 1500000,
 *   imagery: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
 * });
 * ```
 *
 * 内部依次完成：按 `center` 派生 `WebMercatorGIS` 局部原点 → 建立 `Scene` →
 * 等待渲染器就绪 → 装配影像 / 地形 / 3D Tiles / GeoJSON 图层 → 设置初始视口 →
 * 注册帧循环（按需节流地推动图层选片与更新）。
 */
export async function createViewer(
  container: ViewerContainer,
  options: ViewerOptions = {},
): Promise<Viewer> {
  if (typeof document === "undefined") {
    throw new Error(
      "createViewer: 只能在浏览器里调用（SSR 请放到 useEffect / onMounted 中）。",
    );
  }

  const element = resolveContainer(container);
  const center = options.center ?? DEFAULT_CENTER;
  const origin = options.origin ?? center;
  const gis = new WebMercatorGIS(origin[0], origin[1]);

  let height = options.height ?? DEFAULT_HEIGHT;
  let pitch = options.pitch ?? 90;
  let heading = options.heading ?? 0;
  let targetLngLat: readonly [number, number] = center;

  const scene = new Scene(element, {
    gis,
    three: {
      cameraPosition: new THREE.Vector3(0, 0, height),
      targetPosition: new THREE.Vector3(0, 0, 0),
      ...options.three,
      gisControllerOptions: {
        minPolarAngle: DEFAULT_MIN_POLAR_ANGLE,
        maxDistance: DEFAULT_MAX_DISTANCE,
        ...options.three?.gisControllerOptions,
      },
    },
  });

  await scene.ready();

  const camera = scene.getCamera();
  const controller = scene.getGISController();
  if (!camera || !controller) {
    scene.destroy();
    throw new Error("createViewer: 场景初始化失败（相机或控制器缺失）。");
  }
  const controls = controller.controls;

  /* ---------------- 图层装配 ---------------- */

  const imageryLayers: TileLayer[] = [];
  const imageryZoomOffsets: number[] = [];
  const imageryOptions = toArray<string | ViewerImageryOptions>(options.imagery).map(
    (entry) => (typeof entry === "string" ? { url: entry } : entry),
  );
  for (const config of imageryOptions) {
    const layer = new TileLayer(config.url, gis, config.options);
    scene.add(layer);
    imageryLayers.push(layer);
    imageryZoomOffsets.push(config.zoomOffset ?? 0);
  }

  let terrainLayer: CesiumTerrainLayer | null = null;
  if (options.terrain) {
    const {
      terrainUrl,
      accessToken,
      imageryUrlTemplate,
      ...terrainOptions
    } = options.terrain;
    terrainLayer = new CesiumTerrainLayer(gis, { terrainUrl, accessToken }, {
      // 默认复用第一条底图，避免地形加载了却没有影像贴上
      imageryUrlTemplate: imageryUrlTemplate ?? imageryOptions[0]?.url,
      ...terrainOptions,
    });
    scene.add(terrainLayer);
  }

  const tiles3dLayers: Tiles3DLayer[] = [];
  for (const entry of toArray<string | ViewerTiles3DOptions>(options.tiles3d)) {
    const { url, ...tilesOptions } = typeof entry === "string" ? { url: entry } : entry;
    const layer = new Tiles3DLayer(gis, { url }, tilesOptions);
    scene.add(layer);
    tiles3dLayers.push(layer);
  }

  const geojsonLayers: GeoJSONLayer[] = [];
  for (const config of options.geojson ?? []) {
    const layer = new GeoJSONLayer(gis, config);
    scene.add(layer);
    geojsonLayers.push(layer);
  }

  /* ---------------- 视口 ---------------- */

  const applyCamera = (): void => {
    const target = gis.lngLatToThree(targetLngLat[0], targetLngLat[1], 0);
    const depression = THREE.MathUtils.degToRad(
      THREE.MathUtils.clamp(pitch, 1, 90),
    );
    const horizontal = height / Math.tan(depression);
    const bearing = THREE.MathUtils.degToRad(heading);
    // 局部坐标系：X 向东、Y 向北、Z 向上；heading=0 时相机位于目标正南看正北
    const offset = new THREE.Vector3(
      -Math.sin(bearing) * horizontal,
      -Math.cos(bearing) * horizontal,
      height,
    );
    controls.target.copy(target);
    camera.position.copy(target).add(offset);
    camera.updateProjectionMatrix();
    controls.update();
  };

  const normalizeView = (view: ViewerViewOptions): void => {
    if (view.center) targetLngLat = view.center;
    if (view.height !== undefined) height = view.height;
    if (view.pitch !== undefined) pitch = view.pitch;
    if (view.heading !== undefined) heading = view.heading;
  };

  applyCamera();

  /* ---------------- 帧循环 ---------------- */

  // 交互期间暂停地形的影像升级重建（放大时主线程 drawImage + 大纹理上传是大头）
  const handleInteractionStart = (): void => terrainLayer?.setCameraInteracting(true);
  const handleInteractionEnd = (): void => terrainLayer?.setCameraInteracting(false);
  controls.addEventListener("start", handleInteractionStart);
  controls.addEventListener("end", handleInteractionEnd);

  const updateInterval = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;
  let lastSelectionTime = 0;

  const updateSelection = (): void => {
    const controllerTarget = controls.target;
    const cameraDistance = camera.position.distanceTo(controllerTarget);
    const latitude = controller.getTargetLngLat()[1] ?? targetLngLat[1];
    const planeZ = controllerTarget.z;
    // 地形高于相机目标平面时，屏幕底边可见地面比「射线∩目标平面」更近，
    // 不补齐会漏选这一条，导致该区域只能靠粗层级兜底。
    const groundRelief = Math.max(
      0,
      (terrainLayer?.getMaxObservedSurfaceHeight() ?? 0) - planeZ,
    );
    const corners = getViewGroundCorners(camera, planeZ, { groundRelief });
    const bounds = cornersToLngLatBounds(corners, gis);
    if (!bounds) return;

    const viewportHeight = element.clientHeight || 900;
    const zoom = getSuggestZoom(cameraDistance, camera.fov, viewportHeight, latitude);
    const imageryZoom = getSuggestZoom(
      Math.max(camera.position.z - planeZ, 1),
      camera.fov,
      viewportHeight,
      latitude,
    );
    const lngBounds: [number, number] = [bounds.west, bounds.east];
    const latBounds: [number, number] = [bounds.south, bounds.north];

    for (let index = 0; index < imageryLayers.length; index += 1) {
      const layer = imageryLayers[index];
      layer.updateTilesInView(
        lngBounds,
        latBounds,
        zoom + imageryZoomOffsets[index],
        controllerTarget,
        cameraDistance,
        camera,
      );
    }

    terrainLayer?.updateTilesInView(
      lngBounds,
      latBounds,
      zoom,
      controllerTarget,
      cameraDistance,
      camera.position,
      imageryZoom,
      camera,
      element.clientWidth || 1,
      viewportHeight,
    );
  };

  const viewportHeight = (): number => element.clientHeight || 900;

  scene.addFrameCallback(FRAME_KEY, () => {
    terrainLayer?.update();
    for (const layer of tiles3dLayers) layer.update(camera, viewportHeight());
    for (const layer of geojsonLayers) layer.update();

    const now = performance.now();
    if (updateInterval > 0 && now - lastSelectionTime < updateInterval) return;
    lastSelectionTime = now;
    updateSelection();
  });

  updateSelection();

  /* ---------------- 句柄 ---------------- */

  const viewer: Viewer = {
    container: element,
    scene,
    gis,
    camera,
    layers: {
      imagery: imageryLayers,
      terrain: terrainLayer,
      tiles3d: tiles3dLayers,
      geojson: geojsonLayers,
    },
    setView(view: ViewerViewOptions = {}): void {
      normalizeView(view);
      applyCamera();
      updateSelection();
    },
    flyTo(view: ViewerViewOptions = {}): void {
      normalizeView(view);
      scene.flyTo(targetLngLat[0], targetLngLat[1], height, 0);
    },
    add(object: THREE.Object3D): Viewer {
      scene.add(object);
      return viewer;
    },
    destroy(): void {
      scene.removeFrameCallback(FRAME_KEY);
      controls.removeEventListener("start", handleInteractionStart);
      controls.removeEventListener("end", handleInteractionEnd);
      for (const layer of imageryLayers) layer.dispose();
      terrainLayer?.dispose();
      for (const layer of tiles3dLayers) layer.dispose();
      for (const layer of geojsonLayers) layer.dispose();
      scene.destroy();
    },
  };

  return viewer;
}

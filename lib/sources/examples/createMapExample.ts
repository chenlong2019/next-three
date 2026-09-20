import * as THREE from "three";
import { Scene } from "../core/Scene";
import { GeoJSONLayer, type GeoJSONLayerOptions } from "../engine/layers/GeoJSONLayer";
import { CesiumTerrainLayer } from "../engine/layers/CesiumTerrainLayer";
import { Tiles3DLayer, type Tiles3DLayerStyle } from "../engine/layers/Tiles3DLayer";
import { TileLayer, type TileLayerOptions } from "../engine/layers/TileLayer";
import type { ThreeUtilsOptions } from "../engine/three-utils";
import {
  cornersToLngLatBounds,
  getSuggestZoom,
  getViewGroundCorners,
} from "../engine/utils/camera-utils";
import { WebMercatorGIS } from "../gis/WebMercatorGIS";

export type MapExampleLayer = "none" | "google" | "terrain" | "tiles3d";

export interface MapExampleRasterLayer {
  id: string;
  url: string;
  enabled?: boolean;
  /** 相对主视图 zoom 的偏移，适用于注记等需要匹配底图层级的图层。 */
  zoomOffset?: number;
  options?: TileLayerOptions;
}

export interface MapExampleOptions {
  layer?: MapExampleLayer;
  gis?: WebMercatorGIS;
  origin?: readonly [number, number];
  initialView?: readonly [number, number, number];
  /** Flat map surface altitude in meters. */
  surfaceAltitude?: number;
  enableHelpers?: boolean;
  three?: ThreeUtilsOptions;
  onReady?: (scene: Scene, gis: WebMercatorGIS) => void;
  googleUrl?: string;
  googleFallback?: boolean;
  /** Extra XYZ imagery zoom requested for the raster fallback. */
  googleZoomOffset?: number;
  /** Optional low-resolution overview source used below googleOptions.minZoom. */
  googleOverviewUrl?: string;
  googleOverviewOptions?: TileLayerOptions;
  googleOptions?: TileLayerOptions;
  /** Additional XYZ raster layers that share the example camera and update loop. */
  rasterLayers?: readonly MapExampleRasterLayer[];
  terrain?: {
    readonly terrainUrl: string;
    readonly accessToken: string;
    readonly maxConcurrent?: number;
    readonly maxQueueSize?: number;
    readonly maxRequestsPerFrame?: number;
    readonly maxTileRendersPerFrame?: number;
    readonly tileYOrigin?: "north" | "south" | "auto";
    readonly minZoom?: number;
    readonly terrainZoomOffset?: number;
    readonly imageryZoomOffset?: number;
    readonly imageryMaxCanvasSize?: number;
    readonly imageryUrlTemplate?: string;
    readonly imagerySubdomains?: readonly string[];
    readonly imageryRequestGroup?: string;
    readonly imageryMaximumRequestsPerServer?: number;
    readonly wireframe?: boolean;
    readonly maxTilesPerView?: number;
    readonly terrainTilePixelSize?: number;
    readonly maximumScreenSpaceError?: number;
    readonly exaggeration?: number;
    readonly maxZoom?: number;
    /** 内存中保留的已加载地形瓦片数（LRU）。 */
    readonly maxCacheSize?: number;
    /** 地形请求的每服务器并发上限（默认沿用调度器的 6）。 */
    readonly maximumRequestsPerServer?: number;
    /** 地形 .terrain 字节的持久化缓存预算（字节）；0 关闭。 */
    readonly terrainDiskCacheBytes?: number;
    /** 影像瓦片的持久化缓存预算（字节）；0 关闭。 */
    readonly imageryDiskCacheBytes?: number;
    /** 空闲时预取下一级地形数据的瓦片数；0 关闭。 */
    readonly prefetchTileBudget?: number;
    /** availability 之下的层级继续用上采样网格细分（虚拟瓦片），默认 true。 */
    readonly terrainVirtualSubdivision?: boolean;
    /** 地形四叉树细分（含虚拟瓦片）的最大层级，默认 maxZoom + 3。 */
    readonly terrainSubdivisionMaxZoom?: number;
    /**
     * 影像瓦片入场节拍：一整批希望全部亮起的时长（毫秒，默认 420）。
     * 调小 = 清晰更快但节奏更急，调大 = 更平缓但更晚看清；0 = 关闭节拍。
     */
    readonly revealSpreadMs?: number;
    /** 单块入场间隔上限（毫秒，默认 60）。 */
    readonly revealMaxSlotMs?: number;
    /** 候场超过该时长（毫秒，默认 400）强制优先入场，避免拖慢清晰度。 */
    readonly revealMaxWaitMs?: number;
    /** 同一帧最多放行的块数（默认 4）。 */
    readonly revealMaxPerFrame?: number;
    /** 手势期间每次视图更新最多放行的影像升级瓦片数（默认 2；0 = 完全冻结）。 */
    readonly imageryInteractingBudget?: number;
    /**
     * 层级着色验证模式：不绘制影像，瓦片按层级着纯色（色相=层级、明度=瓦片个体）。
     * 用于肉眼/截图判定"瓦片选择与覆盖是否正确"——出现粗层级色块即说明该区域
     * 的精细瓦片没被选中或没上屏。该模式不请求影像，验证速度最快。
     * 运行时也可用 api.setTerrainDebugColorMode() 切换。
     */
    readonly debugColorByZoom?: boolean;
  };
  tiles3d?: {
    readonly url: string;
    readonly maximumScreenSpaceError?: number;
    readonly maxConcurrent?: number;
    readonly maxRequestsPerFrame?: number;
    readonly maxCacheSize?: number;
    readonly enableFrustumCulling?: boolean;
    readonly heightOffset?: number;
    readonly style?: Tiles3DLayerStyle;
    readonly onReady?: (
      scene: Scene,
      gis: WebMercatorGIS,
      center: readonly [number, number, number],
      /** False after the user has already moved, zoomed, or rotated the camera. */
      allowAutoFrame: boolean,
    ) => void;
  };
  /** Optional static GeoJSON overlays rendered above the map surface. */
  geojson?: {
    readonly water?: Omit<GeoJSONLayerOptions, "kind">;
    readonly roads?: Omit<GeoJSONLayerOptions, "kind">;
    readonly railways?: Omit<GeoJSONLayerOptions, "kind">;
  };
}

export interface RendererStats {
  /** 上一帧 draw call 数 */
  calls: number;
  /** 上一帧三角面数 */
  triangles: number;
  /** 常驻几何体数 */
  geometries: number;
  /** 常驻纹理数 */
  textures: number;
  /** 是否处于快速跳层模式（连续缩放跨多层时只渲染最高/最底层） */
  fastZoom: boolean;
  /** 已就绪、正在候场等待"入场节拍"的瓦片数（>0 说明正在分帧依次亮起） */
  revealPending: number;
}

export interface MapExampleApi {
  init(): Promise<void>;
  destroy(): void;
  setRasterLayerEnabled(id: string, enabled: boolean): void;
  isRasterLayerEnabled(id: string): boolean;
  /** 读取渲染器统计（帧率诊断用）；场景未就绪时返回 null */
  getRendererStats(): RendererStats | null;
  /**
   * 层级着色验证模式：不绘制影像，瓦片按层级着纯色（色相=层级、明度=瓦片个体）。
   * 用来一眼判定"某片区域实际由哪一级瓦片绘制、是否有粗层级兜底没被替换"。
   */
  setTerrainDebugColorMode(enabled: boolean): void;
  /**
   * 层级 → 颜色 + 当前计数（图例/断言用）；未开启或图层未就绪时返回空数组。
   * `visible`=正选，`backup`=已加载但不在正选集的兜底常驻瓦片（底图毯/粗祖先），
   * `loaded`=实际提交绘制的瓦片数，`minDist`=该层级到相机的最近空间距离（米）。
   */
  getTerrainZoomLegend(): Array<{
    zoom: number;
    color: string;
    visible: number;
    backup: number;
    loaded: number;
    minDist: number;
  }>;
}

const DEFAULT_CENTER: [number, number] = [118.1371, 24.49];

/** Default Google satellite XYZ template used by map and drawing examples. */
export const DEFAULT_GOOGLE_URL = "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}";

/**
 * Shared runtime used by the layer-focused examples.
 * Each example enables exactly one primary capability while sharing the same
 * camera, viewport calculation, tile scheduling, and disposal behavior.
 */
export function createMapExample(
  container: HTMLDivElement,
  options: MapExampleOptions = {},
): MapExampleApi {
  const layerType = options.layer ?? "none";
  const [originLng, originLat] = options.origin ?? DEFAULT_CENTER;
  const gis = options.gis ?? new WebMercatorGIS(originLng, originLat);
  const initialView = options.initialView ?? [originLng, originLat, 10000];
  const surfaceAltitude = options.surfaceAltitude ?? 0;
  const addTerrainGoogleFallback = options.googleFallback ?? !options.terrain?.imageryUrlTemplate;
  const addTiles3DGoogleFallback = options.googleFallback ?? true;
  if (!Number.isFinite(surfaceAltitude)) {
    throw new TypeError("surfaceAltitude must be a finite number.");
  }

  let scene: Scene | null = null;
  let googleLayer: TileLayer | null = null;
  let googleOverviewLayer: TileLayer | null = null;
  const rasterLayerConfigs = new Map<string, MapExampleRasterLayer>();
  const rasterLayers = new Map<string, TileLayer>();
  const rasterLayerEnabled = new Map<string, boolean>();
  let terrainLayer: CesiumTerrainLayer | null = null;
  let tiles3dLayer: Tiles3DLayer | null = null;
  let waterLayer: GeoJSONLayer | null = null;
  let roadsLayer: GeoJSONLayer | null = null;
  let railwaysLayer: GeoJSONLayer | null = null;
  let disposed = false;
  let initPromise: Promise<void> | null = null;
  let lastUpdateTime = 0;
  let cameraControlledByUser = false;
  let removeCameraInteractionListener: (() => void) | null = null;

  for (const layer of options.rasterLayers ?? []) {
    if (rasterLayerConfigs.has(layer.id)) {
      throw new TypeError(`Duplicate raster layer id "${layer.id}".`);
    }
    rasterLayerConfigs.set(layer.id, layer);
    rasterLayerEnabled.set(layer.id, layer.enabled ?? true);
  }

  const updateLayers = (): void => {
    if (!scene || disposed) return;

    const camera = scene.getCamera();
    if (!camera) return;

    const controller = scene.getGISController();
    const target = controller?.controls.target;
    const cameraDistance = target ? camera.position.distanceTo(target) : camera.position.length();
    const latitude = controller?.getTargetLngLat()[1] ?? originLat;
    const planeZ = target?.z ?? 0;
    // 近地补齐：地形高于相机目标平面时，屏幕底边可见的地面比「射线 ∩
    // 目标平面」的交点更靠近相机。不补齐的话这一条落在视野包围盒外，
    // 瓦片不被选择，只能由底层级兜底瓦片顶着（永不升级影像）。
    const groundRelief = Math.max(
      0,
      (terrainLayer?.getMaxObservedSurfaceHeight() ?? 0) - planeZ,
    );
    const corners = getViewGroundCorners(camera, planeZ, { groundRelief });
    const bounds = cornersToLngLatBounds(corners, gis);
    if (!bounds) return;

    const zoom = getSuggestZoom(
      cameraDistance,
      camera.fov,
      container.clientHeight || 900,
      latitude,
    );
    const cameraHeight = Math.max(camera.position.z - planeZ, 1);
    const imageryZoom = getSuggestZoom(
      cameraHeight,
      camera.fov,
      container.clientHeight || 900,
      latitude,
    );
    const lngBounds: [number, number] = [bounds.west, bounds.east];
    const latBounds: [number, number] = [bounds.south, bounds.north];

    const googleZoom = THREE.MathUtils.clamp(zoom + (options.googleZoomOffset ?? 0), 1, 19);
    const googleMinZoom = options.googleOptions?.minZoom ?? 1;
    const useOverview = Boolean(options.googleOverviewUrl) && googleZoom < googleMinZoom;
    googleLayer?.setEnabled(!useOverview);
    googleOverviewLayer?.setEnabled(useOverview);
    googleLayer?.updateTilesInView(
      lngBounds,
      latBounds,
      googleZoom,
      target,
      cameraDistance,
      camera,
    );
    googleOverviewLayer?.updateTilesInView(
      lngBounds,
      latBounds,
      Math.min(googleZoom, options.googleOverviewOptions?.maxZoom ?? googleZoom),
      target,
      cameraDistance,
      camera,
    );
    for (const [id, layer] of rasterLayers) {
      if (!rasterLayerEnabled.get(id)) continue;
      const config = rasterLayerConfigs.get(id);
      if (!config) continue;
      const layerZoom = THREE.MathUtils.clamp(
        zoom + (config.zoomOffset ?? 0),
        config.options?.minZoom ?? 1,
        config.options?.maxZoom ?? 19,
      );
      layer.updateTilesInView(lngBounds, latBounds, layerZoom, target, cameraDistance, camera);
    }
    terrainLayer?.updateTilesInView(
      lngBounds,
      latBounds,
      zoom,
      target,
      cameraDistance,
      camera.position,
      imageryZoom,
      camera,
      container.clientWidth || 1,
      container.clientHeight || 1,
    );

    if (googleLayer && terrainLayer) {
      // Terrain covers only the service's valid bounds. Keep the raster layer
      // underneath so uncovered areas do not become empty.
      googleLayer.visible = true;
    }
    if (googleLayer && googleOverviewLayer) {
      googleLayer.visible = !useOverview;
      googleOverviewLayer.visible = useOverview;
    }
  };

  const addGoogleLayer = (): void => {
    if (!scene || googleLayer) return;
    googleLayer = new TileLayer(options.googleUrl ?? DEFAULT_GOOGLE_URL, gis, {
      ...options.googleOptions,
      maxCacheSize: options.googleOptions?.maxCacheSize ?? 180,
      altitude: options.googleOptions?.altitude ?? surfaceAltitude,
    });
    scene.add(googleLayer);
    if (options.googleOverviewUrl && !googleOverviewLayer) {
      googleOverviewLayer = new TileLayer(options.googleOverviewUrl, gis, {
        ...options.googleOverviewOptions,
        minZoom: options.googleOverviewOptions?.minZoom ?? 1,
      });
      scene.add(googleOverviewLayer);
      googleOverviewLayer.visible = false;
    }
  };

  const addTerrainLayer = (): void => {
    if (!scene || !options.terrain || terrainLayer) return;
    terrainLayer = new CesiumTerrainLayer(
      gis,
      {
        terrainUrl: options.terrain.terrainUrl,
        accessToken: options.terrain.accessToken,
      },
      {
        minZoom: options.terrain.minZoom ?? 1,
        maxZoom: options.terrain.maxZoom ?? 13,
        maxConcurrent: options.terrain.maxConcurrent,
        maxQueueSize: options.terrain.maxQueueSize,
        maxRequestsPerFrame: options.terrain.maxRequestsPerFrame,
        maxTileRendersPerFrame: options.terrain.maxTileRendersPerFrame,
        tileYOrigin: options.terrain.tileYOrigin,
        terrainZoomOffset: options.terrain.terrainZoomOffset,
        imageryZoomOffset: options.terrain.imageryZoomOffset,
        imageryMaxCanvasSize: options.terrain.imageryMaxCanvasSize,
        imagerySubdomains: options.terrain.imagerySubdomains,
        imageryRequestGroup: options.terrain.imageryRequestGroup,
        imageryMaximumRequestsPerServer: options.terrain.imageryMaximumRequestsPerServer,
        wireframe: options.terrain.wireframe,
        maxTilesPerView: options.terrain.maxTilesPerView,
        terrainTilePixelSize: options.terrain.terrainTilePixelSize,
        maximumScreenSpaceError: options.terrain.maximumScreenSpaceError,
        // 默认给到 256：几何构建已移入 Worker，主线程提交成本很低，
        // 更大的 LRU 能显著减少“回头看旧区域”时的重复下载与重建。
        maxCacheSize: options.terrain.maxCacheSize ?? 256,
        exaggeration: options.terrain.exaggeration ?? 1,
        imageryUrlTemplate: options.terrain.imageryUrlTemplate ?? DEFAULT_GOOGLE_URL,
        maximumRequestsPerServer: options.terrain.maximumRequestsPerServer,
        terrainDiskCacheBytes: options.terrain.terrainDiskCacheBytes,
        imageryDiskCacheBytes: options.terrain.imageryDiskCacheBytes,
        prefetchTileBudget: options.terrain.prefetchTileBudget,
        terrainVirtualSubdivision: options.terrain.terrainVirtualSubdivision,
        terrainSubdivisionMaxZoom: options.terrain.terrainSubdivisionMaxZoom,
        revealSpreadMs: options.terrain.revealSpreadMs,
        revealMaxSlotMs: options.terrain.revealMaxSlotMs,
        revealMaxWaitMs: options.terrain.revealMaxWaitMs,
        revealMaxPerFrame: options.terrain.revealMaxPerFrame,
        imageryInteractingBudget: options.terrain.imageryInteractingBudget,
        debugColorByZoom: options.terrain.debugColorByZoom,
      },
    );
    scene.add(terrainLayer);
    // 开发调试钩子：让浏览器控制台 / 自动化脚本能直接读取图层内部状态
    // （getCacheStats / traversal / currentVisibleKeys 等）。
    if (process.env.NODE_ENV !== "production") {
      (globalThis as { __terrainDebug?: unknown }).__terrainDebug = terrainLayer;
    }
  };

  const addRasterLayers = (): void => {
    if (!scene) return;
    for (const [id, config] of rasterLayerConfigs) {
      if (rasterLayers.has(id)) continue;
      const enabled = rasterLayerEnabled.get(id) ?? true;
      const layer = new TileLayer(config.url, gis, {
        ...config.options,
        altitude: config.options?.altitude ?? surfaceAltitude,
      });
      layer.visible = enabled;
      if (!enabled) layer.setEnabled(false);
      rasterLayers.set(id, layer);
      scene.add(layer);
    }
  };

  const addTiles3DLayer = (): void => {
    if (!scene || !options.tiles3d || tiles3dLayer) return;
    tiles3dLayer = new Tiles3DLayer(
      gis,
      { url: options.tiles3d.url },
      {
        maximumScreenSpaceError: options.tiles3d.maximumScreenSpaceError ?? 16,
        maxConcurrent: options.tiles3d.maxConcurrent,
        maxRequestsPerFrame: options.tiles3d.maxRequestsPerFrame,
        maxCacheSize: options.tiles3d.maxCacheSize,
        enableFrustumCulling: options.tiles3d.enableFrustumCulling,
        heightOffset: options.tiles3d.heightOffset ?? 0,
        style: options.tiles3d.style,
        onReady: (center) => {
          const activeScene = scene;
          if (!activeScene) return;
          const allowAutoFrame = !cameraControlledByUser;
          if (allowAutoFrame) {
            activeScene.flyTo(center[0], center[1], initialView[2], center[2]);
          }
          options.tiles3d?.onReady?.(activeScene, gis, center, allowAutoFrame);
        },
      },
    );
    scene.add(tiles3dLayer);
  };

  const addGeoJSONLayers = (): void => {
    if (!scene) return;

    if (options.geojson?.water && !waterLayer) {
      waterLayer = new GeoJSONLayer(gis, {
        ...options.geojson.water,
        kind: "water",
      });
      scene.add(waterLayer);
    }

    if (options.geojson?.roads && !roadsLayer) {
      roadsLayer = new GeoJSONLayer(gis, {
        ...options.geojson.roads,
        kind: "roads",
      });
      scene.add(roadsLayer);
    }

    if (options.geojson?.railways && !railwaysLayer) {
      railwaysLayer = new GeoJSONLayer(gis, {
        ...options.geojson.railways,
        kind: "railways",
      });
      scene.add(railwaysLayer);
    }
  };

  const init = (): Promise<void> => {
    if (initPromise) return initPromise;

    initPromise = (async () => {
      scene = new Scene(container, {
        gis,
        three: {
          ...options.three,
          enableHelpers: options.enableHelpers ?? options.three?.enableHelpers ?? false,
        },
      });
      await scene.ready();
      if (disposed || !scene) return;

      const controls = scene.getGISController()?.controls;
      if (controls) {
        const handleInteractionStart = () => {
          cameraControlledByUser = true;
          // 手势期间暂停地形图层的影像升级重建（主线程 drawImage 拼接
          // + 大纹理上传是放大时掉帧的大头），松手后一次性补齐
          terrainLayer?.setCameraInteracting(true);
        };
        const handleInteractionEnd = () => {
          terrainLayer?.setCameraInteracting(false);
        };
        controls.addEventListener("start", handleInteractionStart);
        controls.addEventListener("end", handleInteractionEnd);
        removeCameraInteractionListener = () => {
          controls.removeEventListener("start", handleInteractionStart);
          controls.removeEventListener("end", handleInteractionEnd);
        };
      }

      if (layerType === "google") {
        addGoogleLayer();
      } else if (layerType === "terrain") {
        if (addTerrainGoogleFallback) addGoogleLayer();
        addTerrainLayer();
      } else if (layerType === "tiles3d") {
        if (addTiles3DGoogleFallback) addGoogleLayer();
        addTiles3DLayer();
      }
      addRasterLayers();
      addGeoJSONLayers();

      scene.flyTo(initialView[0], initialView[1], initialView[2], surfaceAltitude);
      options.onReady?.(scene, gis);
      scene.addFrameCallback("map-example-update", () => {
        terrainLayer?.update();
        tiles3dLayer?.update(scene!.getCamera()!, container.clientHeight || 900);
        waterLayer?.update();
        roadsLayer?.update();
        railwaysLayer?.update();

        const now = performance.now();
        if (now - lastUpdateTime < 200) return;
        lastUpdateTime = now;
        updateLayers();
      });
      updateLayers();
    })().catch((error: unknown) => {
      if (!disposed) throw error;
    });

    return initPromise;
  };

  const destroy = (): void => {
    if (disposed) return;
    disposed = true;

    scene?.removeFrameCallback("map-example-update");
    removeCameraInteractionListener?.();
    removeCameraInteractionListener = null;
    googleLayer?.dispose();
    googleOverviewLayer?.dispose();
    for (const layer of rasterLayers.values()) layer.dispose();
    terrainLayer?.dispose();
    tiles3dLayer?.dispose();
    waterLayer?.dispose();
    roadsLayer?.dispose();
    railwaysLayer?.dispose();
    scene?.destroy();

    googleLayer = null;
    googleOverviewLayer = null;
    rasterLayers.clear();
    terrainLayer = null;
    tiles3dLayer = null;
    waterLayer = null;
    roadsLayer = null;
    railwaysLayer = null;
    scene = null;
  };

  return {
    init,
    destroy,
    setRasterLayerEnabled(id: string, enabled: boolean) {
      if (!rasterLayerConfigs.has(id)) return;
      rasterLayerEnabled.set(id, enabled);
      const layer = rasterLayers.get(id);
      if (!layer) return;
      layer.visible = enabled;
      layer.setEnabled(enabled);
    },
    isRasterLayerEnabled(id: string) {
      return rasterLayerEnabled.get(id) ?? false;
    },
    getRendererStats() {
      const renderer = scene?.renderer;
      if (!renderer) return null;
      return {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        fastZoom: terrainLayer?.isFastZoomActive() ?? false,
        revealPending: terrainLayer?.getCacheStats().revealPending ?? 0,
      };
    },
    setTerrainDebugColorMode(enabled: boolean) {
      terrainLayer?.setDebugColorMode(enabled);
    },
    getTerrainZoomLegend() {
      return terrainLayer?.getZoomColorLegend() ?? [];
    },
  };
}

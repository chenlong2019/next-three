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
    readonly tileYOrigin?: "north" | "south" | "auto";
    readonly minZoom?: number;
    readonly terrainZoomOffset?: number;
    readonly imageryZoomOffset?: number;
    readonly imageryMaxCanvasSize?: number;
    readonly imageryUrlTemplate?: string;
    readonly maxZoom?: number;
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

export interface MapExampleApi {
  init(): Promise<void>;
  destroy(): void;
  setRasterLayerEnabled(id: string, enabled: boolean): void;
  isRasterLayerEnabled(id: string): boolean;
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
    const corners = getViewGroundCorners(camera, planeZ);
    const bounds = cornersToLngLatBounds(corners, gis);
    if (!bounds) return;

    const zoom = getSuggestZoom(
      cameraDistance,
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
    googleLayer?.updateTilesInView(lngBounds, latBounds, googleZoom, target, cameraDistance);
    googleOverviewLayer?.updateTilesInView(
      lngBounds,
      latBounds,
      Math.min(googleZoom, options.googleOverviewOptions?.maxZoom ?? googleZoom),
      target,
      cameraDistance,
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
      layer.updateTilesInView(lngBounds, latBounds, layerZoom, target, cameraDistance);
    }
    terrainLayer?.updateTilesInView(
      lngBounds,
      latBounds,
      zoom,
      target,
      cameraDistance,
      camera.position,
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
        tileYOrigin: options.terrain.tileYOrigin,
        terrainZoomOffset: options.terrain.terrainZoomOffset,
        imageryZoomOffset: options.terrain.imageryZoomOffset,
        imageryMaxCanvasSize: options.terrain.imageryMaxCanvasSize,
        maxCacheSize: 80,
        exaggeration: 1.2,
        imageryUrlTemplate: options.terrain.imageryUrlTemplate ?? DEFAULT_GOOGLE_URL,
      },
    );
    scene.add(terrainLayer);
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
        };
        controls.addEventListener("start", handleInteractionStart);
        removeCameraInteractionListener = () => {
          controls.removeEventListener("start", handleInteractionStart);
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
  };
}

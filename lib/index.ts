/**
 * three-gis 公共入口。
 *
 * 这是库的唯一稳定入口：框架无关，不依赖 Next.js、React、Vue 或任何项目路径别名。
 * 除了 `three`（peer dependency）之外没有运行时依赖。
 *
 * 使用方式：
 * ```ts
 * import { Scene, WebMercatorGIS, TileLayer } from "three-gis";
 * ```
 *
 * @packageDocumentation
 */

/* ------------------------------------------------------------------ *
 * 一站式入口：三行代码跑起来（地形 / 3D Tiles / 影像 / GeoJSON 全自动装配）
 * ------------------------------------------------------------------ */

export {
  createViewer,
  type Viewer,
  type ViewerOptions,
  type ViewerLayers,
  type ViewerContainer,
  type ViewerImageryOptions,
  type ViewerTerrainOptions,
  type ViewerTiles3DOptions,
  type ViewerViewOptions,
} from "./sources/viewer/createViewer";

/* ------------------------------------------------------------------ *
 * 核心运行时：场景 / 地图 / 相机
 * ------------------------------------------------------------------ */

export { Scene, type SceneOptions, type SceneLoadCallback } from "./sources/core/Scene";
export { Map, type MapMouseEvent, type MapMoveEvent } from "./sources/core/Map";
export {
  CameraController,
  type HeadingPitchRoll,
  type CameraFlyOptions,
  type CameraViewTarget,
} from "./sources/core/CameraController";

/* ------------------------------------------------------------------ *
 * 坐标系统
 * ------------------------------------------------------------------ */

export {
  WebMercatorGIS,
  WEB_MERCATOR_MAX_LATITUDE,
  type LngLat,
  type LngLatAltitude,
  type MercatorCoordinate,
} from "./sources/gis/WebMercatorGIS";

/* ------------------------------------------------------------------ *
 * 图层：基类与容器
 * ------------------------------------------------------------------ */

export { Layer } from "./sources/engine/layers/Layer";
export { LayerGroup } from "./sources/engine/layers/LayerGroup";
export { LayerTree, type LayerTreeEvent } from "./sources/engine/layers/LayerTree";
export { LayerCollection } from "./sources/engine/layers/LayerCollection";
export { RasterLayer, type RasterLayerOption } from "./sources/engine/layers/RasterLayer";
export { RasterTileLayer, type RasterTileLayerOptions } from "./sources/engine/layers/RasterTileLayer";
export { VectorLayer } from "./sources/engine/layers/VectorLayer";
export { TerrainLayer } from "./sources/engine/layers/TerrainLayer";

/* ------------------------------------------------------------------ *
 * 图层：栅格瓦片（XYZ / TMS / WMS / WMTS）
 * ------------------------------------------------------------------ */

export { TileLayer, type TileLayerOptions } from "./sources/engine/layers/TileLayer";
export { TMSLayer, type TMSOptions, type TMSLayerOptions } from "./sources/engine/layers/TMSLayer";
export { WMSLayer, type WMSOptions, type WMSLayerOptions } from "./sources/engine/layers/WMSLayer";
export { WMTSLayer, type WMTSOptions, type WMTSLayerOptions } from "./sources/engine/layers/WMTSLayer";
export {
  DEFAULT_TILE_SUBDOMAINS,
  getTileRequestGroup,
  replaceTileTemplate,
} from "./sources/engine/layers/TileUrlTemplate";

/* ------------------------------------------------------------------ *
 * 图层：地形 / 3D Tiles / GeoJSON
 * ------------------------------------------------------------------ */

export {
  CesiumTerrainLayer,
  type CesiumTerrainLayerOptions,
  type TerrainTileYOrigin,
  type TerrainViewportLoadState,
} from "./sources/engine/layers/CesiumTerrainLayer";
export {
  Tiles3DLayer,
  type Tiles3DLayerOptions,
  type Tiles3DLayerStyle,
} from "./sources/engine/layers/Tiles3DLayer";
export {
  GeoJSONLayer,
  type GeoJSONLayerOptions,
  type GeoJSONLayerKind,
  type GeoJSONWaterStyle,
  type GeoJSONRoadStyle,
  type GeoJSONRailwayStyle,
} from "./sources/engine/layers/GeoJSONLayer";

/* ------------------------------------------------------------------ *
 * 资源调度与缓存
 * ------------------------------------------------------------------ */

export {
  RequestScheduler,
  requestScheduler,
  getRequestServerKey,
  type RequestSchedulerOptions,
  type ScheduledRequestOptions,
} from "./sources/engine/layers/RequestScheduler";
export {
  TileRequestQueue,
  TileLoadState,
  type TileRequest,
  type TileRequestQueueOptions,
} from "./sources/engine/layers/TileRequestQueue";
export {
  TileDiskCache,
  getTileDiskCache,
  type TileDiskCacheStats,
} from "./sources/engine/layers/TileDiskCache";

/* ------------------------------------------------------------------ *
 * 高级：Worker 池（想自行复用或预热时可单独引入）
 * ------------------------------------------------------------------ */

export {
  TerrainMeshWorkerPool,
  upsampleTerrainMesh,
  terrainWorkerMain,
  type TerrainMeshArrays,
  type TerrainMeshBaseArrays,
  type TerrainMeshParams,
} from "./sources/engine/layers/terrainMeshWorker";
export {
  ImageryStitchPool,
  imageryStitchWorkerMain,
  type ImageryStitchParams,
  type ImageryStitchResult,
} from "./sources/engine/layers/imageryStitchWorker";

/* ------------------------------------------------------------------ *
 * 图元（Primitive）
 * ------------------------------------------------------------------ */

export {
  BasePrimitive,
  type IPrimitiveStatic,
  type PrimitiveSerializedJson,
} from "./sources/engine/primitives/BasePrimitive";
export { BoxPrimitive, type BoxStyle, type BoxPrimitiveOption } from "./sources/engine/primitives/BoxPrimitive";
export {
  SpherePrimitive,
  type SphereStyle,
  type SpherePrimitiveOption,
} from "./sources/engine/primitives/SpherePrimitive";
export {
  PolygonPrimitive,
  type PolygonStyle as PolygonPrimitiveStyle,
  type PolygonPrimitiveOption,
} from "./sources/engine/primitives/PolygonPrimitive";
export {
  PolylinePrimitive,
  type PolylineStyle,
  type PolylinePrimitiveOption,
} from "./sources/engine/primitives/PolylinePrimitive";
export { PrimitiveFactory } from "./sources/engine/primitives/PrimitiveFactory";
export { PrimitiveCollection } from "./sources/engine/collection/PrimitiveCollection";

/* ------------------------------------------------------------------ *
 * 图形（Graphic，图层内的轻量业务图形）
 * ------------------------------------------------------------------ */

export { Graphic } from "./sources/engine/graphic/Graphic";
export { BaseGraphic } from "./sources/engine/graphic/BaseGraphic";
export { PointGraphic, type PointStyle, type PointGraphicOption } from "./sources/engine/graphic/PointGraphic";
export { LineGraphic, type LineStyle, type LineGraphicOption } from "./sources/engine/graphic/LineGraphic";
export {
  PolygonGraphic,
  type PolygonStyle as PolygonGraphicStyle,
  type PolygonGraphicOption,
} from "./sources/engine/graphic/PolygonGraphic";

/* ------------------------------------------------------------------ *
 * 交互式绘制
 * ------------------------------------------------------------------ */

export {
  DrawingManager as SceneDrawingManager,
  DrawMode,
  type DrawEntity,
} from "./sources/engine/three/DrawingManager";
export { DrawingManager as DrawingTaskManager, drawingManager } from "./sources/engine/draw/DrawingManager";
export { drawEntityToPrimitive, primitiveToDrawEntity } from "./sources/engine/draw/primitiveConvert";

/* ------------------------------------------------------------------ *
 * 控制器
 * ------------------------------------------------------------------ */

export {
  GISOrbitController,
  type GISOrbitControllerOptions,
} from "./sources/engine/controller/GISOrbitController";
export { EditorController } from "./sources/engine/controller/EditorController";
export { default as ViewportFloatingController } from "./sources/engine/controller/ViewportFloatingController";

/* ------------------------------------------------------------------ *
 * 材质
 * ------------------------------------------------------------------ */

export {
  createDaylightBuildingMaterial,
  prepareDaylightGeometry,
  type DaylightBuildingStyle,
} from "./sources/engine/materials/DaylightBuildingMaterial";

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

export { ThreeUtils } from "./sources/engine/three-utils";
export type {
  ThreeUtilsOptions,
  ThreePostprocessingOptions,
  BloomEffectOptions,
} from "./sources/engine/three-utils";
export {
  getHorizonDistance,
  getViewGroundCorners,
  cornersToLngLatBounds,
  getSuggestZoom,
  iterateTilesInBounds,
  type HorizonClipOptions,
} from "./sources/engine/utils/camera-utils";
export {
  amapTileToLngLatBounds,
  osmTileToLngLatBounds,
  tileXYFromLngLat,
  getTileBounds,
  lngLatToTile,
} from "./sources/engine/utils/gis-utils";
export { PICKABLE_LAYER, HELPER_LAYER } from "./sources/engine/globleValue";

/* ------------------------------------------------------------------ *
 * 公共类型
 * ------------------------------------------------------------------ */

export { ToolType } from "./sources/types/tool";
export type {
  ILayerNode,
  ILayer as ILayerContract,
  ILayerGroup,
  LayerTreeNode,
  LayerTreeViewNode,
  LayerTreeEvents,
  LayerNodeType,
  LayerCreateOptions,
  LayerGroupCreateOptions,
  LayerCollectionEvents,
  Entity,
  Primitive as PrimitiveDescriptor,
} from "./sources/types/layers";

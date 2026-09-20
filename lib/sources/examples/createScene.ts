import { Scene } from "../core/Scene";
import { Map } from "../core/Map";
import { TileLayer } from "../engine/layers/TileLayer";
import { WMSLayer } from "../engine/layers/WMSLayer";
import { TMSLayer } from "../engine/layers/TMSLayer";
import { WMTSLayer } from "../engine/layers/WMTSLayer";
import { CesiumTerrainLayer } from "../engine/layers/CesiumTerrainLayer";
import { Tiles3DLayer } from "../engine/layers/Tiles3DLayer";
import { WebMercatorGIS } from "../gis/WebMercatorGIS";
import {
  getViewGroundCorners,
  cornersToLngLatBounds,
  getSuggestZoom,
} from "../engine/utils/camera-utils";
import * as THREE from "three";

export function createScene(container: HTMLDivElement) {
  let scene: Scene;
  let tileLayer: TileLayer;
  let wmsLayer: WMSLayer | null = null;
  let tmsLayer: TMSLayer | null = null;
  let wmtsLayer: WMTSLayer | null = null;
  let terrainLayer: CesiumTerrainLayer | null = null;
  let tiles3dLayer: Tiles3DLayer | null = null;
  let map: Map;
  const gis = new WebMercatorGIS(0, 0);

  function init() {
    scene = new Scene(container);
    scene.load(() => {
      // 创建 Map 实例（事件系统 + API）
      map = new Map(scene, gis, container);

      addTileLayer();
      // addTerrainLayer();
      add3DTilesLayer();
      // addWmsLayer(); // 取消注释以叠加 WMS 图层

      // 示例：注册地图事件
      map.on("click", (e) => {
        console.log(`[Map] 点击: lng=${e.lngLat[0].toFixed(5)}, lat=${e.lngLat[1].toFixed(5)}`);
      });
      map.on("moveend", (e) => {
        console.log(
          `[Map] 停止移动: center=[${e.center[0].toFixed(4)}, ${e.center[1].toFixed(4)}], zoom=${e.zoom}`,
        );
      });
    });
  }

  function addTileLayer() {
    const urlTemplate = "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}";
    tileLayer = new TileLayer(urlTemplate, gis);
    scene.add(tileLayer);

    // 相机定位到武汉，初始高度 50km
    scene.flyTo(118.1371, 24.49, 10000);

    // 注册每帧回调：根据当前视角动态加载/卸载瓦片
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL = 200;

    scene.addFrameCallback("tileLayerUpdate", () => {
      // 地形 LOD 过渡动画：每帧驱动，不受节流限制
      terrainLayer?.update();

      const now = performance.now();
      if (now - lastUpdateTime < UPDATE_INTERVAL) return;
      lastUpdateTime = now;

      const camera = scene.getCamera();
      if (!camera) return;

      const gisCtrl = scene.getGisController();
      let cameraDistance = 50000;
      let latitude = 30;
      let cameraTarget: THREE.Vector3 | undefined;
      if (gisCtrl) {
        cameraTarget = gisCtrl.controls.target;
        cameraDistance = camera.position.distanceTo(cameraTarget);
        const [, lat] = gisCtrl.getTargetLngLat();
        latitude = lat;
      }

      // 用相机目标点 Z 作为地面高度，避免近距离观察地形时 bounds 偏移
      const planeZ = cameraTarget ? cameraTarget.z : 0;
      const corners = getViewGroundCorners(camera, planeZ);
      if (corners.length < 3) return;

      const bounds = cornersToLngLatBounds(corners, gis);
      if (!bounds) return;

      const zoom = getSuggestZoom(cameraDistance, 75, container.clientHeight || 900, latitude);

      tileLayer.updateTilesInView(
        [bounds.west, bounds.east],
        [bounds.south, bounds.north],
        zoom,
        cameraTarget,
        cameraDistance,
        camera,
      );

      // WMS 图层与底图共享视口更新逻辑
      wmsLayer?.updateTilesInView(
        [bounds.west, bounds.east],
        [bounds.south, bounds.north],
        zoom,
        cameraTarget,
        cameraDistance,
        camera,
      );

      // TMS / WMTS 同理
      tmsLayer?.updateTilesInView(
        [bounds.west, bounds.east],
        [bounds.south, bounds.north],
        zoom,
        cameraTarget,
        cameraDistance,
        camera,
      );
      wmtsLayer?.updateTilesInView(
        [bounds.west, bounds.east],
        [bounds.south, bounds.north],
        zoom,
        cameraTarget,
        cameraDistance,
        camera,
      );

      // Cesium 地形图层
      terrainLayer?.updateTilesInView(
        [bounds.west, bounds.east],
        [bounds.south, bounds.north],
        zoom,
        cameraTarget,
        cameraDistance,
        camera.position,
        undefined,
        camera,
        container.clientWidth || 1,
        container.clientHeight || 1,
      );

      // 地形已加载时隐藏平面底图，避免双层混合产生"一块一块"的视觉
      if (terrainLayer && terrainLayer.hasRenderableTiles()) {
        tileLayer.visible = false;
      } else {
        tileLayer.visible = true;
      }
    });
  }

  /**
   * WMS 图层示例（叠加在底图之上）
   * 替换 url / layers 为你自己的 WMS 服务即可
   */
  function addWmsLayer() {
    wmsLayer = new WMSLayer(
      gis,
      {
        url: "https://example.com/geoserver/wms",
        layers: "your_workspace:your_layer",
        version: "1.3.0",
        format: "image/png",
        transparent: true,
        // extraParams: { CQL_FILTER: "type='road'" },
      },
      { maxCacheSize: 150 },
    );
    scene.add(wmsLayer);
  }

  /**
   * TMS 图层示例
   * TMS 与 XYZ 的区别：Y 轴方向相反（Y=0 在南端）
   */
  function addTmsLayer() {
    tmsLayer = new TMSLayer(
      gis,
      {
        url: "https://example.com/tms/1.0.0/my_layer",
        format: "png",
        // flipY: true, // 默认 true，若服务端已是 XYZ 方向可设为 false
      },
      { maxCacheSize: 150 },
    );
    scene.add(tmsLayer);
  }

  /**
   * WMTS 图层示例（OGC 标准瓦片服务）
   * 替换 url / layer / tileMatrixSet 为你自己的 WMTS 服务即可
   */
  function addWmtsLayer() {
    wmtsLayer = new WMTSLayer(
      gis,
      {
        url: "https://example.com/geoserver/gwc/service/wmts",
        layer: "your_workspace:your_layer",
        tileMatrixSet: "EPSG:3857",
        style: "default",
        format: "image/png",
        // 某些服务的 TileMatrix 标识带前缀：
        // tileMatrixLabel: (z) => `EPSG:3857:${z}`,
      },
      { maxCacheSize: 150 },
    );
    scene.add(wmtsLayer);
  }

  /**
   * Cesium 地形图层（quantized-mesh 格式）
   * 使用 Cesium Ion 全球地形 + Google 卫星影像贴合
   */
  function addTerrainLayer() {
    terrainLayer = new CesiumTerrainLayer(
      gis,
      {
        terrainUrl:
          "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0",
        accessToken:
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJmMGEwODI0My1kMTg0LTQ4NTktOGU2OC05M2NkMDBlYzBmNDYiLCJpZCI6MTg1NDYsImFzc2V0SWQiOjEsImFzc2V0cyI6eyIxIjp7InR5cGUiOiJURVJSQUlOIiwicHJlZml4IjoiQ2VzaXVtV29ybGRUZXJyYWluL3YxLjIiLCJleHRlbnNpb25zIjpbInRydWUsInRydWUsInRydWUiXX0sInNyYyI6IjU0OGNiZWYwLWVhY2MtNGRmYy1hZGYzLWJhNjAyZTliMDc3MyIsImlhdCI6MTc4NTE2MTAzNSwiZXhwIjoxNzg1MTY0NjM1fQ.aWTwgIkeeZXUhm0vd2H0m32ypcAkHlTlCsGPoE6ug6w",
      },
      {
        maxZoom: 13,
        maxCacheSize: 80,
        exaggeration: 1.5,
        imageryUrlTemplate: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      },
    );
    scene.add(terrainLayer);
    // 保留平面底图作为无地形区域的 fallback，地形 mesh 有高程会自然覆盖
  }

  /**
   * 3D Tiles 图层（b3dm / glTF）
   * 加载 OGC 3D Tiles 服务，SSE 驱动 LOD 调度
   */
  function add3DTilesLayer() {
    tiles3dLayer = new Tiles3DLayer(
      gis,
      { url: "http://localhost:8084/tileset.json" },
      {
        maximumScreenSpaceError: 16,
        heightOffset: 200,
        onReady: (center) => {
          // tileset 解析完成后自动飞到数据中心
          const [lng, lat] = center;
          console.log(`[Tiles3D] 飞到数据中心: lng=${lng.toFixed(5)}, lat=${lat.toFixed(5)}`);
          scene.flyTo(lng, lat, 800);
        },
      },
    );
    scene.add(tiles3dLayer);

    // 每帧驱动 SSE 遍历 + 动态加载/卸载
    scene.addFrameCallback("tiles3dUpdate", () => {
      const camera = scene.getCamera();
      if (!camera || !tiles3dLayer) return;
      tiles3dLayer.update(camera, container.clientHeight || 900);
    });
  }

  function destroy() {
    map?.dispose();
    tileLayer?.dispose();
    wmsLayer?.dispose();
    tmsLayer?.dispose();
    wmtsLayer?.dispose();
    terrainLayer?.dispose();
    tiles3dLayer?.dispose();
    scene?.removeFrameCallback("tileLayerUpdate");
    scene?.removeFrameCallback("tiles3dUpdate");
    scene?.destroy();
  }

  return {
    init,
    destroy,
    /** 获取 Map 实例（事件 + API） */
    getMap: () => map,
    addWmsLayer,
    addTmsLayer,
    addWmtsLayer,
    addTerrainLayer,
  };
}

"use client";

import { DemoPanel, type DemoProps, useMapExample } from "./ExampleShared";

const terrainUrl =
  process.env.NEXT_PUBLIC_CESIUM_TERRAIN_URL ??
  "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0";
const accessToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";

const OPTIONS = {
  layer: "terrain",
  initialView: [118.1371, 24.49, 18000],
  googleFallback: false,
  googleZoomOffset: 2,
  terrain: {
    terrainUrl,
    accessToken,
    imageryUrlTemplate: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    maxZoom: 15,
    terrainZoomOffset: 0,
    tileYOrigin: "south",
    imageryZoomOffset: 2,
    imageryMaxCanvasSize: 4096,
  },
} as const;

export default function CesiumTerrainDemo({ containerRef }: DemoProps) {
  const status = useMapExample(containerRef, OPTIONS);

  return (
    <DemoPanel
      title="Cesium quantized-mesh 地形"
      description="加载 Cesium Terrain，并叠加 Google 影像纹理和地形 LOD。"
      status={status}
    >
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
        地形服务：{terrainUrl}
        {!accessToken && "；未配置 NEXT_PUBLIC_CESIUM_ION_TOKEN，Cesium Ion 请求会返回 401"}
      </div>
    </DemoPanel>
  );
}

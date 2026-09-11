"use client";

import { DemoPanel, type DemoProps, useMapExample } from "./ExampleShared";

const OPTIONS = {
  layer: "google",
  initialView: [118.1371, 24.49, 12000],
  googleUrl: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
  three: {
    gisControllerOptions: {
      // The default 200 km limit bottoms out around z=8. Google XYZ also
      // provides global overview tiles, so this demo needs a larger range.
      maxDistance: 50_000_000,
    },
  },
  googleOptions: {
    minZoom: 1,
    maxConcurrent: 24,
    maxRequestsPerFrame: 6,
    maxQueueSize: 256,
    maxCacheSize: 240,
    maxTilesPerView: 192,
    maxLodLevels: 1,
    lodNearRadiusMultiplier: 2,
  },
} as const;

export default function GoogleTileDemo({ containerRef }: DemoProps) {
  const status = useMapExample(containerRef, OPTIONS);

  return (
    <DemoPanel
      title="Google XYZ 瓦片"
      description="使用 XYZ 模板加载 Google 影像瓦片，并根据相机视口自动调度 LOD。"
      status={status}
    >
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
        瓦片加载、缓存、父级回退和视口更新由 TileLayer 统一管理。
      </div>
    </DemoPanel>
  );
}

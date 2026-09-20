"use client";

import { createTiandituImageryLayers } from "@/lib/sources/examples/tianditu";
import { DemoPanel, type DemoProps, useMapExample } from "./ExampleShared";

const tilesetUrl = process.env.NEXT_PUBLIC_TILES3D_URL ?? "http://localhost:8084/tileset.json";

const OPTIONS = {
  layer: "tiles3d",
  initialView: [118.1371, 24.49, 1200],
  googleFallback: false,
  rasterLayers: createTiandituImageryLayers(),
  tiles3d: {
    url: tilesetUrl,
    maximumScreenSpaceError: 16,
    heightOffset: 0,
  },
} as const;

export default function PhotogrammetryDemo({ containerRef }: DemoProps) {
  const status = useMapExample(containerRef, OPTIONS);

  return (
    <DemoPanel
      title="倾斜摄影 / 3D Tiles"
      description="加载 OGC 3D Tiles，并使用天地图影像和注记作为默认底图。"
      status={status}
    >
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>Tileset：{tilesetUrl}</div>
    </DemoPanel>
  );
}

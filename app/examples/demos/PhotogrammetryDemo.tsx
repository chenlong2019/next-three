"use client";

import { DemoPanel, type DemoProps, useMapExample } from "./ExampleShared";

const tilesetUrl = process.env.NEXT_PUBLIC_TILES3D_URL ?? "http://localhost:8084/tileset.json";

const OPTIONS = {
  layer: "tiles3d",
  initialView: [118.1371, 24.49, 1200],
  googleFallback: true,
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
      description="加载 OGC 3D Tiles tileset.json，并按屏幕空间误差动态调度模型。"
      status={status}
    >
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>Tileset：{tilesetUrl}</div>
    </DemoPanel>
  );
}

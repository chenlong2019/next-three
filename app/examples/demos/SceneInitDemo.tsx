"use client";

import { DemoPanel, type DemoProps, useMapExample } from "./ExampleShared";

const OPTIONS = {
  layer: "none",
  enableHelpers: true,
  initialView: [118.1371, 24.49, 12000],
} as const;

export default function SceneInitDemo({ containerRef }: DemoProps) {
  const status = useMapExample(containerRef, OPTIONS);

  return (
    <DemoPanel
      title="场景初始化"
      description="创建 WebMercatorGIS、Scene、相机、控制器和 WebGL 渲染器。"
      status={status}
    >
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
        已启用坐标轴和地面辅助网格，可直接拖拽、缩放和旋转场景。
      </div>
    </DemoPanel>
  );
}

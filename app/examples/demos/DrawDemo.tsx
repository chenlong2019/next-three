"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createDrawDemo, type DrawDemoApi, type DrawMode } from "@/lib/sources/examples/createDraw";
import { DemoPanel, type DemoProps } from "./ExampleShared";

const MODE_LABELS: Array<{ key: DrawMode; label: string }> = [
  { key: "none", label: "浏览" },
  { key: "point", label: "点" },
  { key: "line", label: "折线" },
  { key: "polygon", label: "面" },
];

export default function DrawDemo({ containerRef }: DemoProps) {
  const apiRef = useRef<DrawDemoApi | null>(null);
  const [activeMode, setActiveMode] = useState<DrawMode>("none");
  const [status, setStatus] = useState("正在初始化场景...");
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let previewFrame: number | null = null;
    let pendingPreviewPosition: { x: number; y: number } | null = null;
    const api = createDrawDemo(container);
    apiRef.current = api;

    const updatePendingCount = () => {
      if (active) setPendingCount(api.getPendingVertexCount());
    };

    const handlePointerDown = (event: PointerEvent) => {
      const drawMode = api.getDrawMode();
      if (event.button !== 0 || drawMode === "none") return;
      const point = api.getGroundPoint(event.clientX, event.clientY);
      if (!point) return;

      event.preventDefault();
      event.stopPropagation();
      api.addVertex(point);

      // A point is completed by one click. Restore navigation immediately so
      // the map does not remain locked in drawing mode after the click.
      if (drawMode === "point") {
        api.setDrawMode("none");
        if (active) setActiveMode("none");
      }
      updatePendingCount();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drawMode = api.getDrawMode();
      if (drawMode !== "line" && drawMode !== "polygon") return;
      pendingPreviewPosition = { x: event.clientX, y: event.clientY };
      if (previewFrame !== null) return;

      previewFrame = requestAnimationFrame(() => {
        previewFrame = null;
        const position = pendingPreviewPosition;
        pendingPreviewPosition = null;
        if (!position) return;
        api.updatePreview(api.getGroundPoint(position.x, position.y));
      });
    };

    const handlePointerLeave = () => {
      pendingPreviewPosition = null;
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      previewFrame = null;
      api.updatePreview(null);
    };

    container.addEventListener("pointerdown", handlePointerDown, true);
    container.addEventListener("pointermove", handlePointerMove, true);
    container.addEventListener("pointerleave", handlePointerLeave);
    void api.init().then(
      () => {
        if (active) setStatus("场景已就绪，选择模式后点击画布绘制");
      },
      (error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`初始化失败：${message}`);
      },
    );

    return () => {
      active = false;
      container.removeEventListener("pointerdown", handlePointerDown, true);
      container.removeEventListener("pointermove", handlePointerMove, true);
      container.removeEventListener("pointerleave", handlePointerLeave);
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      api.destroy();
      apiRef.current = null;
    };
  }, [containerRef]);

  const setMode = (mode: DrawMode) => {
    setActiveMode(mode);
    apiRef.current?.setDrawMode(mode);
    setPendingCount(apiRef.current?.getPendingVertexCount() ?? 0);
  };

  const finishPolyline = () => {
    apiRef.current?.finishPolyline();
    setPendingCount(apiRef.current?.getPendingVertexCount() ?? 0);
  };

  const finishPolygon = () => {
    apiRef.current?.finishPolygon();
    setPendingCount(apiRef.current?.getPendingVertexCount() ?? 0);
  };

  const clearGraphics = () => {
    apiRef.current?.clearAllGraphics();
    setPendingCount(0);
  };

  return (
    <DemoPanel
      title="点、线、面绘制"
      description="在局部地面平面上采集点，生成点图元、折线图元和拉伸面图元。"
      status={status}
    >
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {MODE_LABELS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setMode(item.key)}
            aria-pressed={activeMode === item.key}
            style={{
              padding: "6px 12px",
              border: `1px solid ${activeMode === item.key ? "#2563eb" : "#cbd5e1"}`,
              borderRadius: 6,
              background: activeMode === item.key ? "#eff6ff" : "#fff",
              color: activeMode === item.key ? "#1d4ed8" : "#334155",
              cursor: "pointer",
            }}
          >
            {item.label}
          </button>
        ))}
        <button type="button" onClick={finishPolyline} style={buttonStyle}>
          完成折线
        </button>
        <button type="button" onClick={finishPolygon} style={buttonStyle}>
          完成面
        </button>
        <button type="button" onClick={clearGraphics} style={{ ...buttonStyle, color: "#b91c1c" }}>
          清空
        </button>
      </div>
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
        当前模式：{MODE_LABELS.find((item) => item.key === activeMode)?.label}； 待完成顶点：
        {pendingCount}
      </div>
    </DemoPanel>
  );
}

const buttonStyle: CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  background: "#fff",
  color: "#334155",
  cursor: "pointer",
};

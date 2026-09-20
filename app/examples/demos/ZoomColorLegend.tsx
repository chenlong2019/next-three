"use client";

import { useEffect, type RefObject } from "react";

export type ZoomLegendRow = {
  zoom: number;
  color: string;
  /** 本帧正选（LOD 集）瓦片数 */
  visible: number;
  /** 已加载但不在 LOD 集的兜底常驻瓦片数（底图毯/粗祖先） */
  backup: number;
  /** 实际提交绘制的瓦片数 */
  loaded: number;
  /** 该层级瓦片到相机的最近空间距离（米）；-1 表示未知 */
  minDist: number;
};

/**
 * 层级着色验证模式（`?debugColors=1`）的图例。
 *
 * 与 PerformanceHud 同样的做法：直接操作 DOM、每 500ms 刷新一次，
 * 不走 React state，避免干扰帧率测量。
 */
export function ZoomColorLegend({
  containerRef,
  getLegend,
}: {
  containerRef: RefObject<HTMLElement | null>;
  getLegend: (() => ZoomLegendRow[]) | null;
}) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !getLegend) return;

    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const box = document.createElement("div");
    box.style.cssText = [
      "position:absolute",
      "left:10px",
      "bottom:10px",
      "z-index:1000",
      "padding:8px 10px",
      "border-radius:6px",
      "background:rgba(15,23,42,0.82)",
      "color:#e2e8f0",
      "font:11px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "pointer-events:none",
      "text-shadow:0 1px 2px rgba(0,0,0,0.6)",
      "min-width:186px",
    ].join(";");
    container.appendChild(box);

    const render = (): void => {
      const rows = getLegend() ?? [];
      const title =
        '<div style="font-weight:700;margin-bottom:4px">层级着色（不绘制影像）</div>';
      if (rows.length === 0) {
        box.innerHTML = `${title}<div style="opacity:.7">等待瓦片…</div>`;
        return;
      }
      let visible = 0;
      let backup = 0;
      let loaded = 0;
      const body = rows
        .map((r) => {
          visible += r.visible;
          backup += r.backup;
          loaded += r.loaded;
          const swatch =
            `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;` +
            `background:${r.color};box-shadow:0 0 0 1px rgba(255,255,255,.45)"></span>`;
          const zoom = `<span style="display:inline-block;width:36px">z${r.zoom}</span>`;
          const dist =
            r.minDist >= 0
              ? `<span style="opacity:.6;display:inline-block;width:64px;text-align:right">${r.minDist >= 10000 ? `${(r.minDist / 1000).toFixed(1)}km` : `${r.minDist}m`}</span>`
              : "";
          const count =
            `<span style="opacity:.78">正选 ${String(r.visible).padStart(3)}` +
            `${r.backup ? ` · 兜底 ${String(r.backup).padStart(2)}` : ""}</span>`;
          return `<div style="display:flex;align-items:center;gap:6px">${swatch}${zoom}${dist}${count}</div>`;
        })
        .join("");
      box.innerHTML =
        `${title}<div style="opacity:.6;font-size:10px;margin-bottom:2px">距离 = 该层级到相机的最近空间距离（LOD 依据）</div>` +
        `${body}` +
        `<div style="margin-top:4px;opacity:.85">合计 正选 ${visible} · 兜底 ${backup} · 上屏 ${loaded}</div>` +
        `<div style="margin-top:2px;opacity:.6;font-size:10px">兜底=底图毯/粗祖先，仅在精细瓦片缺位处显色</div>`;
    };

    render();
    const timer = window.setInterval(render, 500);

    return () => {
      window.clearInterval(timer);
      box.remove();
    };
  }, [containerRef, getLegend]);

  return null;
}

"use client";

import { useEffect, type RefObject } from "react";
import type { RendererStats } from "@/lib/sources/examples/createMapExample";

/**
 * 帧率诊断悬浮层：追加到地图容器左上角，自持 rAF 循环测量真实帧间隔
 * （rAF 回调会被主线程长任务推迟，因此能反映卡顿），每 500ms 直接更新
 * DOM 文本——不走 React state，避免每帧重渲染干扰测量。
 */
export function PerformanceHud({
  containerRef,
  getRendererStats,
}: {
  containerRef: RefObject<HTMLElement | null>;
  getRendererStats?: (() => RendererStats | null) | null;
}) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const hud = document.createElement("div");
    hud.style.cssText = [
      "position:absolute",
      "top:10px",
      "left:10px",
      "z-index:1000",
      "padding:6px 10px",
      "border-radius:6px",
      "background:rgba(15,23,42,0.78)",
      "color:#e2e8f0",
      "font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "white-space:pre",
      "pointer-events:none",
      "text-shadow:0 1px 2px rgba(0,0,0,0.6)",
    ].join(";");
    container.appendChild(hud);

    let raf = 0;
    let disposed = false;
    // 滑动窗口：近 1 秒的帧间隔
    const windowMs = 1000;
    const deltas: number[] = [];
    let last = performance.now();
    let nextFlush = last + 500;

    const tick = (now: number) => {
      if (disposed) return;
      deltas.push(now - last);
      last = now;
      const cutoff = now - windowMs;
      while (deltas.length > 1 && deltas[0] < cutoff) deltas.shift();

      if (now >= nextFlush) {
        nextFlush = now + 500;
        let sum = 0;
        let max = 0;
        for (const d of deltas) {
          sum += d;
          if (d > max) max = d;
        }
        const frames = Math.max(deltas.length, 1);
        const fps = (frames * 1000) / Math.max(sum, 1);
        const avgMs = sum / frames;
        const color = fps >= 50 ? "#4ade80" : fps >= 30 ? "#facc15" : "#f87171";
        let text =
          `FPS ${fps.toFixed(0)}  帧 ${avgMs.toFixed(1)}ms 峰值 ${max.toFixed(0)}ms`;
        const stats = getRendererStats?.() ?? null;
        if (stats) {
          text +=
            `\n绘制 ${stats.calls}  三角 ${(stats.triangles / 1000).toFixed(0)}k` +
            `\n几何 ${stats.geometries}  纹理 ${stats.textures}` +
            (stats.revealPending > 0 ? `\n入场候场 ${stats.revealPending} 块` : "") +
            (stats.fastZoom ? "\n快跳 只渲染最高/最底层" : "");
        }
        hud.textContent = text;
        hud.style.color = color;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      hud.remove();
    };
  }, [containerRef, getRendererStats]);

  return null;
}

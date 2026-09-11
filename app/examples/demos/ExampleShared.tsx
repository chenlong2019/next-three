"use client";

import { useEffect, useState } from "react";
import type { ReactNode, RefObject } from "react";
import {
  createMapExample,
  type MapExampleApi,
  type MapExampleOptions,
} from "@/lib/sources/examples/createMapExample";

export interface DemoProps {
  containerRef: RefObject<HTMLDivElement | null>;
}

export interface MapExampleRuntime {
  status: string;
  api: MapExampleApi | null;
}

export function useMapExampleRuntime(
  containerRef: DemoProps["containerRef"],
  options: MapExampleOptions,
): MapExampleRuntime {
  const [status, setStatus] = useState("正在初始化场景...");
  const [api, setApi] = useState<MapExampleApi | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setStatus("等待场景容器...");
      setApi(null);
      return;
    }

    let active = true;
    const api = createMapExample(container, options);
    setApi(api);
    setStatus("正在初始化场景...");

    void api.init().then(
      () => {
        if (active) setStatus("场景已就绪");
      },
      (error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`初始化失败：${message}`);
      },
    );

    return () => {
      active = false;
      api.destroy();
    };
  }, [containerRef, options]);

  return { status, api };
}

export function useMapExample(
  containerRef: DemoProps["containerRef"],
  options: MapExampleOptions,
): string {
  return useMapExampleRuntime(containerRef, options).status;
}

export function DemoPanel({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description: string;
  status?: string;
  children?: ReactNode;
}) {
  return (
    <section
      style={{
        flexShrink: 0,
        padding: "12px 14px",
        border: "1px solid #dbe3ef",
        borderRadius: 8,
        background: "rgba(255, 255, 255, 0.96)",
        color: "#1f2937",
        boxShadow: "0 4px 16px rgba(15, 23, 42, 0.08)",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
      <div style={{ marginTop: 4, color: "#64748b", fontSize: 13 }}>{description}</div>
      {status && (
        <div role="status" style={{ marginTop: 8, color: "#2563eb", fontSize: 12 }}>
          {status}
        </div>
      )}
      {children}
    </section>
  );
}

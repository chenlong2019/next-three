"use client";

import { useEffect, useState } from "react";
import { DemoPanel, type DemoProps, useMapExampleRuntime } from "./ExampleShared";

const TIANDITU_TOKEN = process.env.NEXT_PUBLIC_TIANDITU_TOKEN || "beebc386dc7a77428060ef9423009ed7";
const TIANDITU_SUBDOMAINS = Array.from({ length: 8 }, (_, index) => String(index));

function tiandituUrl(type: "vec_w" | "img_w" | "cva_w" | "cia_w"): string {
  return `https://t{s}.tianditu.gov.cn/DataServer?T=${type}&x={x}&y={y}&l={z}&tk=${TIANDITU_TOKEN}`;
}

const TIANDITU_OPTIONS = {
  minZoom: 1,
  maxZoom: 18,
  maxConcurrent: 8,
  maxRequestsPerFrame: 3,
  maxQueueSize: 192,
  maxCacheSize: 180,
  maxTilesPerView: 160,
  maxLodLevels: 2,
  lodNearRadiusMultiplier: 1.5,
  subdomains: TIANDITU_SUBDOMAINS,
} as const;

const OPTIONS = {
  layer: "none",
  initialView: [118.1371, 24.49, 12000],
  three: {
    gisControllerOptions: {
      maxDistance: 50_000_000,
    },
  },
  rasterLayers: [
    {
      id: "tianditu-vector",
      url: tiandituUrl("vec_w"),
      enabled: true,
      options: {
        ...TIANDITU_OPTIONS,
        altitude: 0,
      },
    },
    {
      id: "tianditu-imagery",
      url: tiandituUrl("img_w"),
      enabled: false,
      options: {
        ...TIANDITU_OPTIONS,
        altitude: 0,
      },
    },
    {
      id: "google-imagery",
      url: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      enabled: false,
      options: {
        minZoom: 1,
        maxConcurrent: 24,
        maxRequestsPerFrame: 6,
        maxQueueSize: 256,
        maxCacheSize: 240,
        maxTilesPerView: 192,
        maxLodLevels: 1,
        lodNearRadiusMultiplier: 2,
        altitude: 0,
      },
    },
    {
      id: "tianditu-vector-annotation",
      url: tiandituUrl("cva_w"),
      enabled: true,
      options: {
        ...TIANDITU_OPTIONS,
        altitude: 100,
        transparent: true,
        maxCacheSize: 120,
        maxConcurrent: 6,
      },
    },
    {
      id: "tianditu-imagery-annotation",
      url: tiandituUrl("cia_w"),
      enabled: false,
      options: {
        ...TIANDITU_OPTIONS,
        altitude: 100,
        transparent: true,
        maxCacheSize: 120,
        maxConcurrent: 6,
      },
    },
  ],
} as const;

type BaseMapId = "tianditu-vector" | "tianditu-imagery" | "google-imagery";

export default function GoogleTileDemo({ containerRef }: DemoProps) {
  const { status, api } = useMapExampleRuntime(containerRef, OPTIONS);
  const [baseMap, setBaseMap] = useState<BaseMapId>("tianditu-vector");
  const [showAnnotations, setShowAnnotations] = useState(true);

  useEffect(() => {
    if (!api) return;
    api.setRasterLayerEnabled("tianditu-vector", baseMap === "tianditu-vector");
    api.setRasterLayerEnabled("tianditu-imagery", baseMap === "tianditu-imagery");
    api.setRasterLayerEnabled("google-imagery", baseMap === "google-imagery");
    api.setRasterLayerEnabled(
      "tianditu-vector-annotation",
      showAnnotations && baseMap === "tianditu-vector",
    );
    api.setRasterLayerEnabled(
      "tianditu-imagery-annotation",
      showAnnotations && baseMap === "tianditu-imagery",
    );
  }, [api, baseMap, showAnnotations]);

  return (
    <DemoPanel
      title="多源 XYZ 瓦片"
      description="加载天地图矢量、影像和注记瓦片，也可切换到 Google 影像底图。"
      status={status}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "12px 18px",
          marginTop: 10,
          color: "#334155",
          fontSize: 12,
        }}
      >
        <label style={{ display: "grid", gap: 4 }}>
          底图
          <select
            value={baseMap}
            onChange={(event) => setBaseMap(event.target.value as BaseMapId)}
            style={{ minWidth: 132, padding: "5px 8px" }}
          >
            <option value="tianditu-vector">天地图矢量</option>
            <option value="tianditu-imagery">天地图影像</option>
            <option value="google-imagery">Google 影像</option>
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={showAnnotations && baseMap !== "google-imagery"}
            disabled={baseMap === "google-imagery"}
            onChange={(event) => setShowAnnotations(event.target.checked)}
          />
          天地图注记
        </label>
        <span style={{ color: "#64748b" }}>数据来源：天地图</span>
      </div>
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
        矢量、影像、注记使用独立图层，缓存、父级回退和请求并发由 TileLayer 统一管理。
      </div>
    </DemoPanel>
  );
}

"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createTiandituLayer } from "@/lib/sources/examples/tianditu";
import { DemoPanel, type DemoProps, useMapExampleRuntime } from "./ExampleShared";
import styles from "./GoogleTileDemo.module.css";

const OPTIONS = {
  layer: "none",
  initialView: [118.1371, 24.49, 12000],
  three: {
    gisControllerOptions: {
      maxDistance: 50_000_000,
    },
  },
  rasterLayers: [
    createTiandituLayer({
      id: "tianditu-vector",
      type: "vec_w",
    }),
    createTiandituLayer({
      id: "tianditu-imagery",
      type: "img_w",
      enabled: false,
    }),
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
    createTiandituLayer({
      id: "tianditu-vector-annotation",
      type: "cva_w",
      altitude: 1,
    }),
    createTiandituLayer({
      id: "tianditu-imagery-annotation",
      type: "cia_w",
      enabled: false,
      altitude: 1,
    }),
  ],
} as const;

type BaseMapId = "tianditu-vector" | "tianditu-imagery" | "google-imagery";

export default function GoogleTileDemo({ containerRef }: DemoProps) {
  const { status, api } = useMapExampleRuntime(containerRef, OPTIONS);
  const [mapContainer, setMapContainer] = useState<HTMLDivElement | null>(null);
  const [baseMap, setBaseMap] = useState<BaseMapId>("tianditu-vector");
  const [showAnnotations, setShowAnnotations] = useState(true);

  useEffect(() => {
    setMapContainer(containerRef.current);
  }, [containerRef]);

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

  const layerControls = (
    <section className={styles.layerSwitcher} aria-label="地图图层切换">
      <label className={styles.control}>
        底图
        <select
          className={styles.select}
          value={baseMap}
          onChange={(event) => setBaseMap(event.target.value as BaseMapId)}
        >
          <option value="tianditu-vector">天地图矢量</option>
          <option value="tianditu-imagery">天地图影像</option>
          <option value="google-imagery">Google 影像</option>
        </select>
      </label>
      <label className={styles.control}>
        <input
          type="checkbox"
          checked={showAnnotations && baseMap !== "google-imagery"}
          disabled={baseMap === "google-imagery"}
          onChange={(event) => setShowAnnotations(event.target.checked)}
        />
        天地图注记
      </label>
      <span className={styles.credit}>© 天地图</span>
    </section>
  );

  return (
    <>
      {mapContainer && createPortal(layerControls, mapContainer)}
      <DemoPanel
        title="多源 XYZ 瓦片"
        description="在地图内切换天地图矢量、影像、注记和 Google 影像底图。"
        status={status}
      >
        <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
          矢量、影像、注记使用独立图层，缓存、父级回退和请求并发由 TileLayer 统一管理。
        </div>
      </DemoPanel>
    </>
  );
}

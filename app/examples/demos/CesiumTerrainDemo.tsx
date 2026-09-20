"use client";

import { useMemo } from "react";
import {
  DemoPanel,
  type DemoProps,
  useMapExampleRuntime,
} from "./ExampleShared";
import { PerformanceHud } from "./PerformanceHud";
import { ZoomColorLegend } from "./ZoomColorLegend";
import {
  DEFAULT_GOOGLE_URL,
  type MapExampleOptions,
} from "@/lib/sources/examples/createMapExample";

const terrainUrl =
  process.env.NEXT_PUBLIC_CESIUM_TERRAIN_URL ??
  "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0";
const accessToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "";
// Google 卫星混合图层（mt0~mt3 子域名）；总控并发组 "google" 与其它
// Google 图层共享，避免同一时间请求过多
const imageryUrlTemplate = DEFAULT_GOOGLE_URL;
const GOOGLE_SUBDOMAINS = ["0", "1", "2", "3"] as const;
const GOOGLE_REQUEST_GROUP = "google";
const GOOGLE_MAX_CONCURRENT = 12;

const OPTIONS = {
  layer: "terrain",
  initialView: [118.1371, 24.49, 18000],
  googleFallback: false,
  three: {
    cameraFov: 60,
  },
  terrain: {
    terrainUrl,
    accessToken,
    imageryUrlTemplate,
    imagerySubdomains: GOOGLE_SUBDOMAINS,
    imageryRequestGroup: GOOGLE_REQUEST_GROUP,
    imageryMaximumRequestsPerServer: GOOGLE_MAX_CONCURRENT,
    // 地形并发：几何构建已在 Worker 中完成，主线程只做零拷贝组装，
    // 因此可以放宽到 10（调度器每服务器上限同步放宽，否则会被压回 6）
    maxConcurrent: 10,
    maximumRequestsPerServer: 10,
    maxQueueSize: 160,
    maxRequestsPerFrame: 8,
    maxTileRendersPerFrame: 4,
    maxZoom: 15,
    maxTilesPerView: 128,
    // 内存 LRU 保留更多已加载瓦片，回头看旧区域时不必重下
    maxCacheSize: 256,
    terrainTilePixelSize: 512,
    maximumScreenSpaceError: 4,
    exaggeration: 1,
    terrainZoomOffset: 0,
    tileYOrigin: "south",
    imageryZoomOffset: 0,
    // 2048 已能覆盖一个地形瓦片的屏幕尺寸，4096 会让单块纹理内存
    // 与影像子请求数翻 4 倍，性价比很低
    imageryMaxCanvasSize: 2048,
    // 空闲时预取下一级地形字节进持久化缓存，缩放进来时省一次网络往返
    prefetchTileBudget: 16,
    // 影像瓦片「入场节拍」：就绪后不立即上屏，按节拍依次亮起（还原 Cesium
    // 那种一片片铺开的观感）。一整批约在 420ms 内出清；调小=清晰更快但更急，
    // 调大=更平缓但更晚看清，设 0=关闭节拍（就绪即上屏）。
    revealSpreadMs: 420,
    // 单块入场间隔上限：队列很短时也不必等太久
    revealMaxSlotMs: 60,
    // 候场超过该时长强制优先入场，保证节拍不拖慢可见清晰度
    revealMaxWaitMs: 400,
    // 同一帧最多放行块数：低帧率时补偿节拍，避免队列排不空
    revealMaxPerFrame: 4,
    // 手势（拖拽/缩放）期间每次视图更新放行的影像升级块数：0 = 手势内完全冻结，
    // 调大可让交互中更清晰，代价是带宽与主线程画布重建更吃紧
    imageryInteractingBudget: 2,
    wireframe: false,
  },
} as const;

/** 读取 `?flag=1|true` 形式的布尔开关（客户端渲染时求值）。 */
function readBooleanParam(name: string): boolean {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get(name);
  return value === "1" || value === "true";
}

export default function CesiumTerrainDemo({ containerRef }: DemoProps) {
  const options = useMemo<MapExampleOptions>(() => {
    // ?debugColors=1：层级着色验证模式——不绘制影像，瓦片按层级着纯色，
    // 一眼可判"某片区域实际由哪一级瓦片绘制、有没有粗层级兜底没被替换"。
    const debugColors = readBooleanParam("debugColors");
    return {
      ...OPTIONS,
      terrain: {
        ...OPTIONS.terrain,
        debugColorByZoom: debugColors,
        // ?wireframe=1：叠加三角网，检查网格密度与缺口
        wireframe: readBooleanParam("wireframe") || OPTIONS.terrain.wireframe,
      },
    };
  }, []);
  const { status, api } = useMapExampleRuntime(containerRef, options);
  const debugColors = options.terrain?.debugColorByZoom === true;

  return (
    <>
      <PerformanceHud
        containerRef={containerRef}
        getRendererStats={api ? () => api.getRendererStats() : null}
      />
      {debugColors && (
        <ZoomColorLegend
          containerRef={containerRef}
          getLegend={api ? () => api.getTerrainZoomLegend() : null}
        />
      )}
      <DemoPanel
      title="Cesium quantized-mesh 地形"
      description="同时显示 Google 卫星影像纹理和 Cesium Terrain 三角网，用于检查贴合与 LOD。"
      status={status}
    >
      <div style={{ marginTop: 8, color: "#475569", fontSize: 12 }}>
        地形服务：{terrainUrl}
        {!accessToken && "；未配置 NEXT_PUBLIC_CESIUM_ION_TOKEN，Cesium Ion 请求会返回 401"}
      </div>
      <div style={{ marginTop: 4, color: "#475569", fontSize: 12 }}>
        层级着色验证：在地址后加 <code>?debugColors=1</code>（不画影像，按层级着纯色）；
        加 <code>?wireframe=1</code> 叠加三角网。
      </div>
    </DemoPanel>
    </>
  );
}

"use client";

import * as THREE from "three";
import type { MapExampleOptions } from "@/lib/sources/examples/createMapExample";
import { withBasePath } from "@/lib/site";
import { DemoPanel, type DemoProps, useMapExample } from "./ExampleShared";

const TILESET_URL =
  process.env.NEXT_PUBLIC_XIAMEN_BUILDINGS_URL ??
  withBasePath("/models/xiamen-buildings/tileset.json");
const ROAD_URL = withBasePath("/data/xiamen/roads.geojson");
const WATER_URL = withBasePath("/data/xiamen/water.geojson");
const RAILWAY_URL = withBasePath("/data/xiamen/railway.geojson");

const DATA_CENTER = [118.1395095, 24.4997611] as const;

const OPTIONS = {
  layer: "tiles3d",
  origin: DATA_CENTER,
  initialView: [DATA_CENTER[0], DATA_CENTER[1], 22000],
  googleFallback: true,
  three: {
    backgroundColor: 0x020711,
    toneMappingExposure: 0.8,
    postprocessing: {
      bloom: {
        strength: 0.2,
        radius: 0.14,
        threshold: 1,
      },
    },
    gisControllerOptions: {
      maxPolarAngle: THREE.MathUtils.degToRad(82),
    },
  },
  googleOptions: {
    color: 0x38565f,
    opacity: 1,
  },
  geojson: {
    water: {
      url: WATER_URL,
      altitude: 0.9,
      waterStyle: {
        fillColor: 0x053647,
        deepColor: 0x032b3d,
        surfaceColor: 0x0b6878,
        highlightColor: 0x8ceaf0,
        fillOpacity: 0.74,
        edgeColor: 0x2cc9d6,
        edgeWidth: 1.2,
        edgeOpacity: 0.68,
        glowWidth: 4,
        glowOpacity: 0.13,
        rippleScale: 0.0016,
        rippleStrength: 0.08,
        fresnelStrength: 0.42,
        specularStrength: 0.16,
        specularPower: 42,
        waveSpeed: 0.9,
      },
    },
    roads: {
      url: ROAD_URL,
      altitude: 2.5,
      roadStyle: {
        majorColor: 0xff9d45,
        majorWidth: 1.45,
        majorOpacity: 0.98,
        majorGlowWidth: 5.5,
        majorGlowOpacity: 0.24,
        majorFlowColor: 0xfff1c2,
        majorFlowWidth: 1.05,
        majorFlowOpacity: 0.94,
        majorFlowDashSize: 80,
        majorFlowGapSize: 220,
        majorFlowSpeed: 95,
        localColor: 0x0fc7d4,
        localWidth: 0.65,
        localOpacity: 0.52,
        localGlowWidth: 2.5,
        localGlowOpacity: 0.12,
      },
    },
    railways: {
      url: RAILWAY_URL,
      altitude: 3.6,
      railwayStyle: {
        railColor: 0xd4f57a,
        railWidth: 1.65,
        railOpacity: 0.94,
        railGlowColor: 0x8fd84c,
        railGlowWidth: 5,
        railGlowOpacity: 0.14,
        detailColor: 0xf7ffe2,
        detailWidth: 0.78,
        detailOpacity: 0.9,
        detailDashSize: 7,
        detailGapSize: 13,
        detailSpeed: 10,
        subwayColor: 0xb9a1ff,
        subwayWidth: 1.05,
        subwayOpacity: 0.48,
        subwayDashSize: 11,
        subwayGapSize: 20,
      },
    },
  },
  onReady: (scene) => {
    if (scene.scene) {
      scene.scene.fog = new THREE.FogExp2(0x020711, 0.000018);
    }
  },
  tiles3d: {
    url: TILESET_URL,
    maximumScreenSpaceError: 12,
    maxConcurrent: 10,
    maxRequestsPerFrame: 4,
    maxCacheSize: 64,
    enableFrustumCulling: false,
    heightOffset: 0,
    style: {
      bottomColor: 0x006074,
      topColor: 0x00c4dc,
      accentColor: 0xff7a1a,
      opacity: 1,
      heightScale: 3,
      lowAngleHeightBoost: 1.7,
      emissiveIntensity: 0.9,
      topViewRoofStrength: 0.58,
      floorLineSpacing: 4.2,
      floorLineStrength: 0.08,
      scanStrength: 0.18,
      scanSpeed: 0.065,
      edgeColor: 0x12f3ff,
      edgeWidth: 0.58,
      edgeOpacity: 0.52,
      edgeIntensity: 0.78,
      roofEdgeColor: 0x35f7ff,
      roofEdgeWidth: 0.78,
      roofEdgeOpacity: 0.7,
      roofEdgeIntensity: 0.9,
      edgeThresholdAngle: 24,
    },
    onReady: (scene, gis, center, allowAutoFrame) => {
      if (!allowAutoFrame) return;
      const target = gis.lngLatToThree(center[0], center[1], 50);
      const camera = scene.getCamera();
      const controller = scene.getGISController();
      if (!camera || !controller) return;

      const viewScale = THREE.MathUtils.clamp(1 / camera.aspect, 0.9, 1.4);
      camera.position
        .copy(target)
        .add(new THREE.Vector3(8500, -11750, 10200).multiplyScalar(viewScale));
      controller.controls.target.copy(target);
      controller.controls.update();
    },
  },
} satisfies MapExampleOptions;

export default function BuildingTilesDemo({ containerRef }: DemoProps) {
  const status = useMapExample(containerRef, OPTIONS);

  return (
    <DemoPanel title="厦门建筑 3D Tiles" description="厦门岛全部建筑夜景可视化。" status={status}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "4px 18px",
          marginTop: 8,
          color: "#475569",
          fontSize: 12,
        }}
      >
        <span>范围：约 19.8 × 16.9 km</span>
        <span>建筑：4,589</span>
        <span>瓦片：49</span>
        <span>三角形：92,794</span>
        <span>Tileset：{TILESET_URL}</span>
      </div>
    </DemoPanel>
  );
}

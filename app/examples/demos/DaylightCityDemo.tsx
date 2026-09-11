"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import type { Scene } from "@/lib/sources/core/Scene";
import { createMapExample } from "@/lib/sources/examples/createMapExample";
import type { DemoProps } from "./ExampleShared";
import styles from "./DaylightCityDemo.module.css";

const ORIGIN = [118.1395095, 24.4997611] as const;
const VIEWS = {
  lakeside: { label: "湖畔街区", center: [118.1505, 24.5], offset: [1000, -1400, 1100] },
  yundang: { label: "筼筜湖", center: [118.107, 24.48], offset: [1400, -1900, 1500] },
  island: { label: "全岛", center: ORIGIN, offset: [8200, -10500, 7500] },
} as const;
type ViewKey = keyof typeof VIEWS;

function applyView(scene: Scene, key: ViewKey): void {
  const gis = scene.getGIS();
  const camera = scene.getCamera();
  const controls = scene.getGISController()?.controls;
  if (!gis || !camera || !controls) return;
  const view = VIEWS[key];
  const target = gis.lngLatToThree(view.center[0], view.center[1], 15);
  const scale = THREE.MathUtils.clamp(1 / camera.aspect, 1, 1.8);
  controls.target.copy(target);
  camera.position.copy(target).add(new THREE.Vector3(...view.offset).multiplyScalar(scale));
  controls.update();
}

function setSceneShadows(scene: Scene | null, enabled: boolean): void {
  if (scene?.renderer) scene.renderer.shadowMap.enabled = enabled;
}

export default function DaylightCityDemo({ containerRef }: DemoProps) {
  const sceneRef = useRef<Scene | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("正在初始化...");
  const [view, setView] = useState<ViewKey>("lakeside");
  const [orbit, setOrbit] = useState(false);
  const [shadows, setShadows] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    let sun: THREE.DirectionalLight | null = null;
    const api = createMapExample(container, {
      layer: "tiles3d",
      origin: ORIGIN,
      initialView: [118.1505, 24.5, 2200],
      googleUrl: "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      googleOptions: { color: 0xbfc7c3, maxCacheSize: 240 },
      three: {
        backgroundColor: 0xbec9c7,
        gisControllerOptions: { maxPolarAngle: THREE.MathUtils.degToRad(78) },
      },
      tiles3d: {
        url:
          process.env.NEXT_PUBLIC_XIAMEN_BUILDINGS_URL ?? "/models/xiamen-buildings/tileset.json",
        maximumScreenSpaceError: 10,
        maxCacheSize: 64,
        maxConcurrent: 8,
        enableFrustumCulling: false,
        style: {
          appearance: "daylight",
          heightScale: 1,
          daylight: {
            wallColor: 0xd4d6d3,
            roofColor: 0xc1c5c1,
            windowColor: 0x4b5b60,
            glassColor: 0x536b7b,
            glassHeight: 85,
            windowSpacing: 3.2,
            floorHeight: 3.6,
          },
        },
        onReady: (scene, _gis, _center, allowAutoFrame) => {
          if (allowAutoFrame) applyView(scene, "lakeside");
        },
      },
      geojson: {
        water: {
          url: "/data/xiamen/water.geojson",
          altitude: 0.8,
          waterStyle: {
            deepColor: 0x8b9f90,
            surfaceColor: 0xa8b4a4,
            highlightColor: 0xe2e7e0,
            fillOpacity: 0.88,
            edgeColor: 0xb4bfb2,
            edgeWidth: 0.7,
            edgeOpacity: 0.3,
            glowWidth: 0,
            rippleStrength: 0.06,
            rippleScale: 0.018,
            fresnelStrength: 0.25,
            specularStrength: 0.12,
            waveSpeed: 0.65,
          },
        },
      },
      onReady: (scene) => {
        if (!active || !scene.scene || !scene.renderer || !scene.camera) return;
        sceneRef.current = scene;
        scene.camera.fov = 45;
        scene.camera.updateProjectionMatrix();
        scene.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        scene.renderer.toneMappingExposure = 0.85;
        scene.scene.fog = new THREE.Fog(0xbec9c7, 3500, 19000);
        scene.scene.add(new THREE.HemisphereLight(0xe3eff5, 0x747b66, 2));
        sun = new THREE.DirectionalLight(0xfff3dc, 2.6);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, {
          left: -2600,
          right: 2600,
          top: 2600,
          bottom: -2600,
          near: 100,
          far: 12000,
        });
        sun.shadow.normalBias = 1.2;
        sun.shadow.bias = -0.0002;
        scene.scene.add(sun, sun.target);

        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(180000, 180000),
          new THREE.MeshBasicMaterial({ color: 0x747e71 }),
        );
        ground.position.z = -0.2;
        ground.name = "Daylight ground fallback";
        const shadow = new THREE.Mesh(
          new THREE.PlaneGeometry(180000, 180000),
          new THREE.ShadowMaterial({ opacity: 0.26, depthWrite: false }),
        );
        shadow.name = "Daylight ground shadows";
        shadow.position.z = 0.06;
        shadow.receiveShadow = true;
        scene.scene.add(ground, shadow);
        const sunOffset = new THREE.Vector3(-2200, -1800, 3800);
        scene.addFrameCallback("daylight-sun", () => {
          const target = scene.getGISController()?.controls.target;
          if (!sun || !target) return;
          sun.target.position.copy(target);
          sun.position.copy(target).add(sunOffset);
        });
        applyView(scene, "lakeside");
      },
    });

    void api
      .init()
      .then(() => {
        if (!active) return;
        setPortalTarget(container);
        setStatus("日景");
      })
      .catch((error: unknown) => {
        if (active) setStatus(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
      sceneRef.current?.removeFrameCallback("daylight-sun");
      api.destroy();
      sun?.dispose();
      sceneRef.current = null;
    };
  }, [containerRef]);

  return (
    <>
      {portalTarget &&
        createPortal(
          <div className={styles.overlay}>
            <div className={styles.location}>
              XIAMEN <span>/ 厦门</span>
            </div>
            <div className={styles.caption}>
              <h1>厦门 · 城市肌理</h1>
              <p>{VIEWS[view].label} / URBAN LANDSCAPE</p>
            </div>
            <div className={styles.credit}>建筑：本地 GeoJSON · 影像 © Google</div>
          </div>,
          portalTarget,
        )}
      <section className={styles.toolbar} aria-label="日景场景设置">
        <label>
          视角
          <select
            value={view}
            disabled={!portalTarget}
            onChange={(event) => {
              const key = event.target.value as ViewKey;
              setView(key);
              if (sceneRef.current) applyView(sceneRef.current, key);
            }}
          >
            {Object.entries(VIEWS).map(([key, preset]) => (
              <option value={key} key={key}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={orbit}
            disabled={!portalTarget}
            onChange={(event) => {
              setOrbit(event.target.checked);
              const controls = sceneRef.current?.getGISController()?.controls;
              if (controls) {
                controls.autoRotateSpeed = 0.22;
                controls.autoRotate = event.target.checked;
              }
            }}
          />
          自动环绕
        </label>
        <label>
          <input
            type="checkbox"
            checked={shadows}
            disabled={!portalTarget}
            onChange={(event) => {
              setShadows(event.target.checked);
              setSceneShadows(sceneRef.current, event.target.checked);
            }}
          />
          阴影
        </label>
        <span className={styles.status} role="status">
          {status}
        </span>
      </section>
    </>
  );
}

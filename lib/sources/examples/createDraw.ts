import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Scene } from "../core/Scene";
import { createMapExample, type MapExampleApi } from "./createMapExample";
import { createTiandituImageryLayers } from "./tianditu";
import { PolylinePrimitive } from "../engine/primitives/PolylinePrimitive";
import { PolygonPrimitive } from "../engine/primitives/PolygonPrimitive";
import { SpherePrimitive } from "../engine/primitives/SpherePrimitive";

export type DrawMode = "point" | "line" | "polygon" | "none";

export interface DrawDemoOptions {
  origin?: readonly [number, number];
  initialView?: readonly [number, number, number];
  googleUrl?: string;
  surfaceAltitude?: number;
}

const DRAW_RENDER_ORDER = 100;
const DRAW_POINT_RADIUS = 64;

type DynamicLineGeometry = LineGeometry & {
  _maxInstanceCount?: number;
};

function setPreviewLinePositions(line: Line2, points: THREE.Vector3[]): void {
  const geometry = line.geometry as DynamicLineGeometry;
  geometry.setPositions(points.flatMap((point) => [point.x, point.y, point.z]));
  geometry.instanceCount = points.length - 1;

  // Line2 caches the initial segment capacity after its first render. The
  // preview grows dynamically, so force the renderer to derive it again.
  delete geometry._maxInstanceCount;
  line.computeLineDistances();
}

function configureOverlayObject(object: THREE.Object3D): void {
  object.renderOrder = DRAW_RENDER_ORDER;
  object.traverse((child) => {
    if (!(
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.Points
    )) {
      return;
    }

    child.renderOrder = DRAW_RENDER_ORDER;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      material.depthTest = false;
      material.depthWrite = false;
      material.needsUpdate = true;
    }
  });
}

export function createDrawDemo(container: HTMLDivElement, options: DrawDemoOptions = {}) {
  const surfaceAltitude = options.surfaceAltitude ?? 0;
  if (!Number.isFinite(surfaceAltitude)) {
    throw new TypeError("surfaceAltitude must be a finite number.");
  }
  let scene: Scene | null = null;
  let mapApi: MapExampleApi | null = null;
  let previewLine: Line2 | null = null;
  let previewVertices: THREE.Points | null = null;
  let previewPoint: THREE.Vector3 | null = null;

  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const pickPoint = new THREE.Vector3();
  const drawPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -surfaceAltitude);

  function createPreviewObjects(): void {
    if (!scene?.scene || previewLine || previewVertices) return;

    const material = new LineMaterial({
      color: 0x22d3ee,
      linewidth: 2,
      worldUnits: false,
      transparent: true,
      opacity: 0.95,
      alphaToCoverage: true,
    });
    previewLine = new Line2(new LineGeometry(), material);
    previewLine.onBeforeRender = (renderer) => {
      renderer.getSize(material.resolution);
    };
    previewLine.frustumCulled = false;
    previewLine.visible = false;
    configureOverlayObject(previewLine);
    scene.scene.add(previewLine);

    previewVertices = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 8,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
      }),
    );
    previewVertices.frustumCulled = false;
    previewVertices.visible = false;
    configureOverlayObject(previewVertices);
    scene.scene.add(previewVertices);
  }

  function updatePreviewGeometry(): void {
    if (drawMode !== "line" && drawMode !== "polygon") return;
    createPreviewObjects();
    if (!previewLine || !previewVertices) return;

    const linePoints = [...tempPoints];
    if (previewPoint && tempPoints.length > 0) {
      linePoints.push(previewPoint);
    }
    if (drawMode === "polygon" && linePoints.length > 2) {
      linePoints.push(tempPoints[0]);
    }

    if (linePoints.length > 1) {
      setPreviewLinePositions(previewLine, linePoints);
      previewLine.visible = true;
    } else {
      previewLine.visible = false;
    }
    previewVertices.geometry.setFromPoints(tempPoints);
    previewVertices.visible = tempPoints.length > 0;
  }

  function clearPreviewGeometry(): void {
    previewPoint = null;
    if (previewLine) {
      previewLine.visible = false;
    }
    if (previewVertices) {
      previewVertices.geometry.setFromPoints([]);
      previewVertices.visible = false;
    }
  }

  function removePreviewObjects(): void {
    previewLine?.removeFromParent();
    previewLine?.geometry.dispose();
    (previewLine?.material as THREE.Material | undefined)?.dispose();
    previewLine = null;

    previewVertices?.removeFromParent();
    previewVertices?.geometry.dispose();
    (previewVertices?.material as THREE.Material | undefined)?.dispose();
    previewVertices = null;
    previewPoint = null;
  }

  async function init() {
    mapApi = createMapExample(container, {
      // Drawing starts on the Tianditu imagery and annotation layers by default.
      layer: "none",
      rasterLayers: options.googleUrl
        ? [{ id: "custom-raster", url: options.googleUrl, enabled: true }]
        : createTiandituImageryLayers(),
      origin: options.origin ?? [118.1371, 24.49],
      initialView: options.initialView ?? [118.1371, 24.49, 8000],
      surfaceAltitude,
      enableHelpers: true,
      onReady: (readyScene) => {
        scene = readyScene;
      },
    });
    await mapApi.init();
    if (!scene?.scene) return;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(20, 30, 20);
    scene.scene.add(dirLight);

    // 基础光照
    // 地面参考平面
    // const groundMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
    // const groundBox = new BoxPrimitive({ size: new THREE.Vector3(60, 1, 60) });
    // groundBox.setMaterial(groundMat);
    // scene.primitives.add(groundBox);
  }

  function destroy() {
    removePreviewObjects();
    mapApi?.destroy();
    mapApi = null;
    scene = null;
  }

  // ===================== 绘制API =====================
  let drawMode: DrawMode = "none";
  const tempPoints: THREE.Vector3[] = [];

  function addOverlayPrimitive(
    primitive: SpherePrimitive | PolylinePrimitive | PolygonPrimitive,
  ): void {
    if (!scene) return;

    scene.primitives.add(primitive);
    if (primitive.object) configureOverlayObject(primitive.object);
  }

  function setDrawMode(mode: DrawMode) {
    drawMode = mode;
    tempPoints.length = 0;
    clearPreviewGeometry();
    if (mode === "line" || mode === "polygon") {
      createPreviewObjects();
    }
    const controls = scene?.getGISController()?.controls;
    if (controls) controls.enabled = mode === "none";
  }

  /** 新增顶点（外部传入拾取坐标） */
  function addVertex(pos: THREE.Vector3) {
    if (drawMode === "point") {
      if (!scene) return;
      const position = pos.clone();
      position.z += DRAW_POINT_RADIUS;
      const point = new SpherePrimitive({
        position,
        style: { color: "#ffcc00", radius: DRAW_POINT_RADIUS },
      });
      addOverlayPrimitive(point);
    } else if (drawMode === "line" || drawMode === "polygon") {
      tempPoints.push(pos.clone());
      previewPoint = pos.clone();
      updatePreviewGeometry();
    }
  }

  function updatePreview(pos: THREE.Vector3 | null): void {
    if (drawMode !== "line" && drawMode !== "polygon") return;
    previewPoint = pos?.clone() ?? null;
    updatePreviewGeometry();
  }

  /** 完成折线 */
  function finishPolyline() {
    if (tempPoints.length < 2) return;
    if (!scene) return;
    const line = new PolylinePrimitive({
      points: [...tempPoints],
      style: { color: "#22c55e", lineWidth: 3 },
    });
    addOverlayPrimitive(line);
    tempPoints.length = 0;
    clearPreviewGeometry();
  }

  /** 完成多边形 */
  function finishPolygon() {
    if (tempPoints.length < 3) return;
    if (!scene) return;
    const polygon = new PolygonPrimitive({
      points: [...tempPoints],
      style: { color: "#3b82f6", depth: 0, opacity: 0.45 },
    });
    addOverlayPrimitive(polygon);
    tempPoints.length = 0;
    clearPreviewGeometry();
  }

  function clearAllGraphics() {
    tempPoints.length = 0;
    clearPreviewGeometry();
    scene?.primitives?.removeAll();
  }

  function getGroundPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const camera = scene?.getCamera();
    if (!camera) return null;

    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    return raycaster.ray.intersectPlane(drawPlane, pickPoint)?.clone() ?? null;
  }

  return {
    init,
    destroy,
    setDrawMode,
    addVertex,
    updatePreview,
    finishPolyline,
    finishPolygon,
    clearAllGraphics,
    getGroundPoint,
    getPendingVertexCount: () => tempPoints.length,
    getDrawMode: () => drawMode,
  };
}

export type DrawDemoApi = ReturnType<typeof createDrawDemo>;

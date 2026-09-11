import * as THREE from "three";
import { CameraController } from "./CameraController";
import { WebMercatorGIS } from "../gis/WebMercatorGIS";
import { LayerGroup } from "../engine/layers/LayerGroup";
import { LayerTree } from "../engine/layers/LayerTree";
import { VectorLayer } from "../engine/layers/VectorLayer";
import { PrimitiveCollection } from "../engine/collection/PrimitiveCollection";
import { GISOrbitController } from "../engine/controller/GISOrbitController";
import { ThreeUtils, ThreeUtilsOptions } from "../engine/three-utils";
import { LayerTreeNode } from "../types/layers";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface SceneOptions {
  /** Coordinate system used by the camera controller and map APIs. */
  gis?: WebMercatorGIS;
  /** Low-level Three.js and controller configuration. */
  three?: ThreeUtilsOptions;
}

export type SceneLoadCallback = (success?: boolean, message?: string | Error) => void;

/**
 * Owns the Three.js runtime, layer tree, and top-level primitive collection.
 *
 * `Scene` is browser-only. Construct it inside a client component/effect and
 * call `ready()` or `load()` before accessing the renderer and camera.
 */
export class Scene {
  public readonly container: HTMLDivElement;
  public scene: THREE.Scene | null = null;
  public camera: THREE.PerspectiveCamera | null = null;
  public renderer: THREE.WebGLRenderer | null = null;
  public controls: OrbitControls | null = null;
  public cameraController: CameraController | null = null;
  public primitives!: PrimitiveCollection;
  public readonly layerTree: LayerTree;

  private readonly threeUtils: ThreeUtils;
  private readonly initPromise: Promise<void>;
  private gisController: GISOrbitController | null = null;
  private destroyed = false;

  constructor(container: HTMLDivElement, options: SceneOptions = {}) {
    this.container = container;
    this.layerTree = new LayerTree();
    this.threeUtils = ThreeUtils(container, {
      ...options.three,
      gis: options.gis ?? options.three?.gis ?? new WebMercatorGIS(0, 0),
    });
    this.initPromise = this.initScene();
  }

  /** Resolve when the renderer, camera, and controls are ready. */
  public async ready(): Promise<this> {
    await this.initPromise;
    return this;
  }

  /**
   * Backwards-compatible callback-based initialization API.
   * The returned Promise should be preferred by new callers.
   */
  public load(callback?: SceneLoadCallback): Promise<this> {
    return this.ready()
      .then(() => {
        callback?.(true);
        return this;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        callback?.(false, normalized);
        throw normalized;
      });
  }

  private async initScene(): Promise<void> {
    await this.threeUtils.init();
    if (this.destroyed) return;

    this.scene = this.threeUtils.getScene();
    this.camera = this.threeUtils.getCamera();
    this.renderer = this.threeUtils.getRenderer();
    this.gisController = this.threeUtils.getGISController();
    this.controls = this.gisController?.controls ?? this.threeUtils.getControls();

    if (!this.scene || !this.camera || !this.renderer) {
      throw new Error("Failed to initialize the Three.js scene.");
    }

    if (this.controls) {
      this.cameraController = new CameraController(this.camera, this.controls);
    }
    this.primitives = new PrimitiveCollection(this.scene);
  }

  public flyTo(longitude: number, latitude: number, eyeHeight: number, altitude = 0): void {
    this.gisController?.flyTo(longitude, latitude, eyeHeight, altitude);
  }

  public addFrameCallback(key: string, callback: () => void): void {
    this.threeUtils.addAnimateListener(key, callback);
  }

  public removeFrameCallback(key: string): void {
    this.threeUtils.removeAnimateListener(key);
  }

  public getCamera(): THREE.PerspectiveCamera | null {
    return this.camera;
  }

  public getGisController(): GISOrbitController | null {
    return this.getGISController();
  }

  public getGISController(): GISOrbitController | null {
    return this.gisController;
  }

  public getGIS(): WebMercatorGIS | null {
    return this.gisController?.gis ?? null;
  }

  public pickGroundLngLat(
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    gis: WebMercatorGIS = this.gisController?.gis ?? new WebMercatorGIS(0, 0),
  ): [number, number] | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, point)) return null;
    const [longitude, latitude] = gis.threeToLngLat(point);
    return [longitude, latitude];
  }

  public add(object: THREE.Object3D): this {
    this.scene?.add(object);
    return this;
  }

  public getNodeEffectiveShow(node: LayerTreeNode): boolean {
    let current: LayerTreeNode | null = node;
    while (current) {
      if (!current.show) return false;
      current = current.parent;
    }
    return true;
  }

  /** Create and attach missing primitive objects, then synchronize visibility. */
  public syncLayerGraphics(): void {
    if (!this.scene) return;

    const visit = (node: LayerTreeNode): void => {
      if (node.type === "vector") {
        const layer = node as VectorLayer;
        const visible = this.getNodeEffectiveShow(node);
        for (const primitive of layer.primitives) {
          if (!primitive.object) {
            primitive.object = primitive.createObject();
            this.scene!.add(primitive.object);
          }
          primitive.object.visible = visible;
        }
        return;
      }

      if (node.type === "group") {
        for (const child of (node as LayerGroup).children) visit(child);
      }
    };

    visit(this.layerTree.root);
  }

  public createVectorLayer(name: string, parentId = "root"): VectorLayer {
    const layer = new VectorLayer(name);
    this.layerTree.addNode(layer, parentId);
    return layer;
  }

  public createGroup(name: string, parentId = "root"): LayerGroup {
    const group = new LayerGroup(name);
    this.layerTree.addNode(group, parentId);
    return group;
  }

  public exportSceneJSON(): string {
    return JSON.stringify(this.layerTree.serialize(), null, 2);
  }

  public importSceneJSON(json: string): void {
    this.layerTree.deserialize(JSON.parse(json));
    this.syncLayerGraphics();
  }

  public clearLayerPrimitives(layerId: string): boolean {
    const node = this.layerTree.findNodeById(layerId);
    if (!node || node.type !== "vector") return false;

    this.disposeLayerPrimitives(node as VectorLayer);
    return true;
  }

  public clearGroupPrimitives(groupId: string): boolean {
    const node = this.layerTree.findNodeById(groupId);
    if (!node || node.type !== "group") return false;

    this.visitVectorLayers(node, (layer) => this.disposeLayerPrimitives(layer));
    return true;
  }

  public clearAllPrimitives(): void {
    this.visitVectorLayers(this.layerTree.root, (layer) => {
      this.disposeLayerPrimitives(layer);
    });
  }

  private visitVectorLayers(node: LayerTreeNode, callback: (layer: VectorLayer) => void): void {
    if (node.type === "vector") {
      callback(node as VectorLayer);
      return;
    }
    if (node.type === "group") {
      for (const child of (node as LayerGroup).children) {
        this.visitVectorLayers(child, callback);
      }
    }
  }

  private disposeLayerPrimitives(layer: VectorLayer): void {
    for (const primitive of layer.primitives) {
      if (primitive.object) {
        this.disposeObject(primitive.object);
        primitive.object = null;
      }
    }
    layer.primitives.length = 0;
  }

  private disposeObject(object: THREE.Object3D): void {
    object.removeFromParent();
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        material.dispose();
      }
    });
  }

  /** Release WebGL resources and make this Scene unusable. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.clearAllPrimitives();
    this.primitives?.destroy();
    this.cameraController?.dispose();
    this.threeUtils.dispose();

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.cameraController = null;
    this.gisController = null;
  }
}

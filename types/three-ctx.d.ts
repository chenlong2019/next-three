import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { WebGPURenderer } from "three/webgpu";
import { LayerParam } from "./cad";

export type RenderCtx = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: WebGPURenderer | null;
  controls: OrbitControls | null;
  layerGroupMap: Record<string, THREE.Group>;
  allLayersData: Record<string, LayerParam>;
  hiddenLayerControl: boolean;
};

declare global {
  interface Window {
    allTexture?: unknown;
    layerMap?: Map<string, THREE.Group>;
  }
}

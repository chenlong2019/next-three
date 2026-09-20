import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { HELPER_LAYER } from "./globleValue";
import { GISOrbitController, GISOrbitControllerOptions } from "./controller/GISOrbitController";
import { WebMercatorGIS } from "../gis/WebMercatorGIS";
import { getHorizonDistance } from "./utils/camera-utils";

export interface BloomEffectOptions {
  /** Bloom intensity. Default: 1. */
  strength?: number;
  /** Blur radius in the 0-1 range. Default: 0.4. */
  radius?: number;
  /** Minimum luminance included in bloom. Default: 0.85. */
  threshold?: number;
}

export interface ThreePostprocessingOptions {
  bloom?: BloomEffectOptions | false;
}

export interface ThreeUtilsOptions {
  enableOrbitControls?: boolean;
  enableKeyboardControls?: boolean;
  enableHelpers?: boolean;
  cameraPosition?: THREE.Vector3;
  targetPosition?: THREE.Vector3;
  cubeColor?: number;
  autoRotate?: boolean;
  backgroundColor?: THREE.ColorRepresentation;
  toneMappingExposure?: number;
  /** Initial and maximum camera clipping range in meters. */
  cameraNear?: number;
  cameraFar?: number;
  /** Vertical camera field of view in degrees. Default: 75. */
  cameraFov?: number;
  /** Recalculate clipping planes from camera distance each frame. */
  dynamicCameraClipping?: boolean;
  postprocessing?: ThreePostprocessingOptions;
  /** Shared coordinate system used by GISOrbitController. */
  gis?: WebMercatorGIS;
  gisControllerOptions?: GISOrbitControllerOptions;
}

export interface ThreeUtils {
  addAnimateListener(key: string, callback: () => void): void;
  removeAnimateListener(key: string): void;
  init(): Promise<void>;
  getCamera(): THREE.PerspectiveCamera | null;
  getScene(): THREE.Scene | null;
  getRenderer(): THREE.WebGLRenderer | null;
  getControls(): OrbitControls | null;
  getGISController(): GISOrbitController | null;
  /** @deprecated Use getGISController(). */
  getGisCtroller(): GISOrbitController | null;
  getTarget(): THREE.Vector3 | null;
  setTarget(target: THREE.Vector3): void;
  setKeyboardControlsEnabled(enabled: boolean): void;
  setAutoRotate(enabled: boolean): void;
  dispose(): void;
}

/** Create and own the browser-side Three.js runtime for a scene container. */
export function ThreeUtils(container: HTMLElement, options: ThreeUtilsOptions = {}): ThreeUtils {
  const config = {
    enableOrbitControls: true,
    enableKeyboardControls: true,
    enableHelpers: false,
    cameraPosition: new THREE.Vector3(0, 0, 15000),
    targetPosition: new THREE.Vector3(0, 0, 0),
    cubeColor: 0x4a9eff,
    autoRotate: false,
    ...options,
    backgroundColor: options.backgroundColor ?? 0x1a1a1a,
    toneMappingExposure: options.toneMappingExposure ?? 1,
    cameraNear: options.cameraNear ?? 0.1,
    cameraFar: options.cameraFar ?? 100000000,
    cameraFov: options.cameraFov ?? 75,
    dynamicCameraClipping: options.dynamicCameraClipping ?? true,
    postprocessing: options.postprocessing ?? {},
    gis: options.gis ?? new WebMercatorGIS(0, 0),
    gisControllerOptions: options.gisControllerOptions ?? {},
  };

  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let composer: EffectComposer | null = null;
  let gisController: GISOrbitController | null = null;
  let orbitControls: OrbitControls | null = null;
  let animationId: number | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let initPromise: Promise<void> | null = null;
  let disposed = false;
  let keyboardControlsEnabled = config.enableKeyboardControls;

  const animateListeners = new Map<string, () => void>();
  const keysPressed: Record<string, boolean> = {};
  const zUp = new THREE.Vector3(0, 0, 1);

  const handleKeyDown = (event: KeyboardEvent): void => {
    keysPressed[event.key] = true;
  };
  const handleKeyUp = (event: KeyboardEvent): void => {
    keysPressed[event.key] = false;
  };

  const resize = (): void => {
    if (!camera || !renderer) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    composer?.setSize(width, height);
  };

  const bindResize = (): void => {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    window.addEventListener("resize", resize);
  };

  const bindKeyboardEvents = (): void => {
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
  };

  const addHelpers = (): void => {
    if (!scene || !config.enableHelpers) return;

    const gridHelper = new THREE.GridHelper(100, 100, 0x444466, 0x333355);
    gridHelper.rotation.x = -Math.PI / 2;
    gridHelper.position.copy(config.targetPosition);
    gridHelper.userData.layer = HELPER_LAYER;
    scene.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(12000);
    axesHelper.position.copy(config.targetPosition);
    axesHelper.userData.layer = HELPER_LAYER;
    scene.add(axesHelper);

    const targetMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    );
    targetMarker.position.copy(config.targetPosition);
    targetMarker.userData.layer = HELPER_LAYER;
    scene.add(targetMarker);
  };

  const initGISController = (): void => {
    if (!scene || !camera || !renderer || !config.enableOrbitControls) return;

    gisController = new GISOrbitController(
      scene,
      camera,
      renderer.domElement,
      config.gis,
      config.gisControllerOptions,
    );
    gisController.controls.target.copy(config.targetPosition);
    gisController.controls.autoRotate = config.autoRotate;
    camera.lookAt(config.targetPosition);
    gisController.controls.update();
  };

  const updateKeyboardControls = (): void => {
    if (!camera || !keyboardControlsEnabled) return;

    const speed = 0.05;
    const rotationSpeed = 0.02;
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);

    const forward = new THREE.Vector3(direction.x, direction.y, 0);
    if (forward.lengthSq() > 0) forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, zUp);
    if (right.lengthSq() > 0) right.normalize();

    const delta = new THREE.Vector3();
    if (keysPressed.w || keysPressed.W) delta.addScaledVector(forward, speed);
    if (keysPressed.s || keysPressed.S) delta.addScaledVector(forward, -speed);
    if (keysPressed.a || keysPressed.A) delta.addScaledVector(right, -speed);
    if (keysPressed.d || keysPressed.D) delta.addScaledVector(right, speed);
    if (keysPressed.e || keysPressed.E) delta.z += speed;
    if (keysPressed.q || keysPressed.Q) delta.z -= speed;

    camera.position.add(delta);
    if (gisController) gisController.controls.target.add(delta);
    if (!gisController && orbitControls) orbitControls.target.add(delta);

    if (!config.enableOrbitControls) {
      if (keysPressed.ArrowLeft) camera.rotation.y += rotationSpeed;
      if (keysPressed.ArrowRight) camera.rotation.y -= rotationSpeed;
      if (keysPressed.ArrowUp) camera.rotation.x += rotationSpeed;
      if (keysPressed.ArrowDown) camera.rotation.x -= rotationSpeed;
    }

    gisController?.controls.update();
    orbitControls?.update();
  };

  const updateCameraClipping = (): void => {
    if (!camera || !config.dynamicCameraClipping) return;

    const target = gisController?.controls.target ?? orbitControls?.target ?? config.targetPosition;
    const distance = camera.position.distanceTo(target);
    if (!Number.isFinite(distance) || distance <= 0) return;

    // Keep the depth range proportional to the current GIS scale. This gives
    // close views useful precision while still covering global overview views.
    const near = THREE.MathUtils.clamp(
      distance * 0.0005,
      config.cameraNear,
      Math.max(config.cameraNear, Math.min(distance * 0.2, 50)),
    );
    const eyeHeight = camera.position.z - target.z;
    const horizonDistance = getHorizonDistance(eyeHeight, { horizonFactor: 1 });
    const horizonViewDistance = Math.hypot(Math.max(eyeHeight, 0), horizonDistance) * 1.05;
    const far = Math.min(config.cameraFar, Math.max(1000, distance * 12, horizonViewDistance));
    const nextFar = Math.max(far, near * 2.01);
    if (Math.abs(camera.near - near) < 0.001 && Math.abs(camera.far - nextFar) < 1) return;
    camera.near = near;
    camera.far = nextFar;
    camera.updateProjectionMatrix();
  };

  const animate = (): void => {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);

    updateKeyboardControls();
    gisController?.update();
    orbitControls?.update();
    updateCameraClipping();
    camera?.updateMatrixWorld(true);
    animateListeners.forEach((callback) => callback());

    if (composer) {
      composer.render();
    } else if (scene && camera && renderer) {
      renderer.render(scene, camera);
    }
  };

  const initPostprocessing = (width: number, height: number): void => {
    const bloom = config.postprocessing.bloom;
    if (!scene || !camera || !renderer || !bloom) return;

    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = config.toneMappingExposure;

    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    composer.setSize(width, height);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(width, height),
        bloom.strength ?? 1,
        bloom.radius ?? 0.4,
        bloom.threshold ?? 0.85,
      ),
    );
    composer.addPass(new OutputPass());
  };

  const init = (): Promise<void> => {
    if (initPromise) return initPromise;

    initPromise = Promise.resolve().then(() => {
      if (disposed) throw new Error("Cannot initialize a disposed Three.js runtime.");
      if (scene) return;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(config.backgroundColor);
      scene.up.copy(zUp);

      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      camera = new THREE.PerspectiveCamera(
        config.cameraFov,
        width / height,
        config.cameraNear,
        config.cameraFar,
      );
      camera.up.copy(zUp);
      camera.position.copy(config.cameraPosition);

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        logarithmicDepthBuffer: true,
        powerPreference: "high-performance",
      });
      renderer.setSize(width, height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(renderer.domElement);
      initPostprocessing(width, height);

      addHelpers();
      initGISController();
      if (!gisController && config.enableOrbitControls && camera && renderer) {
        orbitControls = new OrbitControls(camera, renderer.domElement);
        orbitControls.target.copy(config.targetPosition);
        orbitControls.autoRotate = config.autoRotate;
        orbitControls.update();
      }

      bindResize();
      if (keyboardControlsEnabled) bindKeyboardEvents();
      animate();
    });

    return initPromise;
  };

  const getTarget = (): THREE.Vector3 | null => {
    if (gisController) return gisController.controls.target.clone();
    if (orbitControls) return orbitControls.target.clone();
    if (!camera) return null;

    const target = new THREE.Vector3();
    camera.getWorldDirection(target);
    return target.multiplyScalar(-1).add(camera.position);
  };

  const setTarget = (target: THREE.Vector3): void => {
    if (gisController) {
      gisController.controls.target.copy(target);
      gisController.controls.update();
    } else if (orbitControls) {
      orbitControls.target.copy(target);
      orbitControls.update();
    } else {
      camera?.lookAt(target);
    }
  };

  const setAutoRotate = (enabled: boolean): void => {
    if (gisController) gisController.controls.autoRotate = enabled;
    if (orbitControls) orbitControls.autoRotate = enabled;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    if (animationId !== null) cancelAnimationFrame(animationId);
    animationId = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    window.removeEventListener("resize", resize);
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("keyup", handleKeyUp);
    animateListeners.clear();
    Object.keys(keysPressed).forEach((key) => delete keysPressed[key]);

    gisController?.dispose();
    gisController = null;
    orbitControls?.dispose();
    orbitControls = null;

    if (scene) {
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
    }

    if (composer) {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
      composer = null;
    }
    renderer?.dispose();
    renderer?.domElement.remove();
    renderer = null;
    camera = null;
    scene = null;
  };

  return {
    init,
    addAnimateListener: (key, callback) => animateListeners.set(key, callback),
    removeAnimateListener: (key) => animateListeners.delete(key),
    getCamera: () => camera,
    getScene: () => scene,
    getRenderer: () => renderer,
    getControls: () => orbitControls,
    getGISController: () => gisController,
    getGisCtroller: () => gisController,
    getTarget,
    setTarget,
    setKeyboardControlsEnabled: (enabled) => {
      keyboardControlsEnabled = enabled;
      if (enabled) {
        bindKeyboardEvents();
      } else {
        document.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("keyup", handleKeyUp);
      }
    },
    setAutoRotate,
    dispose,
  };
}

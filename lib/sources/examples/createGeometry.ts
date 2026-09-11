import { Scene } from "../core/Scene";
import { BoxPrimitive } from "../engine/primitives/BoxPrimitive";
import * as THREE from "three";

export function createGeometry(container: HTMLDivElement) {
  let scene: Scene;
  function init() {
    scene = new Scene(container);
    scene.load(() => {
      createBox();
    });
  }

  function addLight() {
    if (scene) {
      const ambient = new THREE.HemisphereLight(0xffffff, 0xbfd4d2, 2);
      scene.add(ambient);
      const directionalLight = new THREE.DirectionalLight(0xffffff, 1.3);
      directionalLight.position.set(1740, -706, 50);
      directionalLight.castShadow = true;
      directionalLight.shadow.mapSize.setScalar(2048);
      directionalLight.shadow.bias = -1e-4;
      scene.add(directionalLight);
    }
  }

  function createBox() {
    addLight();
    const params = {
      position: new THREE.Vector3(0, 0, 0),
      style: {
        color: "#ff0000",
        width: 10,
        height: 10,
        depth: 10,
      },
    };
    const box = new BoxPrimitive(params);
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.2,
      color: 0xffff00,
      metalness: 0.8,
      bumpScale: 1,
    });
    box.setMaterial(mat);
    scene.primitives.add(box);
  }

  function destroy() {
    scene?.destroy();
  }

  return {
    init,
    destroy,
  };
}

import * as THREE from "three";
import { BaseGraphic } from "./BaseGraphic";

export interface PointStyle {
  color: string;
  size: number;
}

export interface PointGraphicOption {
  id?: string;
  position: THREE.Vector3;
  style: PointStyle;
}

export class PointGraphic extends BaseGraphic {
  public position: THREE.Vector3;
  public style: PointStyle;

  constructor(opt: PointGraphicOption) {
    super(opt.id);
    this.position = opt.position.clone();
    this.style = { ...opt.style };
  }

  createObject(): THREE.Object3D {
    const geometry = new THREE.SphereGeometry(this.style.size / 10, 8, 8);
    const material = new THREE.MeshBasicMaterial({
      color: this.style.color,
      transparent: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(this.position);
    return mesh;
  }

  clone(): PointGraphic {
    return new PointGraphic({
      id: uuidv4(),
      position: this.position.clone(),
      style: { ...this.style },
    });
  }
}

function uuidv4(): string | undefined {
  throw new Error("Function not implemented.");
}

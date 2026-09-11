import * as THREE from "three";
import { BaseGraphic } from "./BaseGraphic";
import { v4 as uuidv4 } from "uuid";

export interface LineStyle {
  color: string;
  width: number;
}

export interface LineGraphicOption {
  id?: string;
  points: THREE.Vector3[];
  style: LineStyle;
}

export class LineGraphic extends BaseGraphic {
  public points: THREE.Vector3[];
  public style: LineStyle;

  constructor(opt: LineGraphicOption) {
    super(opt.id);
    this.points = opt.points.map((p) => p.clone());
    this.style = { ...opt.style };
  }

  createObject(): THREE.Object3D {
    const vertices = new Float32Array(this.points.length * 3);
    this.points.forEach((p, idx) => {
      vertices[idx * 3] = p.x;
      vertices[idx * 3 + 1] = p.y;
      vertices[idx * 3 + 2] = p.z;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    const material = new THREE.LineBasicMaterial({
      color: this.style.color,
    });
    return new THREE.Line(geometry, material);
  }

  clone(): LineGraphic {
    return new LineGraphic({
      id: uuidv4(),
      points: this.points.map((p) => p.clone()),
      style: { ...this.style },
    });
  }
}

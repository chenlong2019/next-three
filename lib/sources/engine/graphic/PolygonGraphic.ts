import * as THREE from "three";
import { BaseGraphic } from "./BaseGraphic";
import { v4 as uuidv4 } from "uuid";

export interface PolygonStyle {
  fillColor: string;
  strokeColor: string;
  opacity: number;
}

export interface PolygonGraphicOption {
  id?: string;
  points: THREE.Vector3[];
  style: PolygonStyle;
}

export class PolygonGraphic extends BaseGraphic {
  public points: THREE.Vector3[];
  public style: PolygonStyle;

  constructor(opt: PolygonGraphicOption) {
    super(opt.id);
    this.points = opt.points.map((p) => p.clone());
    this.style = { ...opt.style };
  }

  createObject(): THREE.Object3D {
    const shape = new THREE.Shape();
    if (this.points.length >= 3) {
      shape.moveTo(this.points[0].x, this.points[0].y);
      for (let i = 1; i < this.points.length; i++) {
        shape.lineTo(this.points[i].x, this.points[i].y);
      }
      shape.closePath();
    }
    const geom = new THREE.ShapeGeometry(shape);
    const mat = new THREE.MeshBasicMaterial({
      color: this.style.fillColor,
      transparent: true,
      opacity: this.style.opacity,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geom, mat);
  }

  clone(): PolygonGraphic {
    return new PolygonGraphic({
      id: uuidv4(),
      points: this.points.map((p) => p.clone()),
      style: { ...this.style },
    });
  }
}

import * as THREE from "three";
import { BasePrimitive, PrimitiveSerializedJson } from "./BasePrimitive";
import { v4 as uuidv4 } from "uuid";

/**
 * 多边形图元样式配置
 */
export interface PolygonStyle {
  /** 填充颜色十六进制字符串 */
  color: string;
  /** 多边形拉伸厚度；0 表示贴地平面 */
  depth: number;
  /** 填充透明度，范围0到1（默认1） */
  opacity?: number;
}

/**
 * 多边形图元构造参数
 */
export interface PolygonPrimitiveOption {
  /** 图元唯一ID，不传自动生成uuid */
  id?: string;
  /** 轮廓顶点数组（世界坐标，Z向为高度） */
  points: THREE.Vector3[];
  /** 多边形样式与拉伸参数 */
  style: PolygonStyle;
}

/**
 * 闭合多边形图元
 * @remarks
 * 用于墙体、管沟等闭合区域；基于Shape+ExtrudeGeometry拉伸生成实体
 * 顶点顺序建议逆时针，保证法线朝向正确
 * 配合 {@link PrimitiveFactory} 完成JSON序列化重建
 */
export class PolygonPrimitive extends BasePrimitive {
  /** 多边形轮廓顶点集合 */
  public points: THREE.Vector3[];
  /** 多边形样式、拉伸厚度 */
  public style: PolygonStyle;
  /** 图元类型标识，工厂识别关键字 */
  public static readonly type = "Polygon";

  /**
   * 创建多边形图元实例
   * @param opt 构造配置项
   */
  constructor(opt: PolygonPrimitiveOption) {
    super(opt.id);
    this.points = opt.points.map((p) => p.clone());
    this.style = { ...opt.style };
  }

  /**
   * 创建拉伸多边形Mesh对象
   * @returns 构建完成的拉伸实体Mesh
   */
  createObject(): THREE.Object3D {
    const shape = new THREE.Shape();
    if (this.points.length > 0) {
      shape.moveTo(this.points[0].x, this.points[0].y);
      for (const point of this.points.slice(1)) {
        shape.lineTo(point.x, point.y);
      }
      shape.closePath();
    }

    const geo =
      this.style.depth > 0
        ? new THREE.ExtrudeGeometry(shape, {
            depth: this.style.depth,
            bevelEnabled: false,
          })
        : new THREE.ShapeGeometry(shape);
    const opacity = THREE.MathUtils.clamp(this.style.opacity ?? 1, 0, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: this.style.color,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = this.points[0]?.z ?? 0;
    return mesh;
  }

  /**
   * 克隆当前多边形图元，生成全新ID
   * @returns 新PolygonPrimitive实例
   */
  clone(): PolygonPrimitive {
    return new PolygonPrimitive({
      id: uuidv4(),
      points: this.points.map((p) => p.clone()),
      style: { ...this.style },
    });
  }

  /**
   * 序列化为JSON持久化对象
   * @returns 可序列化数据，携带primitiveType用于工厂分发
   */
  toJSON() {
    return {
      primitiveType: PolygonPrimitive.type,
      id: this.id,
      points: this.points.map((p) => [p.x, p.y, p.z]),
      style: { ...this.style },
    };
  }

  /**
   * 从序列化JSON重建多边形图元实例
   * @param json 序列化数据
   * @returns PolygonPrimitive实例
   */
  static fromJSON(json: PrimitiveSerializedJson): PolygonPrimitive {
    const points = (json.points as number[][]).map((coord) => new THREE.Vector3(...coord));
    return new PolygonPrimitive({
      id: json.id,
      points,
      style: { ...(json.style as PolygonStyle) },
    });
  }
}

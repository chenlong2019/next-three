import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { BasePrimitive, PrimitiveSerializedJson } from "./BasePrimitive";
import { v4 as uuidv4 } from "uuid";

/**
 * 折线图元样式配置
 */
export interface PolylineStyle {
  /** 线条颜色十六进制字符串 */
  color: string;
  /** 屏幕空间线宽，单位为 CSS 像素 */
  lineWidth: number;
}

/**
 * 折线图元构造参数
 */
export interface PolylinePrimitiveOption {
  /** 图元唯一ID，不传自动生成uuid */
  id?: string;
  /** 折线顶点数组（世界坐标） */
  points: THREE.Vector3[];
  /** 折线外观样式 */
  style: PolylineStyle;
}

/**
 * 折线图元，继承自基础图元基类
 * @remarks
 * 用于路径、边界等开放折线；使用 Line2 保持稳定的屏幕像素线宽
 * 配合 {@link PrimitiveFactory} 完成JSON序列化重建
 */
export class PolylinePrimitive extends BasePrimitive {
  /** 折线顶点集合 */
  public points: THREE.Vector3[];
  /** 折线外观样式 */
  public style: PolylineStyle;
  /** 图元类型标识，工厂识别关键字 */
  public static readonly type = "Polyline";

  /**
   * 创建折线图元实例
   * @param opt 构造配置项
   */
  constructor(opt: PolylinePrimitiveOption) {
    super(opt.id);
    this.points = opt.points.map((p) => p.clone());
    this.style = { ...opt.style };
  }

  /**
   * 创建 Three.js Line2 对象
   * @returns 构建完成的折线Object3D
   */
  createObject(): THREE.Object3D {
    const geometry = new LineGeometry();
    if (this.points.length >= 2) {
      geometry.setPositions(this.points.flatMap((point) => [point.x, point.y, point.z]));
    }

    const material = new LineMaterial({
      color: this.style.color,
      linewidth: Math.max(this.style.lineWidth, 1),
      worldUnits: false,
      transparent: true,
      alphaToCoverage: true,
    });
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.onBeforeRender = (renderer) => {
      if (line.material instanceof LineMaterial) {
        renderer.getSize(line.material.resolution);
      }
    };
    return line;
  }

  /**
   * 克隆当前折线图元，生成全新ID
   * @returns 新PolylinePrimitive实例
   */
  clone(): PolylinePrimitive {
    return new PolylinePrimitive({
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
      primitiveType: PolylinePrimitive.type,
      id: this.id,
      points: this.points.map((p) => [p.x, p.y, p.z]),
      style: { ...this.style },
    };
  }

  /**
   * 从序列化JSON重建折线图元实例
   * @param json 序列化数据
   * @returns PolylinePrimitive实例
   */
  static fromJSON(json: PrimitiveSerializedJson): PolylinePrimitive {
    const points = (json.points as number[][]).map((coord) => new THREE.Vector3(...coord));
    return new PolylinePrimitive({
      id: json.id,
      points,
      style: { ...(json.style as PolylineStyle) },
    });
  }
}

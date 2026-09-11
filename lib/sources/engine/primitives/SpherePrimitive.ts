import * as THREE from "three";
import { BasePrimitive, PrimitiveSerializedJson } from "./BasePrimitive";
import { v4 as uuidv4 } from "uuid";

/**
 * 球体图元样式配置
 */
export interface SphereStyle {
  /** 颜色十六进制字符串 */
  color: string;
  /** 球体半径 */
  radius: number;
}

/**
 * 球体图元构造参数
 */
export interface SpherePrimitiveOption {
  /** 图元唯一ID，不传自动生成uuid */
  id?: string;
  /** 空间位置坐标 */
  position: THREE.Vector3;
  /** 球体外观与尺寸样式 */
  style: SphereStyle;
}

/**
 * 球体图元，继承自基础图元基类
 * @remarks
 * 实现三维球体网格创建、克隆、序列化与反序列化
 * 配合 {@link PrimitiveFactory} 完成JSON数据重建
 */
export class SpherePrimitive extends BasePrimitive {
  /** 球体世界坐标位置 */
  public position: THREE.Vector3;
  /** 球体尺寸、外观样式 */
  public style: SphereStyle;
  /** 图元类型标识，用于工厂分发识别 */
  public static readonly type = "Sphere";

  /**
   * 创建球体图元实例
   * @param opt 构造配置项
   */
  constructor(opt: SpherePrimitiveOption) {
    super(opt.id);
    this.position = opt.position.clone();
    this.style = { ...opt.style };
  }

  /**
   * 创建Three.js球体Mesh对象
   * @returns 构建完成的Mesh对象
   */
  createObject(): THREE.Object3D {
    const geo = new THREE.SphereGeometry(this.style.radius, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: this.style.color, transparent: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.position);
    return mesh;
  }

  /**
   * 克隆当前球体图元，生成全新ID
   * @returns 新的SpherePrimitive实例
   */
  clone(): SpherePrimitive {
    return new SpherePrimitive({
      id: uuidv4(),
      position: this.position.clone(),
      style: { ...this.style },
    });
  }

  /**
   * 序列化为JSON持久化对象
   * @returns 可序列化数据，包含primitiveType用于工厂识别
   */
  toJSON() {
    return {
      primitiveType: SpherePrimitive.type,
      id: this.id,
      position: [this.position.x, this.position.y, this.position.z],
      style: { ...this.style },
    };
  }

  /**
   * 从序列化JSON重建球体图元实例
   * @param json 序列化数据
   * @returns SpherePrimitive实例
   */
  static fromJSON(json: PrimitiveSerializedJson): SpherePrimitive {
    return new SpherePrimitive({
      id: json.id,
      position: new THREE.Vector3(...(json.position as [number, number, number])),
      style: { ...(json.style as SphereStyle) },
    });
  }
}

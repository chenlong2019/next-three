import * as THREE from "three";
import { BasePrimitive, PrimitiveSerializedJson } from "./BasePrimitive";
import { v4 as uuidv4 } from "uuid";

/**
 * 立方体图元样式配置
 */
export interface BoxStyle {
  /** 颜色十六进制字符串 */
  color?: string;
  /** 宽度 */
  width: number;
  /** 高度 */
  height: number;
  /** 深度 */
  depth: number;
}

/**
 * 立方体图元构造参数
 */
export interface BoxPrimitiveOption {
  /** 图元唯一ID，不传自动生成uuid */
  id?: string;
  /** 空间位置坐标 */
  position: THREE.Vector3;
  /** 立方体样式尺寸与颜色 */
  style: BoxStyle;
}

/**
 * 立方体图元，继承自基础图元基类
 * @remarks
 * 实现三维立方体网格创建、克隆、序列化与反序列化
 * 配合 {@link PrimitiveFactory} 完成JSON数据重建
 */
export class BoxPrimitive extends BasePrimitive {
  /** 立方体世界坐标位置 */
  public position: THREE.Vector3;
  /** 立方体尺寸、外观样式 */
  public style: BoxStyle;
  /** 图元类型标识，用于工厂分发识别 */
  public static readonly type = "Box";

  /**
   * 创建立方体图元实例
   * @param opt 构造配置项
   */
  constructor(opt: BoxPrimitiveOption) {
    super(opt.id);
    this.position = opt.position.clone();
    this.style = { ...opt.style };
  }

  /**
   * 创建Three.js立方体Mesh对象
   * @returns 构建完成的Mesh对象
   */
  createObject(): THREE.Object3D {
    const geo = new THREE.BoxGeometry(this.style.width, this.style.height, this.style.depth);
    if (!this.customMaterial) {
      this.customMaterial = new THREE.MeshBasicMaterial({
        color: this.style.color,
        transparent: true,
      });
    }

    const mesh = new THREE.Mesh(geo, this.customMaterial);
    mesh.position.copy(this.position);
    return mesh;
  }

  /**
   * 克隆当前立方体图元，生成全新ID
   * @returns 新的BoxPrimitive实例
   */
  clone(): BoxPrimitive {
    return new BoxPrimitive({
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
      primitiveType: BoxPrimitive.type,
      id: this.id,
      position: [this.position.x, this.position.y, this.position.z],
      style: { ...this.style },
    };
  }

  /**
   * 从序列化JSON重建立方体图元实例
   * @param json 序列化数据
   * @returns BoxPrimitive实例
   */
  static fromJSON(json: PrimitiveSerializedJson): BoxPrimitive {
    const data = json as unknown as BoxPrimitiveOption;
    return new BoxPrimitive({
      id: data.id,
      position: new THREE.Vector3(...data.position),
      style: { ...data.style },
    });
  }
}

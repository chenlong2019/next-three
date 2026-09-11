import * as THREE from "three";
import { v4 as uuidv4 } from "uuid";

/**
 * 图元静态接口约束
 * @remarks
 * 强制所有子类实现 type 和 fromJSON，解决 static abstract TS语法限制
 */
export interface IPrimitiveStatic {
  /** 图元类型标识 */
  readonly type: string;
  /** 通过JSON重建实例 */
  fromJSON(json: PrimitiveSerializedJson): BasePrimitive;
}

/**
 * 图元基础序列化结构
 */
export type PrimitiveSerializedJson = {
  primitiveType: string;
  id: string;
  [key: string]: unknown;
};

/**
 * 三维图元基类
 * @remarks
 * 所有可序列化三维实体的抽象父类
 * 约定能力：生成three对象、克隆、JSON序列化/反序列化重建
 */
export abstract class BasePrimitive {
  /** 图元唯一标识ID */
  public readonly id: string;

  /**
   * 绑定的Three.js渲染对象
   * 调用 {@link createObject()} 后赋值
   */
  public object: THREE.Object3D | null = null;
  /**
   * 外部自定义材质缓存
   * 调用 {@link createObject()} 后赋值
   */
  protected customMaterial?: THREE.Material | THREE.Material[];

  /**
   * 构造基础图元
   * @param id 可选指定唯一ID；不传则自动生成uuid
   */
  constructor(id?: string) {
    this.id = id ?? uuidv4();
  }

  /**
   * 设置自定义材质；createObject 时优先使用该材质
   */
  setMaterial(mat: THREE.Material | THREE.Material[]): void {
    this.customMaterial = mat;
    // 如果object已创建，立即更新
    if (this.object instanceof THREE.Mesh) {
      this.object.material = mat;
    }
  }

  /**
   * 清除自定义材质，下次createObject使用内置默认材质
   */
  clearMaterial(): void {
    this.customMaterial = undefined;
  }

  /**
   * 创建并返回对应的Three.js Object3D
   * @returns 构建完成的场景对象
   */
  public abstract createObject(): THREE.Object3D;

  /**
   * 克隆当前图元实例（生成新ID）
   * @returns 同类型全新图元对象
   */
  public abstract clone(): BasePrimitive;

  /**
   * 将图元数据序列化为普通JSON对象（用于持久化/传输）
   * @returns 可序列化Plain Object
   */
  public abstract toJSON(): PrimitiveSerializedJson;
}

import * as THREE from "three";
import { v4 as uuidv4 } from "uuid";
/**
 * 基本图元
 * @remarks
 * 基本图元接口
 */
export abstract class BaseGraphic {
  /** 实体唯一ID */
  public readonly id: string;
  /** 图元对象 */
  public object: THREE.Object3D | null = null;
  /**
   * 构造编辑器控制器
   * @param id 图元id
   */
  constructor(id?: string) {
    this.id = id ?? uuidv4();
  }

  /** 创建three渲染对象 */
  public abstract createObject(): THREE.Object3D;

  /** 深度克隆图元（复刻Cesium Entity.clone） */
  public abstract clone(): BaseGraphic;
}

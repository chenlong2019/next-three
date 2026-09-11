import * as THREE from "three";
import { BasePrimitive } from "../primitives/BasePrimitive";

/**
 * 图元集合，对齐 Cesium.PrimitiveCollection
 * 用于管理顶层独立临时图元（不纳入图层树结构）
 */
export class PrimitiveCollection {
  private readonly _scene: THREE.Scene;
  private readonly _primitives: BasePrimitive[] = [];
  private _show = true;

  constructor(scene: THREE.Scene) {
    this._scene = scene;
  }

  /**
   * 是否整体显示集合内所有图元
   */
  get show(): boolean {
    return this._show;
  }
  set show(value: boolean) {
    this._show = value;
    for (const prim of this._primitives) {
      if (prim.object) {
        prim.object.visible = value;
      }
    }
  }

  /**
   * 当前集合内图元数量
   */
  get length(): number {
    return this._primitives.length;
  }

  /**
   * 添加图元（自动创建Object3D并加入three场景）
   * @param primitive 继承BasePrimitive的图元实例
   */
  add(primitive: BasePrimitive): void {
    if (!this.contains(primitive)) {
      if (!primitive.object) {
        primitive.object = primitive.createObject();
      }
      primitive.object.visible = this._show;
      this._scene.add(primitive.object);
      this._primitives.push(primitive);
    }
  }

  /**
   * 移除单个图元，释放资源
   * @param primitive 图元实例
   * @returns 是否移除成功
   */
  remove(primitive: BasePrimitive): boolean {
    const index = this._primitives.indexOf(primitive);
    if (index === -1) return false;

    this._primitives.splice(index, 1);
    if (primitive.object) {
      this._scene.remove(primitive.object);
      this.disposeMesh(primitive.object);
      primitive.object = null;
    }
    return true;
  }

  /**
   * 清空全部图元并释放资源
   */
  removeAll(): void {
    for (const prim of this._primitives) {
      if (prim.object) {
        this._scene.remove(prim.object);
        this.disposeMesh(prim.object);
        prim.object = null;
      }
    }
    this._primitives.length = 0;
  }

  /**
   * 判断集合是否包含该图元
   */
  contains(primitive: BasePrimitive): boolean {
    return this._primitives.includes(primitive);
  }

  /**
   * 获取指定索引图元
   */
  get(index: number): BasePrimitive | undefined {
    return this._primitives[index];
  }

  /**
   * 遍历所有图元
   */
  forEach(callback: (primitive: BasePrimitive, index: number) => void): void {
    this._primitives.forEach((p, i) => callback(p, i));
  }

  /**
   * 释放Mesh几何体材质资源
   */
  private disposeMesh(obj: THREE.Object3D): void {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  }

  /**
   * 集合整体销毁（清空所有图元）
   */
  destroy(): void {
    this.removeAll();
  }
}

import * as THREE from "three";

export abstract class Graphic {
  public readonly id: string;
  protected _object: THREE.Object3D | null = null;
  protected _show = true;

  constructor(id: string) {
    this.id = id;
  }

  get object(): THREE.Object3D | null {
    return this._object;
  }

  get show(): boolean {
    return this._show;
  }

  set show(value: boolean) {
    this._show = value;
    if (this._object) {
      this._object.visible = value;
    }
  }

  // ✅ 新增：克隆图元
  abstract clone(): Graphic;
  // 创建three渲染对象
  public abstract createObject(): THREE.Object3D;
  /** 根据配置重建/更新几何体 */
  abstract update(): void;

  /** 销毁资源 */
  destroy(): void {
    if (!this._object) return;
    // 释放几何体、材质
    const mesh = this._object as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((mat) => mat.dispose());
    } else if (mesh.material) {
      mesh.material.dispose();
    }
    this._object = null;
  }
}

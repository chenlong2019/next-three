// 图层实体（类比 Cesium.Entity）
export interface Entity {
  id: string;
  name?: string;
  show: boolean;
}

// 基础渲染图元（类比 Cesium.Primitive）
export interface Primitive {
  id: string;
  show: boolean;
}

// 图层对象（对标 Cesium.ImageryLayer / Cesium.Cesium3DTileset）
export class Layer {
  public readonly id: string;
  public name: string;
  /** 是否显示图层（核心，类似 layer.show） */
  public show: boolean;
  /** 是否锁定 */
  public locked: boolean;
  /** 图层内图元集合 */
  public readonly primitives: Primitive[] = [];
  public readonly entities: Entity[] = [];

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.show = true;
    this.locked = false;
  }

  /** 添加图元到当前图层 */
  addPrimitive(prim: Primitive) {
    this.primitives.push(prim);
  }

  addEntity(entity: Entity) {
    this.entities.push(entity);
  }

  /** 设置图层显隐，同步内部所有图元 */
  setVisible(visible: boolean) {
    this.show = visible;
    const targetShow = visible;
    this.primitives.forEach((p) => (p.show = targetShow));
    this.entities.forEach((e) => (e.show = targetShow));
  }
}

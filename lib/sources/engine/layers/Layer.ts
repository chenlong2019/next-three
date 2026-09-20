import { LayerTreeNode } from "../../types/layers";
import { BaseGraphic } from "../graphic/BaseGraphic";
import { v4 as uuidv4 } from "uuid";
import { LayerGroup } from "./LayerGroup";

export class Layer implements LayerTreeNode {
  public readonly id: string;
  public name: string;
  public readonly type = "layer";
  public show = true;
  public locked = false;
  public parent: LayerGroup | null = null;

  public readonly graphics: BaseGraphic[] = [];

  constructor(name: string, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
  }

  addGraphic(graphic: BaseGraphic) {
    this.graphics.push(graphic);
  }

  removeGraphicById(gid: string) {
    const idx = this.graphics.findIndex((g) => g.id === gid);
    if (idx !== -1) this.graphics.splice(idx, 1);
  }

  getGraphicById(gid: string): BaseGraphic | null {
    return this.graphics.find((g) => g.id === gid) ?? null;
  }

  toView() {}

  /** 深度克隆图层（包含全部图元） */
  clone(newName: string): Layer {
    const newLayer = new Layer(newName);
    for (const g of this.graphics) {
      newLayer.addGraphic(g.clone());
    }
    return newLayer;
  }
}

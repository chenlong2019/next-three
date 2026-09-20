import { LayerTreeNode } from "../../types/layers";
import { v4 as uuidv4 } from "uuid";
import { LayerGroup } from "./LayerGroup";
import { BasePrimitive, PrimitiveSerializedJson } from "../primitives/BasePrimitive";
import { PrimitiveFactory } from "../primitives/PrimitiveFactory";

export class VectorLayer implements LayerTreeNode {
  public readonly id: string;
  public name: string;
  public readonly type = "vector";
  public show = true;
  public locked = false;
  public parent: LayerGroup | null = null;

  public readonly primitives: BasePrimitive[] = [];

  constructor(name: string, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
  }

  addPrimitive(prim: BasePrimitive) {
    this.primitives.push(prim);
  }

  removePrimitiveById(pid: string) {
    const idx = this.primitives.findIndex((p) => p.id === pid);
    if (idx !== -1) this.primitives.splice(idx, 1);
  }

  getPrimitiveById(pid: string): BasePrimitive | null {
    return this.primitives.find((p) => p.id === pid) ?? null;
  }

  clearPrimitives() {
    this.primitives.length = 0;
  }

  clone(newName: string): VectorLayer {
    const newLayer = new VectorLayer(newName);
    for (const g of this.primitives) {
      newLayer.addPrimitive(g.clone());
    }
    return newLayer;
  }

  // 序列化为JSON
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      show: this.show,
      locked: this.locked,
      primitives: this.primitives.map((p) => p.toJSON()),
    };
  }

  // 从JSON重建
  static fromJSON(json: Record<string, unknown>): VectorLayer {
    const layer = new VectorLayer(
      typeof json.name === "string" ? json.name : "Vector layer",
      typeof json.id === "string" ? json.id : undefined,
    );
    layer.show = typeof json.show === "boolean" ? json.show : true;
    layer.locked = typeof json.locked === "boolean" ? json.locked : false;

    const primitives = Array.isArray(json.primitives) ? json.primitives : [];
    for (const value of primitives) {
      if (!value || typeof value !== "object") continue;
      const prim = PrimitiveFactory.createFromJSON(value as PrimitiveSerializedJson);
      layer.addPrimitive(prim);
    }
    return layer;
  }
}

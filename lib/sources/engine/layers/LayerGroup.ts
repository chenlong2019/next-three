import { LayerTreeNode } from "../../types/layers";
import { v4 as uuidv4 } from "uuid";
import { VectorLayer } from "./VectorLayer";

export class LayerGroup implements LayerTreeNode {
  public readonly id: string;
  public name: string;
  public readonly type = "group";
  public show = true;
  public locked = false;
  public parent: LayerGroup | null = null;

  public readonly children: LayerTreeNode[] = [];

  constructor(name: string, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
  }

  insertChildAt(node: LayerTreeNode, index: number) {
    if (node.parent) {
      const oldIdx = node.parent.children.findIndex((c) => c.id === node.id);
      if (oldIdx > -1) node.parent.children.splice(oldIdx, 1);
    }
    node.parent = this;
    this.children.splice(Math.max(0, index), 0, node);
  }

  clone(newName: string): LayerGroup {
    const newGroup = new LayerGroup(newName);
    for (const child of this.children) {
      const cloned =
        child.type === "group"
          ? (child as LayerGroup).clone(child.name)
          : (child as VectorLayer).clone(child.name);
      newGroup.insertChildAt(cloned, newGroup.children.length);
    }
    return newGroup;
  }

  toJSON(): object | null {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      show: this.show,
      locked: this.locked,
      children: this.children.map((child) => {
        if (child.type === "group") {
          return (child as LayerGroup).toJSON();
        } else {
          return (child as VectorLayer).toJSON();
        }
      }),
    };
  }

  static fromJSON(json: Record<string, unknown>): LayerGroup {
    const group = new LayerGroup(
      typeof json.name === "string" ? json.name : "Group",
      typeof json.id === "string" ? json.id : undefined,
    );
    group.show = typeof json.show === "boolean" ? json.show : true;
    group.locked = typeof json.locked === "boolean" ? json.locked : false;

    const children = Array.isArray(json.children) ? json.children : [];
    for (const child of children) {
      if (!child || typeof child !== "object") continue;
      const childJson = child as Record<string, unknown>;
      let childNode: LayerTreeNode;
      if (childJson.type === "group") {
        childNode = LayerGroup.fromJSON(childJson);
      } else if (childJson.type === "vector") {
        childNode = VectorLayer.fromJSON(childJson);
      } else {
        continue;
      }
      group.insertChildAt(childNode, group.children.length);
    }
    return group;
  }
}

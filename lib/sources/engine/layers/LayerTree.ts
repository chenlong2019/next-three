import { LayerTreeNode, LayerTreeViewNode } from "@/lib/sources/types/layers";
import { LayerGroup } from "./LayerGroup";
import { VectorLayer } from "./VectorLayer";

export type LayerTreeEvent = "nodeAdded" | "nodeRemoved" | "nodeUpdated" | "nodeMoved";
type TreeEventHandler = () => void;

export class LayerTree {
  public readonly root: LayerGroup;
  private eventMap = new Map<LayerTreeEvent, Set<TreeEventHandler>>();

  constructor() {
    this.root = new LayerGroup("root");
  }

  setEvents(handlers: Partial<Record<LayerTreeEvent, TreeEventHandler>>) {
    for (const [evt, fn] of Object.entries(handlers)) {
      const key = evt as LayerTreeEvent;
      if (!this.eventMap.has(key)) this.eventMap.set(key, new Set());
      if (fn) this.eventMap.get(key)!.add(fn);
    }
  }

  private trigger(event: LayerTreeEvent) {
    this.eventMap.get(event)?.forEach((cb) => cb());
  }

  notifyUpdate() {
    this.trigger("nodeUpdated");
  }
  notifyAdd() {
    this.trigger("nodeAdded");
  }
  notifyRemove() {
    this.trigger("nodeRemoved");
  }
  notifyMove() {
    this.trigger("nodeMoved");
  }

  findNodeById(id: string): LayerTreeNode | null {
    if (id === "root") return this.root;
    const walk = (node: LayerTreeNode): LayerTreeNode | null => {
      if (node.id === id) return node;
      if (node.type === "group") {
        for (const child of (node as LayerGroup).children) {
          const found = walk(child);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(this.root);
  }

  addNode(node: LayerTreeNode, parentId = "root") {
    const parent = this.findNodeById(parentId);
    if (!parent || parent.type !== "group") return;
    (parent as LayerGroup).insertChildAt(node, (parent as LayerGroup).children.length);
    this.notifyAdd();
  }

  removeNodeRecursive(nodeId: string) {
    const node = this.findNodeById(nodeId);
    if (!node || !node.parent) return;
    const parent = node.parent;
    const idx = parent.children.findIndex((c) => c.id === nodeId);
    if (idx > -1) parent.children.splice(idx, 1);
    node.parent = null;
    this.notifyRemove();
  }
  // 导出整棵图层树JSON（仅导出root.children，root自身不参与UI）
  serialize() {
    return this.root.children.map((node) => {
      if (node.type === "group") {
        return (node as LayerGroup).toJSON();
      } else {
        return (node as VectorLayer).toJSON();
      }
    });
  }

  // 根据数组JSON重建图层树
  deserialize(listJson: unknown[]) {
    // 清空原有所有子节点
    this.root.children.length = 0;
    for (const item of listJson) {
      if (!item || typeof item !== "object") continue;
      const json = item as Record<string, unknown>;
      let node: LayerTreeNode;
      if (json.type === "group") {
        node = LayerGroup.fromJSON(json);
      } else if (json.type === "vector") {
        node = VectorLayer.fromJSON(json);
      } else continue;
      this.root.insertChildAt(node, this.root.children.length);
    }
    this.notifyAdd();
  }
  getTreeView(): LayerTreeViewNode[] {
    const mapNode = (n: LayerTreeNode): LayerTreeViewNode => {
      const base = { ...n };
      if (n.type === "group") {
        return {
          ...base,
          children: (n as LayerGroup).children.map(mapNode),
        };
      }
      return { ...base, children: [] };
    };
    return [...this.root.children.map(mapNode)];
  }
}

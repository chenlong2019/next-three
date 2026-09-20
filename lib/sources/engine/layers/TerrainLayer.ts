import { LayerTreeNode } from "../../types/layers";
import { v4 as uuidv4 } from "uuid";
import { LayerGroup } from "./LayerGroup";

export class TerrainLayer implements LayerTreeNode {
  public readonly id: string;
  public name: string;
  public readonly type = "terrain";
  public show = true;
  public locked = false;
  public parent: LayerGroup | null = null;

  constructor(name: string, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
  }
}

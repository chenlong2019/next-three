import { LayerTreeNode } from "../../types/layers";
import { v4 as uuidv4 } from "uuid";
import { LayerGroup } from "./LayerGroup";

export interface RasterLayerOption {
  url: string;
  opacity?: number;
}

export class RasterLayer implements LayerTreeNode {
  public readonly id: string;
  public name: string;
  public readonly type = "raster";
  public show = true;
  public locked = false;
  public parent: LayerGroup | null = null;

  public url: string;
  public opacity: number;

  constructor(name: string, opt: RasterLayerOption, id?: string) {
    this.id = id ?? uuidv4();
    this.name = name;
    this.url = opt.url;
    this.opacity = opt.opacity ?? 1;
  }
}

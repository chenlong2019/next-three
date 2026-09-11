import { Graphic } from "../engine/graphic/Graphic";
import { Layer } from "../engine/layers/Layer";
import { LayerGroup } from "../engine/layers/LayerGroup";
import { BasePrimitive } from "../engine/primitives/BasePrimitive";

/**
 * 图层节点基础接口（分组Group 和 图层Layer 统一实现该接口）
 */
export interface ILayerNode {
  readonly id: string;
  name: string;
  show: boolean;
  locked: boolean;
  parent: ILayerNode | null;
  children: ILayerNode[];

  // 递归设置显隐
  setVisibleRecursive(value: boolean): void;
}

export interface LayerTreeNode {
  id: string;
  name: string;
  type: LayerNodeType;
  show: boolean;
  locked: boolean;
  parent: LayerGroup | null;
  children?: LayerTreeNode[];
  primitives?: BasePrimitive[];
  toJSON?: () => object | null;
}
/**
 * 叶子节点：普通图层（承载Graphic图元）
 */
export interface ILayer extends ILayerNode {
  readonly type: "layer";
  readonly graphics: Graphic[];
  addGraphic(graphic: Graphic): void;
  getGraphicById(graphicId: string): Graphic | undefined;
  removeGraphic(graphicId: string): boolean;
  clearGraphics(): void;
}

/**
 * 分支节点：图层分组/文件夹（只能包含子节点，不能放Graphic）
 */
export interface ILayerGroup extends ILayerNode {
  readonly type: "group";
  addChild(node: ILayerNode): void;
  removeChild(nodeId: string): boolean;
}

export type LayerTreeEvents = {
  nodeAdded?: (node: LayerTreeNode, parent: LayerTreeNode | null) => void;
  nodeRemoved?: (node: LayerTreeNode, parent: LayerTreeNode | null) => void;
  nodeMoved?: (node: LayerTreeNode) => void;
  nodeUpdated?: (node: LayerTreeNode) => void;
};

export interface LayerCreateOptions {
  id?: string;
  name: string;
  show?: boolean;
  locked?: boolean;
}

export interface LayerGroupCreateOptions {
  id?: string;
  name: string;
  show?: boolean;
  locked?: boolean;
}
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

/**
 * 图层基础事件类型
 */
export type LayerCollectionEvents = {
  /** 图层新增 */
  layerAdded?: (layer: Layer, index: number) => void;
  /** 图层移除 */
  layerRemoved?: (layer: Layer, index: number) => void;
  /** 图层顺序移动 */
  layerMoved?: (layer: Layer, newIndex: number, oldIndex: number) => void;
  /** 图层信息变更（名称、显隐、锁定等） */
  layerUpdated?: (layer: Layer) => void;
};

/**
 * 图层类接口定义（方便依赖倒置）
 */
export interface ILayer {
  readonly id: string;
  name: string;
  show: boolean;
  locked: boolean;
  readonly graphics: Graphic[];

  addGraphic(graphic: Graphic): void;
  getGraphicById(graphicId: string): Graphic | undefined;
  removeGraphic(graphicId: string): boolean;
  clearGraphics(): void;
}

export type LayerNodeType = "layer" | "group" | "vector" | "terrain" | "raster";

// 树视图结构，供给图层树UI渲染使用
export type LayerTreeViewNode = LayerTreeNode & {
  children: LayerTreeViewNode[];
};

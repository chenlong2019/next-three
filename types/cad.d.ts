export interface LayerParam {
  name: string;
  colorIndex: number;
  frozen: boolean;
  off: boolean;
  noblock?: boolean;
  type?: string;
}

export interface ViewPortData {
  viewTarget: { x: number; y: number; z: number };
  viewDirectionFromTarget: { x: number; y: number; z: number };
  lensLength: number;
}

export interface CadEntityStat {
  text: number;
  line: number;
  circle: number;
  polyline: number;
  point: number;
  dim: number;
  other: number;
}

export interface CadEntity {
  handle: string;
  ownerHandle: string;
  layer: string;
  type: string;
  name?: string;
}

export interface BlockData {
  entities: CadEntity[];
}

export interface CadJsonData {
  header: Record<string, unknown>;
  tables: {
    viewPort: { viewPorts: ViewPortData[] };
    layer: { layers: Record<string, LayerParam> };
  };
  entities: CadEntity[];
  blocks: Record<string, BlockData>;
}

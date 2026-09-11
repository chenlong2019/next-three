// types/snap.ts

export enum SnapType {
  NONE = "none",

  GRID = "grid",

  VERTEX = "vertex",

  EDGE = "edge",

  OBJECT = "object",
}

export interface SnapResult {
  snapped: boolean;

  point: {
    x: number;
    y: number;
    z: number;
  };

  type: SnapType;

  target?: unknown;
}

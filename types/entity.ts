export enum EntityType {
  TRENCH = "trench",

  WALL = "wall",

  CABLE = "cable",

  RACK = "rack",

  TRANSFORMER = "transformer",
}

export interface Point3D {
  x: number;

  y: number;

  z: number;
}

export interface SceneEntity {
  id: string;

  name: string;

  type: EntityType;

  transform: {
    position: {
      x: number;
      y: number;
      z: number;
    };

    rotation: {
      x: number;
      y: number;
      z: number;
    };

    scale: {
      x: number;
      y: number;
      z: number;
    };
  };

  geometry?: {
    positions: Point3D[];
  };

  properties: {
    depth?: number;

    material?: string;

    modelUrl?: string;
  };
}

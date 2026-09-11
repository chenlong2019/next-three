import type { ComponentType } from "react";
import { demoRoutes, type DemoKey } from "../demoRoutes";
import BuildingTilesDemo from "./BuildingTilesDemo";
import DaylightCityDemo from "./DaylightCityDemo";
import CesiumTerrainDemo from "./CesiumTerrainDemo";
import DrawDemo from "./DrawDemo";
import GoogleTileDemo from "./GoogleTileDemo";
import PhotogrammetryDemo from "./PhotogrammetryDemo";
import SceneInitDemo from "./SceneInitDemo";
import type { DemoProps } from "./ExampleShared";

export interface DemoItem {
  key: DemoKey;
  label: string;
  component: ComponentType<DemoProps>;
  immersive?: boolean;
}

const demoComponents: Record<DemoKey, ComponentType<DemoProps>> = {
  "scene-init": SceneInitDemo,
  "google-tiles": GoogleTileDemo,
  "cesium-terrain": CesiumTerrainDemo,
  photogrammetry: PhotogrammetryDemo,
  "xiamen-buildings": BuildingTilesDemo,
  "xiamen-daylight": DaylightCityDemo,
  draw: DrawDemo,
};

export const demoList: DemoItem[] = demoRoutes.map((route) => ({
  ...route,
  component: demoComponents[route.key],
}));

export type DemoComponent = ComponentType<DemoProps>;

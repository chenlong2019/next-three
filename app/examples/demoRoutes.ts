export const demoRoutes = [
  { key: "scene-init", label: "场景初始化" },
  { key: "google-tiles", label: "多源瓦片加载" },
  { key: "cesium-terrain", label: "Cesium 地形加载" },
  { key: "photogrammetry", label: "倾斜摄影加载" },
  { key: "xiamen-buildings", label: "厦门建筑 3D Tiles" },
  { key: "xiamen-daylight", label: "厦门城市日景", immersive: true },
  { key: "draw", label: "点线面绘制" },
] as const;

export type DemoKey = (typeof demoRoutes)[number]["key"];

export const defaultDemoKey: DemoKey = demoRoutes[0].key;

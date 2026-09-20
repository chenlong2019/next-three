# next-three

next-three 是一个基于 Next.js 16、React 19 和 Three.js 的浏览器端三维 GIS / CAD 示例项目。项目重点实现了 Web Mercator 坐标管理、瓦片图层调度、Cesium quantized-mesh 地形、3D Tiles、绘制工具和图层树管理。

## 在线访问

GitHub Pages 会同时部署示例页面和 API 文档：

- 项目首页：<https://chenlong2019.github.io/next-three/>
- GIS 示例：<https://chenlong2019.github.io/next-three/examples/>
- API 文档：<https://chenlong2019.github.io/next-three/docs/>
- Google 瓦片全屏示例：<https://chenlong2019.github.io/next-three/examples/google-tiles/fullscreen/>

推送到 `master` 分支后，`.github/workflows/deploy-pages.yml` 会自动构建并发布 `dist/`。

## 作为通用库使用（three-gis）

`lib/` 可以独立打包成框架无关的 npm 包 **three-gis**，供原生 HTML、Vue、React 等任意前端场景安装使用：

```bash
npm run build:lib      # 产出 lib/dist/：ESM + CJS + 全局脚本 + 类型声明
npm run verify:lib     # 产物验证：CJS/ESM/类型通道 + 真实浏览器渲染
```

```ts
import { Scene, WebMercatorGIS, TileLayer } from "three-gis";

const gis = new WebMercatorGIS(118.1371, 24.49);
const scene = new Scene(container, { gis });
await scene.ready();
scene.add(new TileLayer("https://example.com/{z}/{x}/{y}.png", gis));
scene.flyTo(118.1371, 24.49, 120000);
```

安装方式、各框架接入示例与产物说明见 [`lib/README.md`](./lib/README.md)。
库构建配置在 `lib/rollup.config.mjs` 与 `lib/tsconfig.build.json`，原生 HTML 可直接打开的示例在 `lib/examples/`。

## 主要能力

- Web Mercator 与 WGS84 坐标互转，使用局部原点降低 Three.js 浮点精度问题。
- Three.js 场景、透视相机、OrbitControls、Z-Up GIS 控制器和相机飞行动画。
- XYZ / Google 瓦片、WMS、WMTS、TMS 栅格图层。
- GeoJSON 水面、道路和铁路图层。
- Cesium quantized-mesh 地形，支持 Ion 资源、地形可用范围回退、父级 fallback、地形夸张和 Google 影像贴合。
- OGC 3D Tiles，支持 b3dm / glTF、屏幕空间误差调度、视锥裁剪和白模样式。
- 点、折线、多边形绘制和基础 Primitive。
- 图层树、显示 / 锁定状态、拖拽排序、复制 / 剪切 / 粘贴和场景 JSON 导入导出。
- 全局请求调度器，按 server 限制并发，支持优先级、取消和 Google `{s}` 子域轮换。
- 独立 Demo 路由和浏览器全屏地图路由。
- TypeDoc API 文档和静态导出构建。

## 技术栈

| 类别       | 技术                                                |
| ---------- | --------------------------------------------------- |
| 应用框架   | Next.js 16.2.9、App Router                          |
| UI         | React 19、CSS Modules、Tailwind CSS 4、Lucide React |
| 三维渲染   | Three.js 0.162                                      |
| 状态与交互 | Zustand、React DnD                                  |
| 文档       | TypeDoc、typedoc-plugin-markdown                    |
| 语言与检查 | TypeScript 5、ESLint 9                              |
| 输出模式   | Next.js `output: "export"` 静态导出                 |

## 开发环境

- Node.js `>= 20.9.0`
- npm
- 建议使用支持 WebGL2 的现代浏览器

## 快速开始

```bash
npm install
npm run dev
```

开发服务器默认运行在：

```text
http://localhost:12345
```

主要入口：

- GIS Demo：`http://localhost:12345/examples/`
- 场景 / 图层编辑器：`http://localhost:12345/sceneengine/`
- API 文档：`http://localhost:12345/docs/`

## 环境变量

在项目根目录创建 `.env.local`：

```env
# Cesium World Terrain quantized-mesh 服务
NEXT_PUBLIC_CESIUM_TERRAIN_URL=https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0

# 建议使用仅允许访问目标资产的 Cesium Ion Token
NEXT_PUBLIC_CESIUM_ION_TOKEN=your_cesium_ion_token

# 倾斜摄影 / 3D Tiles 服务
NEXT_PUBLIC_TILES3D_URL=http://localhost:8084/tileset.json

# 厦门建筑 3D Tiles，默认使用 public/models/xiamen-buildings/tileset.json
NEXT_PUBLIC_XIAMEN_BUILDINGS_URL=/models/xiamen-buildings/tileset.json

# 天地图浏览器端 Key；不配置时使用演示默认 tk
NEXT_PUBLIC_TIANDITU_TOKEN=your_tianditu_browser_token
```

`NEXT_PUBLIC_*` 变量会进入浏览器端产物，不应写入具有高权限或长期有效的服务端密钥。Cesium Ion Token 应限制为所需的 Asset ID 和权限范围。

## Demo 路由

每个 Demo 都有独立、可刷新、可分享的 URL：

| 路由                          | 内容                                 |
| ----------------------------- | ------------------------------------ |
| `/examples/scene-init/`       | 场景、相机、控制器和 WebGL 初始化    |
| `/examples/google-tiles/`     | 天地图 / Google XYZ 瓦片、注记与 LOD |
| `/examples/cesium-terrain/`   | Cesium quantized-mesh 地形与影像贴合 |
| `/examples/photogrammetry/`   | OGC 3D Tiles 倾斜摄影                |
| `/examples/xiamen-buildings/` | 厦门建筑 3D Tiles                    |
| `/examples/xiamen-daylight/`  | 白模日景、阴影、自动环绕和预设视角   |
| `/examples/draw/`             | 点、折线、多边形绘制                 |

全视口地图路由：

```text
/examples/<demo>/fullscreen/
```

例如：

```text
/examples/google-tiles/fullscreen/
/examples/cesium-terrain/fullscreen/
```

全视口路由只显示地图。浏览器不允许页面加载后自动隐藏地址栏，因此需要通过页面上的全屏按钮触发 Fullscreen API。

## 核心目录

```text
app/
├── examples/                    # Demo 路由和示例组件
├── sceneengine/                 # 场景、图层树和工具栏页面
├── docs/                        # TypeDoc Markdown 浏览器
└── layout.tsx                   # App Router 根布局

lib/sources/
├── core/
│   ├── Scene.ts                 # Three.js 场景和图层树入口
│   └── CameraController.ts      # 相机飞行、缩放和姿态控制
├── engine/
│   ├── layers/                  # XYZ/WMS/WMTS/TMS/地形/3D Tiles/GeoJSON
│   ├── primitives/              # 点、线、面、盒体、球体等 Primitive
│   ├── controller/              # GIS Orbit 和编辑器控制器
│   ├── materials/               # 建筑自定义材质
│   └── utils/                   # 相机、GIS 和瓦片工具
├── gis/
│   └── WebMercatorGIS.ts        # WGS84 / Web Mercator / 局部坐标转换
└── examples/
    ├── createMapExample.ts      # GIS Demo 公共运行时
    └── createDraw.ts            # 点线面绘制运行时

scripts/                         # 调度器、地形和材质回归脚本
public/                          # 本地模型、GeoJSON、纹理和静态数据
docs/api/                        # npm run docs:api 生成，不手动编辑
dist/                            # npm run build 生成，不手动编辑
```

## 基础用法

### 初始化场景

```ts
import { Scene } from "@/lib/sources/core/Scene";
import { WebMercatorGIS } from "@/lib/sources/gis/WebMercatorGIS";

const gis = new WebMercatorGIS(118.1371, 24.49);
const scene = new Scene(container, { gis });

await scene.ready();
scene.flyTo(118.1371, 24.49, 10000);

// React effect cleanup
scene.destroy();
```

### Google XYZ 瓦片

```ts
import { TileLayer } from "@/lib/sources/engine/layers/TileLayer";

const google = new TileLayer("https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", gis, {
  minZoom: 1,
  maxZoom: 19,
  maxConcurrent: 50,
  maxRequestsPerFrame: 6,
  maxCacheSize: 240,
  subdomains: ["0", "1", "2", "3"],
});

scene.add(google);
google.updateTilesInView(lngBounds, latBounds, zoom, cameraTarget, cameraDistance);
```

### Cesium quantized-mesh 地形

```ts
import { CesiumTerrainLayer } from "@/lib/sources/engine/layers/CesiumTerrainLayer";

const terrain = new CesiumTerrainLayer(
  gis,
  {
    terrainUrl: process.env.NEXT_PUBLIC_CESIUM_TERRAIN_URL!,
    accessToken: process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN!,
  },
  {
    minZoom: 1,
    maxZoom: 15,
    terrainZoomOffset: 0,
    imageryZoomOffset: -1,
    imageryMaxCanvasSize: 512,
    imageryUrlTemplate:
      "https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=YOUR_TK",
  },
);

scene.add(terrain);
terrain.update();
terrain.updateTilesInView(
  lngBounds,
  latBounds,
  zoom,
  cameraTarget,
  cameraDistance,
  camera.position,
);
```

地形实际可请求的最高层级同时受以下因素影响：

- `maxZoom` 配置。
- Terrain `layer.json` 的 `maxzoom`。
- 当前经纬度在 `available` 范围中的可用层级。
- 影像拼接画布尺寸与目标地形瓦片覆盖范围。

### 3D Tiles

```ts
import { Tiles3DLayer } from "@/lib/sources/engine/layers/Tiles3DLayer";

const tiles = new Tiles3DLayer(
  gis,
  { url: "/models/xiamen-buildings/tileset.json" },
  {
    maximumScreenSpaceError: 12,
    maxConcurrent: 10,
    maxRequestsPerFrame: 4,
    maxCacheSize: 64,
    enableFrustumCulling: false,
  },
);

scene.add(tiles);
scene.addFrameCallback("tiles3d-update", () => {
  tiles.update(scene.getCamera()!, container.clientHeight);
});
```

### 请求调度

普通栅格瓦片、地形请求和地形影像请求统一经过 `RequestScheduler`；3D Tiles 内容使用 `Tiles3DLayer` 自己的队列和并发配置。

- 默认全局最多 50 个活动请求。
- 默认每个 origin 最多 6 个活动请求。
- 数值越小优先级越高。
- 支持 `AbortSignal` 取消尚未发起的请求。
- Google 影像可通过 `{s}` 分散到 `mt0` 到 `mt3`。

## 常用命令

```bash
# 开发
npm run dev

# ESLint
npm run lint

# Prettier 格式化
npm run format

# TypeScript 类型检查
npx tsc --noEmit

# 生成 TypeDoc Markdown
npm run docs:api

# 生产构建，输出到 dist/
npm run build
```

## 回归脚本

```bash
node scripts/test-request-scheduler.mjs
node scripts/test-terrain-tiling.mjs
node scripts/test-daylight-material.mjs
node scripts/verify-daylight-demo.mjs
```

其中 `verify-daylight-demo.mjs` 用于需要运行页面或浏览器环境的验证场景。

## 静态部署

`next.config.ts` 使用：

```ts
output: "export";
distDir: "dist";
trailingSlash: true;
```

执行 `npm run build` 后，将 `dist/` 部署到任意静态文件服务器。由于项目使用静态导出，以下能力不可用：

- 服务端请求时动态路由。
- Cookies、Headers、Rewrites 和动态重定向。
- 需要 Node.js 运行时的 Route Handler。
- 默认 Next.js 图片优化服务。

静态服务器需要正确支持 `/examples/google-tiles/` 这类目录路径，并返回对应的 `index.html`。由于是静态导出，不建议使用 `next start` 作为生产部署方式。

### GitHub Pages

仓库使用 GitHub Actions 部署到项目子路径：

```text
https://chenlong2019.github.io/next-three/
```

工作流构建时设置：

```env
NEXT_PUBLIC_BASE_PATH=/next-three
```

该变量会让 Next.js 路由、静态资源以及 `public/models`、`public/data` 中的示例数据统一从 `/next-three/` 访问。首次部署需要在仓库的 `Settings -> Pages` 中将 Source 设为 `GitHub Actions`。

## 常见问题

### Cesium 地形返回 401

检查 `NEXT_PUBLIC_CESIUM_ION_TOKEN` 是否有效，并确认 Token 允许访问对应 Asset ID。重新构建或重启开发服务器后，`NEXT_PUBLIC_*` 变量才会更新到浏览器产物。

### 地形最高层级低于 `maxZoom`

`maxZoom` 只是应用上限。Terrain 服务没有在目标区域提供更高层级时，图层会回退到最近可用祖先瓦片。

### 地形影像请求层级和请求数量

影像层级由相机高度和屏幕分辨率确定，不以地形层级为基准。`imageryZoomOffset` 控制相对相机推荐层级的偏移；负值会减少请求数量并让单张影像覆盖更大的屏幕范围。`imageryMaxCanvasSize` 限制每个地形瓦片的影像拼接预算。

### 瓦片「一块块冒出来」的节奏

影像瓦片就绪后不会立即上屏，而是按「入场节拍」依次淡入，避免同一帧集中亮起（观感上像放鞭炮）。默认一整批约在 420ms 内出清，块多时间隔自动变密、块少时变疏。初始化可调：

- `revealSpreadMs`：整批希望全部亮起的时长；调小=清晰更快但更急，`0` = 关闭节拍（就绪即上屏）
- `revealMaxSlotMs`：单块入场间隔上限，避免只有几块时慢慢挤
- `revealMaxWaitMs`：候场超过该时长强制优先入场，保证节拍不拖慢清晰度
- `revealMaxPerFrame`：同一帧最多放行的块数，低帧率时补偿节拍

相机手势（拖拽/缩放）期间每次视图更新放行的影像升级块数由 `imageryInteractingBudget` 控制，默认 `2`；设为 `0` 回到「手势内完全冻结」（拖动期间偏糊、松手后集中补课）。

### 静态部署刷新子路由返回 404

确认静态服务器支持 `trailingSlash` 目录结构，例如 `/examples/google-tiles/` 应返回 `dist/examples/google-tiles/index.html`。

### 模型或瓦片请求失败

检查服务端 CORS、Token、网络地址和 HTTPS 配置。浏览器端加载的 3D Tiles、地形和影像服务都需要允许当前站点跨域访问。

## 开发约定

- 项目使用 Next.js 16，开发前应查阅 `node_modules/next/dist/docs/` 中的本地版本文档。
- 三维运行时代码依赖浏览器 API，应在 Client Component 的 `useEffect` 中初始化并清理。
- 生成目录 `dist/` 和 `docs/api/` 不应手动编辑。
- 新增公开 API 时应补充注释，并运行 `npm run docs:api`、`npm run lint`、`npx tsc --noEmit` 和 `npm run build`。

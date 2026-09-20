# three-gis

浏览器端三维 GIS / CAD 空间引擎。基于 [Three.js](https://threejs.org/)，提供 Web Mercator 坐标系统、栅格瓦片调度、Cesium quantized-mesh 地形、OGC 3D Tiles、GeoJSON、矢量图元与地图风格事件 API。

**框架无关**：不依赖 React、Vue、Next.js 或任何构建工具，同一套 API 可以跑在原生 HTML、Vue、React、Svelte 或任意打包器里。除了 `three` 之外没有运行时依赖。

## 特性

- **坐标系统**：WGS84 / Web Mercator / Three.js 局部坐标互转，用局部原点避免大范围场景的浮点抖动。
- **图层模型**：`TileLayer`（XYZ）、`TMSLayer`、`WMSLayer`、`WMTSLayer`、`CesiumTerrainLayer`、`Tiles3DLayer`、`GeoJSONLayer`、`VectorLayer`、`LayerGroup`、`LayerTree`。
- **地形**：Cesium quantized-mesh，支持 Ion 资源、可用范围回退、父级 fallback、地形夸张、影像贴地；瓦片网格与影像拼接在 Web Worker 里完成。
- **3D Tiles**：b3dm / glTF，屏幕空间误差调度、视锥裁剪、白模样式。
- **交互**：`Map` 提供 Mapbox 风格的事件与视口查询；GIS Orbit 控制器、相机飞行动画、点线面交互式绘制。
- **资源治理**：全局 `RequestScheduler` 按 server / group 限制并发，支持优先级、取消、失败冷却和磁盘缓存。
- **类型完整**：随包提供合并后的 `index.d.ts`，开箱即用的 TypeScript 提示。

## 安装

```bash
npm install three-gis three
```

`three` 是 peer dependency（本库按 `>=0.162.0 <1.0.0` 声明），必须由业务项目自己安装，避免出现两份 Three.js 实例。使用 TypeScript 时还需要：

```bash
npm install -D @types/three
```

> Three.js 从 r175 起自带类型；更早的版本需要单独安装 `@types/three`。

## 快速开始

### 最快上手：`createViewer`

一个调用把渲染器、坐标系、图层和帧循环全部装配好：

```ts
import { createViewer } from "three-gis";

const viewer = await createViewer("app", {
  center: [116.4, 39.9], // 场景中心 [经度, 纬度]
  height: 1500000, // 相机视高（米）
  imagery: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
});

viewer.flyTo({ center: [121.47, 31.23], height: 8000 }); // 动画飞向上海
viewer.setView({ center: [116.4, 39.9], height: 20000, pitch: 55 }); // 瞬时切换 + 斜视
```

对照 Cesium，差别只剩"把 token 换成资源地址"：

```ts
// Cesium
Cesium.Ion.defaultAccessToken = "你的_token";
const viewer = new Cesium.Viewer("app");
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(116.4, 39.9, 1500000),
});

// three-gis
const viewer = await createViewer("app", {
  center: [116.4, 39.9],
  height: 1500000,
});
```

`createViewer` 内部按顺序完成：由 `center` 派生 `WebMercatorGIS` 局部原点 → 创建 `Scene` → 等待 WebGL 就绪 → 装配影像 / 地形 / 3D Tiles / GeoJSON 图层 → 设置初始视口 → 注册帧循环（自动计算视口边界与层级、按 200ms 节流选片、推动 `terrain.update()` 与 `tiles3d.update()`、手势期间自动降低影像升级预算）。这些原本都需要调用方自己写。

#### 选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `center` | `[116.4, 39.9]` | 场景中心 `[经度, 纬度]`，同时作为局部坐标原点 |
| `origin` | 同 `center` | 单独指定局部原点，用于大范围漫游时压低浮点误差 |
| `height` | `10000` | 相机视高（米） |
| `pitch` | `90` | 俯角（度），90 = 正俯视，45 = 斜视 |
| `heading` | `0` | 航向角（度），0 = 正北朝上 |
| `imagery` | — | XYZ 模板字符串、配置对象，或两者数组 |
| `terrain` | — | `{ terrainUrl, accessToken, ...CesiumTerrainLayer 选项 }` |
| `tiles3d` | — | `{ url, ...Tiles3DLayer 选项 }` 或 url 字符串，可传数组 |
| `geojson` | — | `GeoJSONLayerOptions[]`（水系 / 道路 / 铁路） |
| `backgroundColor` | `0x1a1a1a` | 场景背景色 |
| `updateIntervalMs` | `200` | 选区与调度节流间隔，`0` 表示每帧 |
| `three` | — | 透传 `ThreeUtilsOptions`（fov / near / far / 后期处理等） |

返回的 `viewer` 暴露底层对象与常用方法：`scene`、`gis`、`camera`、`container`、`layers.{imagery,terrain,tiles3d,geojson}`、`setView()`、`flyTo()`、`add(object)`、`destroy()`。

带地形的完整写法：

```ts
const viewer = await createViewer("app", {
  center: [118.14, 24.5],
  height: 8000,
  imagery: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
  terrain: {
    terrainUrl:
      "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0",
    accessToken: "你的受限 token",
    // imageryUrlTemplate 缺省复用 imagery 的第一条 url，地形自动贴上底图
  },
  tiles3d: { url: "/assets/city/tileset.json", maximumScreenSpaceError: 10 },
});
```

#### 零构建 HTML

```html
<div id="app" style="position:absolute;inset:0"></div>
<script src="./three-gis.global.js"></script>
<script>
  ThreeGIS.createViewer("app", {
    center: [116.4, 39.9],
    height: 1500000,
    imagery: "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
  }).then((viewer) => {
    window.addEventListener("beforeunload", () => viewer.destroy());
  });
</script>
```

#### Vue 3

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef } from "vue";
import { createViewer, type Viewer } from "three-gis";

const viewer = shallowRef<Viewer | null>(null);

onMounted(async () => {
  viewer.value = await createViewer("app", { center: [116.4, 39.9], height: 1500000 });
});

onBeforeUnmount(() => {
  viewer.value?.destroy();
  viewer.value = null;
});
</script>

<template>
  <div id="app" style="position: absolute; inset: 0" />
</template>
```

#### React 18 / 19

```tsx
import { useEffect, useRef } from "react";
import { createViewer, type Viewer } from "three-gis";

export function CadViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    void createViewer(container, { center: [116.4, 39.9], height: 1500000 }).then((viewer) => {
      // React 18 StrictMode 下 effect 会跑两次，回来时可能已经卸载
      if (disposed) {
        viewer.destroy();
        return;
      }
      viewerRef.current = viewer;
    });

    return () => {
      disposed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, []);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
```

### 底层 API：手动组装

需要精细控制（自定义相机动画、单独驱动图层、只想要渲染器）时，用底层部件自己拼：

### 原生 HTML：全局脚本（零构建）

`dist/three-gis.global.js` 已经把 Three.js 一起内联进去了，页面里不需要再引入 three：

```html
<div id="app" style="position:absolute;inset:0"></div>

<script src="./three-gis.global.js"></script>
<script>
  const { Scene, WebMercatorGIS, TileLayer } = ThreeGIS;

  const gis = new WebMercatorGIS(118.1371, 24.49);
  const scene = new Scene(document.getElementById("app"), { gis });

  scene.ready().then(() => {
    scene.flyTo(118.1371, 24.49, 120000);
    scene.add(
      new TileLayer("https://example.com/tiles/{z}/{x}/{y}.png", gis, {
        minZoom: 1,
        maxZoom: 18,
      }),
    );
  });

  // 页面卸载时释放 WebGL、事件与动画循环
  window.addEventListener("beforeunload", () => scene.destroy());
</script>
```

### 底层用法：原生 HTML ESM + importmap

ESM 产物把 `three` 保留为外部依赖，浏览器直连时用 import map 兜住：

```html
<script type="importmap">
  {
    "imports": {
      "three": "./node_modules/three/build/three.module.js",
      "three/": "./node_modules/three/"
    }
  }
</script>

<script type="module">
  import { Scene, WebMercatorGIS } from "./three-gis.mjs";
  // 其余同上
</script>
```

### 底层用法：Vite + Vue 3

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { Scene, WebMercatorGIS, TileLayer } from "three-gis";

const container = ref<HTMLDivElement | null>(null);
const scene = shallowRef<Scene | null>(null);

onMounted(async () => {
  if (!container.value) return;

  const gis = new WebMercatorGIS(118.1371, 24.49);
  const instance = new Scene(container.value, { gis });
  await instance.ready();

  instance.add(new TileLayer("https://example.com/tiles/{z}/{x}/{y}.png", gis));
  instance.flyTo(118.1371, 24.49, 120000);
  scene.value = instance;
});

onBeforeUnmount(() => {
  scene.value?.destroy();
  scene.value = null;
});
</script>

<template>
  <div ref="container" style="position: absolute; inset: 0" />
</template>
```

### 底层用法：React 18 / 19

```tsx
import { useEffect, useRef } from "react";
import { Scene, WebMercatorGIS, TileLayer } from "three-gis";

export function CadViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const gis = new WebMercatorGIS(118.1371, 24.49);
    const scene = new Scene(container, { gis });

    scene.ready().then(() => {
      // React 18 StrictMode 下 effect 会跑两次，ready 回来时可能已经卸载
      if (disposed) return;
      scene.add(new TileLayer("https://example.com/tiles/{z}/{x}/{y}.png", gis));
      scene.flyTo(118.1371, 24.49, 120000);
    });

    sceneRef.current = scene;
    return () => {
      disposed = true;
      scene.destroy();
      sceneRef.current = null;
    };
  }, []);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
```

> **Next.js / SSR**：`Scene` 只能在浏览器里构造。在 Next.js App Router 里请把上面的组件标成 `"use client"`，并用 `useEffect`（而非模块顶层或服务端渲染路径）初始化，或通过 `next/dynamic` 设置 `ssr: false` 动态引入。

## 常用 API

### 场景生命周期

```ts
const gis = new WebMercatorGIS(originLng, originLat);
const scene = new Scene(container, { gis });

await scene.ready(); // 异步初始化，推荐
scene.load((ok, msg) => {}); // 兼容旧式回调
scene.destroy(); // 释放 WebGL、事件与动画
```

容器尺寸变化由内部的 `ResizeObserver` 自动处理，无需手动调用 resize。

其他常用方法：`add()`、`flyTo()`、`addFrameCallback(key, cb)`、`removeFrameCallback(key)`、`getCamera()`、`getGIS()`、`getGISController()`、`createVectorLayer()`、`createGroup()`、`exportSceneJSON()` / `importSceneJSON()`。

### 地形

```ts
const terrain = new CesiumTerrainLayer(
  gis,
  {
    terrainUrl: "https://assets.ion.cesium.com/.../{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0",
    accessToken: "restricted-cesium-ion-token",
  },
  { minZoom: 1, maxZoom: 15, imageryZoomOffset: -1 },
);

scene.add(terrain);
terrain.update();
terrain.updateTilesInView(lngBounds, latBounds, zoom, target, cameraDistance, camera.position);
```

### 3D Tiles

```ts
const tiles = new Tiles3DLayer(gis, { url: "/assets/city/tileset.json" }, {
  maximumScreenSpaceError: 12,
});

scene.add(tiles);
scene.addFrameCallback("tiles3d", () => tiles.update(scene.getCamera()!, container.clientHeight));
```

### 地图事件

```ts
import { Map as GisMap } from "three-gis";

const map = new GisMap(scene, gis, container);
map.on("click", (event) => console.log(event.lngLat));
map.on("move", (event) => console.log(event.center, event.zoom));
map.getBounds();
map.project(118.1371, 24.49);
map.unproject(500, 300);
map.dispose();
```

### 请求调度

```ts
import { requestScheduler } from "three-gis";

requestScheduler.registerGroupLimit("my-tiles", 4); // 同一 group 的总并发上限
```

默认全局最多 50 个活动请求、每个 origin 最多 6 个；数值越小优先级越高；支持 `AbortSignal` 取消尚未发起的请求。

## 资源与安全约定

- 库**不读取**任何业务项目的 `public/` 目录或环境变量，所有地址、Token 都由调用方传入。
- 浏览器端可见的 Token 应限制资源和权限范围（例如 Cesium Ion Token 只授权目标 Asset ID），不要下发高权限长期密钥。
- 跨域资源需要服务端正确配置 CORS；浏览器控制台会直接给出跨域报错。

## 产物与导出

| 文件 | 格式 | three | 适用场景 |
| --- | --- | --- | --- |
| `dist/three-gis.mjs` | ESM | 外部依赖 | Vite / webpack / Rollup / Next.js |
| `dist/three-gis.cjs` | CommonJS | 外部依赖 | Node 侧、老构建链 |
| `dist/three-gis.global.js` | IIFE，全局 `ThreeGIS` | 已内联 | 原生 HTML `<script src>` |
| `dist/three-gis.global.min.js` | 同上，压缩版 | 已内联 | 生产环境原生 HTML |
| `dist/index.d.ts` | 类型声明 | — | TypeScript 消费者 |

包内只发布了 `dist/` 与 `README.md`，源码与示例不会进入 npm 包。

## 在仓库内构建

```bash
npm run build:lib          # 一次性构建（tsc → rollup → 类型合并）
npm run build:lib:watch    # 构建后进入 rollup 监听模式
node scripts/verify-lib.mjs  # 产物验证：CJS/ESM/类型/真实浏览器渲染
```

构建链路：

1. `tsc -p lib/tsconfig.build.json` 把 `lib/index.ts` 可达的源码编译成 ESM JS + 逐文件 d.ts 到 `lib/.rollup-tmp/`。
2. `rollup -c lib/rollup.config.mjs` 打包成 ESM / CJS / IIFE 三种格式，并用 `rollup-plugin-dts` 把类型合并成单个 `dist/index.d.ts`。
3. 清理临时目录。

构建配置刻意不继承仓库根 `tsconfig.json`，因此没有 `@/` 路径别名——一旦库源码重新引入项目别名，构建会直接失败。

## 浏览器要求

需要支持 WebGL2 的现代浏览器。`Scene` / `Map` 等运行时代码依赖 DOM，不能在服务端渲染期间构造。

## 许可

MIT

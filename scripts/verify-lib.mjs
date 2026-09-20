#!/usr/bin/env node
/**
 * three-gis 库产物验证脚本。
 *
 *   node scripts/verify-lib.mjs
 *
 * 验证内容：
 *   1. 产物完整性：ESM / CJS / 全局脚本 / 全局压缩版 / 类型声明齐全，且关键特征正确
 *      （全局版内联 three、ESM/CJS 外置 three、不残留 process.env 引用）
 *   2. package.json 的 exports / files 映射指向真实存在的文件
 *   3. 搭一个独立消费者工程，把 lib/package.json + lib/dist 按 npm 安装后的布局放进去，
 *      然后分别用 require("three-gis") / import "three-gis" / tsc 验证 CJS、ESM、类型三通道
 *   4. Playwright 起真实 Chromium，验证「全局脚本」和「ESM + importmap」两种页面
 *      都能初始化 WebGL 场景（拦截站外请求，排除网络抖动）
 *
 * 之所以要造消费者工程而不是直接 import lib/dist/xxx：只有走 node_modules 解析
 * 才能真正验证 exports 条件映射、子路径导出和 types 入口。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const libDir = path.join(rootDir, "lib");
const distDir = path.join(libDir, "dist");
const consumerDir = path.join(rootDir, ".tmp-lib-verify");
const globalDir = path.join(rootDir, "artifacts");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

if (!fs.existsSync(distDir)) {
  console.error("\n[verify-lib] 找不到 lib/dist，请先执行 npm run build:lib\n");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(libDir, "package.json"), "utf8"));

/* ================================================================== *
 * 1. 产物完整性
 * ================================================================== */
console.log("\n== 1. 产物完整性 ==");

const ARTIFACTS = [
  { file: "three-gis.mjs", min: 50_000, note: "ESM" },
  { file: "three-gis.cjs", min: 50_000, note: "CJS" },
  { file: "three-gis.global.js", min: 500_000, note: "IIFE（内联 three）" },
  { file: "three-gis.global.min.js", min: 100_000, note: "IIFE 压缩版" },
  { file: "index.d.ts", min: 5_000, note: "类型声明" },
];

for (const { file, min, note } of ARTIFACTS) {
  const full = path.join(distDir, file);
  if (!fs.existsSync(full)) {
    check(`产物 ${file}`, false, "文件缺失");
    continue;
  }
  const size = fs.statSync(full).size;
  check(`产物 ${file}（${note}）`, size >= min, kb(size));
}

const read = (file) =>
  fs.existsSync(path.join(distDir, file))
    ? fs.readFileSync(path.join(distDir, file), "utf8")
    : "";

const globalSrc = read("three-gis.global.js");
const globalMinSrc = read("three-gis.global.min.js");
const esmSrc = read("three-gis.mjs");
const cjsSrc = read("three-gis.cjs");

check(
  "全局脚本挂载 ThreeGIS 命名空间",
  globalSrc.includes("ThreeGIS") && globalMinSrc.includes("ThreeGIS"),
);
check(
  "全局脚本已内联 three（不依赖外部 THREE）",
  globalSrc.includes("WebGLRenderer") && !/^import[\s{]/m.test(globalSrc.slice(0, 400)),
);
check("全局脚本不含未替换的 process.env", !globalSrc.includes("process.env"));
check("ESM 产物不含未替换的 process.env", !esmSrc.includes("process.env"));
check("CJS 产物不含未替换的 process.env", !cjsSrc.includes("process.env"));
check(
  "ESM 产物把 three 保留为外部依赖",
  /from\s*["']three["']/.test(esmSrc),
  "避免与业务项目的 three 出现双实例",
);
check(
  "CJS 产物把 three 保留为外部依赖",
  /require\(["']three["']\)/.test(cjsSrc),
);

// 框架无关是硬承诺：产物里不允许出现任何 React / Vue / Next / 状态库的引用
const FRAMEWORK_RE =
  /(?:from\s*|require\(\s*|import\s*\(\s*)["'](react|react-dom|vue|next\/?|zustand|lucide)[/"']/;
for (const [name, source] of [
  ["three-gis.mjs", esmSrc],
  ["three-gis.cjs", cjsSrc],
  ["three-gis.global.js", globalSrc],
  ["three-gis.global.min.js", globalMinSrc],
]) {
  check(
    `${name} 不引用任何 UI 框架`,
    !FRAMEWORK_RE.test(source),
    FRAMEWORK_RE.test(source) ? "检测到 react/vue/next/zustand 引用" : "纯框架无关",
  );
}

/* ================================================================== *
 * 2. exports / files 映射
 * ================================================================== */
console.log("\n== 2. package.json 映射 ==");

const exportEntries = Object.entries(pkg.exports ?? {});
let exportOk = true;
for (const [key, value] of exportEntries) {
  const targets =
    typeof value === "string" ? [value] : Object.values(value).filter((v) => typeof v === "string");
  for (const target of targets) {
    if (target.includes("*")) continue;
    const resolved = path.join(libDir, target);
    if (!fs.existsSync(resolved)) {
      check(`exports["${key}"] → ${target}`, false, "目标文件不存在");
      exportOk = false;
    }
  }
}
if (exportOk) check(`exports 映射目标全部存在（${exportEntries.length} 条）`, true);

const filesMissing = (pkg.files ?? []).filter((entry) => !fs.existsSync(path.join(libDir, entry)));
check(
  `files 字段指向的内容都存在`,
  filesMissing.length === 0,
  filesMissing.length ? `缺失：${filesMissing.join(", ")}` : `files = ${JSON.stringify(pkg.files)}`,
);

check(
  "依赖分层正确（three 为 peer，uuid 不进运行时依赖）",
  Boolean(pkg.peerDependencies?.three) && !pkg.dependencies,
  `peer=${pkg.peerDependencies?.three ?? "无"}`,
);

/* ================================================================== *
 * 3. 独立消费者工程
 * ================================================================== */
console.log("\n== 3. 独立消费者（CJS / ESM / 类型）==");

const EXPECTED_EXPORTS = [
  "Scene",
  "Map",
  "CameraController",
  "WebMercatorGIS",
  "WEB_MERCATOR_MAX_LATITUDE",
  "Layer",
  "LayerGroup",
  "LayerTree",
  "LayerCollection",
  "RasterLayer",
  "RasterTileLayer",
  "VectorLayer",
  "TerrainLayer",
  "TileLayer",
  "TMSLayer",
  "WMSLayer",
  "WMTSLayer",
  "CesiumTerrainLayer",
  "Tiles3DLayer",
  "GeoJSONLayer",
  "RequestScheduler",
  "requestScheduler",
  "getRequestServerKey",
  "TileRequestQueue",
  "TileLoadState",
  "TileDiskCache",
  "getTileDiskCache",
  "TerrainMeshWorkerPool",
  "upsampleTerrainMesh",
  "ImageryStitchPool",
  "BasePrimitive",
  "BoxPrimitive",
  "SpherePrimitive",
  "PolygonPrimitive",
  "PolylinePrimitive",
  "PrimitiveFactory",
  "PrimitiveCollection",
  "Graphic",
  "BaseGraphic",
  "PointGraphic",
  "LineGraphic",
  "PolygonGraphic",
  "SceneDrawingManager",
  "DrawingTaskManager",
  "drawingManager",
  "DrawMode",
  "drawEntityToPrimitive",
  "primitiveToDrawEntity",
  "GISOrbitController",
  "EditorController",
  "ViewportFloatingController",
  "createDaylightBuildingMaterial",
  "prepareDaylightGeometry",
  "ThreeUtils",
  "getHorizonDistance",
  "getViewGroundCorners",
  "cornersToLngLatBounds",
  "getSuggestZoom",
  "iterateTilesInBounds",
  "amapTileToLngLatBounds",
  "osmTileToLngLatBounds",
  "tileXYFromLngLat",
  "getTileBounds",
  "lngLatToTile",
  "PICKABLE_LAYER",
  "HELPER_LAYER",
  "ToolType",
  "DEFAULT_TILE_SUBDOMAINS",
  "getTileRequestGroup",
  "replaceTileTemplate",
];

fs.rmSync(consumerDir, { recursive: true, force: true });
const installedPkgDir = path.join(consumerDir, "node_modules", "three-gis");
fs.mkdirSync(installedPkgDir, { recursive: true });
fs.copyFileSync(path.join(libDir, "package.json"), path.join(installedPkgDir, "package.json"));
fs.cpSync(distDir, path.join(installedPkgDir, "dist"), { recursive: true });

const probeBody = `const EXPECTED = ${JSON.stringify(EXPECTED_EXPORTS)};
const missing = EXPECTED.filter((name) => !(name in lib));
if (missing.length) throw new Error("缺失公共导出: " + missing.join(", "));
if (typeof lib.Scene !== "function") throw new Error("Scene 不是构造函数");
if (typeof lib.WebMercatorGIS !== "function") throw new Error("WebMercatorGIS 不是构造函数");
if (typeof lib.TileLayer !== "function") throw new Error("TileLayer 不是构造函数");
if (typeof lib.requestScheduler?.schedule !== "function") throw new Error("requestScheduler 未导出实例");
console.log("OK " + Object.keys(lib).length + " exports");
`;

fs.writeFileSync(
  path.join(consumerDir, "cjs-probe.cjs"),
  `const lib = require("three-gis");\n${probeBody}`,
);
fs.writeFileSync(
  path.join(consumerDir, "esm-probe.mjs"),
  `import * as lib from "three-gis";\n${probeBody}`,
);

// --- CJS ---
const cjsRun = spawnSync(process.execPath, ["cjs-probe.cjs"], {
  cwd: consumerDir,
  encoding: "utf8",
});
check(
  'require("three-gis") 可用',
  cjsRun.status === 0,
  (cjsRun.status === 0 ? cjsRun.stdout : cjsRun.stderr).trim().split("\n").slice(0, 4).join(" | "),
);

// --- ESM ---
const esmRun = spawnSync(process.execPath, ["esm-probe.mjs"], {
  cwd: consumerDir,
  encoding: "utf8",
});
const esmOut = (esmRun.status === 0 ? esmRun.stdout : esmRun.stderr).trim();
check(
  'import "three-gis" 可用',
  esmRun.status === 0,
  esmOut.split("\n").slice(0, 6).join(" | "),
);
check(
  `公共导出齐全（期望 ${EXPECTED_EXPORTS.length} 个）`,
  esmRun.status === 0,
  esmRun.status === 0 ? `实际 ${esmOut.replace(/^OK /, "")} 个` : "见上一条错误",
);

// --- 类型 ---
fs.writeFileSync(
  path.join(consumerDir, "consumer.ts"),
  `import {
  Scene,
  WebMercatorGIS,
  TileLayer,
  CesiumTerrainLayer,
  Tiles3DLayer,
  GeoJSONLayer,
  VectorLayer,
  LayerGroup,
  BoxPrimitive,
  SpherePrimitive,
  PolygonPrimitive,
  PolylinePrimitive,
  PointGraphic,
  LineGraphic,
  PolygonGraphic,
  Map as GisMap,
  SceneDrawingManager,
  DrawingTaskManager,
  requestScheduler,
  getViewGroundCorners,
  cornersToLngLatBounds,
  getSuggestZoom,
  type SceneOptions,
  type TileLayerOptions,
  type CesiumTerrainLayerOptions,
  type Tiles3DLayerOptions,
  type GeoJSONLayerOptions,
  type LngLat,
  type LayerTreeNode,
  type CameraViewTarget,
} from "three-gis";
import * as THREE from "three";

const gis = new WebMercatorGIS(118.1371, 24.49);
const sceneOptions: SceneOptions = { gis };
declare const container: HTMLDivElement;

const scene = new Scene(container, sceneOptions);
const tileOptions: TileLayerOptions = { minZoom: 1, maxZoom: 18 };
const tile = new TileLayer("https://example.com/{z}/{x}/{y}.png", gis, tileOptions);

const terrainOptions: CesiumTerrainLayerOptions = { minZoom: 1, maxZoom: 15 };
const terrain = new CesiumTerrainLayer(
  gis,
  { terrainUrl: "https://example.com/{z}/{x}/{y}.terrain", accessToken: "token" },
  terrainOptions,
);

const tiles3dOptions: Tiles3DLayerOptions = { maximumScreenSpaceError: 12 };
const tiles3d = new Tiles3DLayer(gis, { url: "/tileset.json" }, tiles3dOptions);

const geojsonOptions: GeoJSONLayerOptions = { url: "/data.geojson", kind: "roads" };
const geojson = new GeoJSONLayer(gis, geojsonOptions);

const vector = new VectorLayer("测试图层");
const group = new LayerGroup("分组");
const node: LayerTreeNode = group;
const lngLat: LngLat = [118.1371, 24.49];
const target: CameraViewTarget | null = null;

const position = new THREE.Vector3(0, 0, 10);
const box = new BoxPrimitive({ position, style: { width: 1, height: 1, depth: 1 } });
const sphere = new SpherePrimitive({ position, style: { color: "#39c0ff", radius: 1 } });
const polygon = new PolygonPrimitive({
  points: [position, position, position],
  style: { color: "#39c0ff", depth: 2 },
});
const polyline = new PolylinePrimitive({
  points: [position, position],
  style: { color: "#39c0ff", lineWidth: 2 },
});
const point = new PointGraphic({ position, style: { color: "#39c0ff", size: 1 } });
const line = new LineGraphic({
  points: [position, position],
  style: { color: "#39c0ff", width: 1 },
});
const polygonGraphic = new PolygonGraphic({
  points: [position, position, position],
  style: { fillColor: "#39c0ff", strokeColor: "#ffffff", opacity: 0.6 },
});

const map = new GisMap(scene, gis, container);
const sceneDrawing = new SceneDrawingManager(
  new THREE.Scene(),
  new THREE.PerspectiveCamera(),
  container,
);
const tasks = new DrawingTaskManager();

const corners = getViewGroundCorners(new THREE.PerspectiveCamera(), 0);
const bounds = cornersToLngLatBounds(corners, gis);
const zoom = getSuggestZoom(1000, 45, 800, 24.49);
const active = requestScheduler.activeRequestCount;

export const used = [
  tile,
  terrain,
  tiles3d,
  geojson,
  vector,
  node,
  lngLat,
  target,
  box,
  sphere,
  polygon,
  polyline,
  point,
  line,
  polygonGraphic,
  map,
  sceneDrawing,
  tasks,
  bounds,
  zoom,
  active,
];
`,
);

fs.writeFileSync(
  path.join(consumerDir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2020",
        lib: ["dom", "dom.iterable", "esnext"],
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  ),
);

const TSC_BIN = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const tscRun = spawnSync(
  process.execPath,
  [TSC_BIN, "-p", path.join(consumerDir, "tsconfig.json"), "--pretty", "false"],
  { cwd: rootDir, encoding: "utf8" },
);
check(
  "TypeScript 消费者能从产物声明推导类型",
  tscRun.status === 0,
  tscRun.status === 0
    ? "tsc --noEmit 通过"
    : (tscRun.stdout || tscRun.stderr || "")
        .split("\n")
        .filter(Boolean)
        .slice(0, 8)
        .join(" | "),
);

/* ================================================================== *
 * 4. 浏览器渲染验证
 * ================================================================== */
console.log("\n== 4. 浏览器渲染验证 ==");

let playwright = null;
try {
  playwright = await import("playwright");
} catch (error) {
  check("Playwright 可用", false, `import 失败：${error.message}，跳过浏览器用例`);
}

const PAGE_CASES = [
  { name: "全局脚本 <script src>", url: "/lib/examples/html-global.html", shot: "lib-global.png" },
  { name: "ESM + importmap", url: "/lib/examples/html-esm.html", shot: "lib-esm.png" },
  {
    name: "createViewer 一站式初始化",
    url: "/lib/examples/html-viewer.html",
    shot: "lib-viewer.png",
  },
];

if (playwright) {
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
  };

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const target = path.join(rootDir, path.normalize(urlPath));
    if (!target.startsWith(rootDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
    });
    fs.createReadStream(target).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  let browser = null;
  const LAUNCH_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
  ];
  // 优先用 Playwright 自带的 Chromium；没下载浏览器时退回到系统里的 Chrome / Edge，
  // 避免为了跑验证额外下载上百 MB 的浏览器内核。
  const LAUNCH_ATTEMPTS = [
    { label: "自带 Chromium", options: {} },
    { label: "系统 Chrome", options: { channel: "chrome" } },
    { label: "系统 Edge", options: { channel: "msedge" } },
  ];
  const launchErrors = [];
  for (const attempt of LAUNCH_ATTEMPTS) {
    try {
      browser = await playwright.chromium.launch({ ...attempt.options, args: LAUNCH_ARGS });
      console.log(`  [INFO] 浏览器内核：${attempt.label}`);
      break;
    } catch (error) {
      launchErrors.push(`${attempt.label}: ${error.message.split("\n")[0]}`);
    }
  }
  if (!browser) check("Chromium 启动", false, launchErrors.join(" / "));

  if (browser) {
    for (const testCase of PAGE_CASES) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const pageErrors = [];
      const badResponses = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("response", (response) => {
        // 同源非 2xx 才是真问题；站外请求被下面的 route 主动 abort，不算失败
        if (response.url().startsWith(origin) && response.status() >= 400) {
          badResponses.push(`${response.status()} ${response.url()}`);
        }
      });
      page.on("console", (message) => {
        // "Failed to load resource" 是被拦掉的站外瓦片请求的噪音，忽略
        if (message.type() === "error" && !/Failed to load resource/.test(message.text())) {
          pageErrors.push(`console: ${message.text()}`);
        }
      });

      // 拦截站外请求：示例里的天地图瓦片受网络影响，这里只验证引擎本身
      await page.route("**/*", (route) => {
        const target = route.request().url();
        if (target.startsWith(origin) || target.startsWith("data:")) return route.continue();
        return route.abort();
      });

      try {
        await page.goto(origin + testCase.url, { waitUntil: "load", timeout: 30_000 });
        await page
          .waitForFunction(
            () => window.__threeGisReady === true || typeof window.__threeGisError === "string",
            undefined,
            { timeout: 30_000 },
          )
          .catch(() => {});

        const state = await page.evaluate(() => {
          const demo = window.__threeGisDemo;
          const canvas = document.querySelector("#app canvas");
          const gl = canvas ? canvas.getContext("webgl2") || canvas.getContext("webgl") : null;
          const camera = demo?.scene?.getCamera?.();
          return {
            error: window.__threeGisError ?? null,
            ready: window.__threeGisReady === true,
            probes: {
              bootFn: typeof window.bootThreeGis,
              globalNs: typeof window.ThreeGIS,
              appEl: Boolean(document.getElementById("app")),
            },
            status: document.getElementById("status")?.textContent ?? "",
            hasCanvas: Boolean(canvas),
            width: canvas?.width ?? 0,
            height: canvas?.height ?? 0,
            glLost: gl ? gl.isContextLost() : null,
            glVersion: gl?.getParameter?.(gl.VERSION) ?? null,
            hasCamera: Boolean(camera),
            layerAttached: Boolean(demo?.imagery?.parent),
          };
        });

        const ok =
          state.ready &&
          !state.error &&
          state.hasCanvas &&
          state.width > 0 &&
          state.height > 0 &&
          state.glLost === false &&
          state.hasCamera &&
          pageErrors.length === 0 &&
          badResponses.length === 0;

        check(
          `浏览器用例：${testCase.name}`,
          ok,
          ok
            ? `canvas ${state.width}×${state.height} · ${state.glVersion} · ${state.status}`
            : state.error ||
              pageErrors.join(" | ") ||
              badResponses.join(" | ") ||
              `探针 ${JSON.stringify(state.probes)} / 状态 ${JSON.stringify(state)}`,
        );

        fs.mkdirSync(globalDir, { recursive: true });
        await page.screenshot({ path: path.join(globalDir, testCase.shot) });
      } catch (error) {
        check(
          `浏览器用例：${testCase.name}`,
          false,
          `${error.message} | ${pageErrors.join(" | ")} | ${badResponses.join(" | ")}`,
        );
      } finally {
        await page.close();
      }
    }

    // 功能性验证：createViewer 的 setView 是否真的把视口搬到了目标经纬度与视高
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", (route) => {
        const target = route.request().url();
        if (target.startsWith(origin) || target.startsWith("data:")) return route.continue();
        return route.abort();
      });

      try {
        await page.goto(`${origin}/lib/examples/html-viewer.html`, {
          waitUntil: "load",
          timeout: 30_000,
        });
        await page
          .waitForFunction(
            () => window.__threeGisReady === true || typeof window.__threeGisError === "string",
            undefined,
            { timeout: 30_000 },
          )
          .catch(() => {});

        const loaded = await page.evaluate(() => {
          const demo = window.__threeGisDemo;
          const controller = demo?.scene?.getGISController?.();
          return {
            error: window.__threeGisError ?? null,
            ready: window.__threeGisReady === true,
            imageryCount: demo?.viewer?.layers?.imagery?.length ?? 0,
            imageryAttached: Boolean(demo?.imagery?.parent),
            target: controller?.getTargetLngLat?.() ?? null,
          };
        });

        const moved = await page.evaluate(() => {
          const viewer = window.__threeGisDemo?.viewer;
          if (!viewer) return null;
          viewer.setView({ center: [121.47, 31.23], height: 600000 });
          const controller = viewer.scene.getGISController();
          const [lng, lat, altitude] = viewer.gis.threeToLngLat(viewer.camera.position);
          return {
            target: controller.getTargetLngLat(),
            cameraLngLat: [lng, lat],
            cameraAltitude: altitude,
          };
        });

        const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
        const ok =
          Boolean(loaded.ready) &&
          !loaded.error &&
          loaded.imageryCount >= 1 &&
          loaded.imageryAttached &&
          Boolean(loaded.target) &&
          near(loaded.target?.[0], 116.4, 0.01) &&
          near(loaded.target?.[1], 39.9, 0.01) &&
          Boolean(moved) &&
          near(moved?.target?.[0], 121.47, 0.01) &&
          near(moved?.target?.[1], 31.23, 0.01) &&
          near(moved?.cameraLngLat?.[0], 121.47, 0.01) &&
          near(moved?.cameraLngLat?.[1], 31.23, 0.01) &&
          near(moved?.cameraAltitude, 600000, 1000) &&
          errors.length === 0;

        check(
          "createViewer：图层装配 + setView 搬运视口",
          ok,
          ok
            ? `初始目标 ${loaded.target.map((v) => v.toFixed(3)).join(", ")} → setView 后 ` +
              `${moved.target.map((v) => v.toFixed(3)).join(", ")}，视高 ${Math.round(moved.cameraAltitude)}m，` +
              `影像图层 ${loaded.imageryCount} 个`
            : `loaded=${JSON.stringify(loaded)} / moved=${JSON.stringify(moved)} / ${errors.join(" | ")}`,
        );
      } catch (error) {
        check("createViewer：图层装配 + setView 搬运视口", false, error.message);
      } finally {
        await page.close();
      }
    }

    await browser.close();
  }

  await new Promise((resolve) => server.close(resolve));
}

fs.rmSync(consumerDir, { recursive: true, force: true });

/* ================================================================== *
 * 汇总
 * ================================================================== */
const failed = results.filter((item) => !item.ok);
console.log(`\n== 汇总：${results.length - failed.length}/${results.length} 通过 ==\n`);
if (failed.length) {
  for (const item of failed) console.log(`  FAIL  ${item.name} — ${item.detail}`);
  console.log("");
  process.exit(1);
}
console.log("three-gis 产物验证全部通过。\n");

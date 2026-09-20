/**
 * 诊断：倾斜视角下"屏幕最下方一条"是否落在视图 AABB 之外。
 *
 * 原理：视图 AABB 来自「屏幕四角射线 ∩ z=planeZ 平面」。近处地形若高于
 * planeZ，底边射线会先打到地形（比平面交点更靠近相机），这一段地面就
 * 在 AABB 之外——只能靠底图毯（层级极低、影像永不升级）顶着，
 * 表现为「最下方一栏底层级瓦片没有被替换」。
 * 是否真的露出一条，取决于瓦片网格边界是否恰好落在这一段里，所以按
 * 俯仰角扫描。
 *
 * 运行：TERRAIN_H=800 node scripts/diag-near-band-scan.cjs [lng] [lat] [高度]
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

require.extensions[".ts"] = function (module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const ROOT = path.resolve(__dirname, "..");
const METADATA_CACHE = path.join(__dirname, ".terrain-metadata.json");

const fakeCanvas = () => {
  const element = {
    style: {},
    getContext() {
      return {
        drawImage() {},
        clearRect() {},
        fillRect() {},
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        setTransform() {},
        imageSmoothingEnabled: false,
      };
    },
  };
  let width = 0;
  let height = 0;
  Object.defineProperty(element, "width", {
    get: () => width,
    set: (v) => {
      width = v;
    },
  });
  Object.defineProperty(element, "height", {
    get: () => height,
    set: (v) => {
      height = v;
    },
  });
  return element;
};
global.document = { createElement: () => fakeCanvas(), createElementNS: () => fakeCanvas() };
global.createImageBitmap = async (blob) => ({ width: 256, height: 256, close() {}, __blob: blob });

function buildTerrainBuffer() {
  const TERRAIN_H = Number(process.env.TERRAIN_H ?? 0);
  const vertexCount = 4;
  const buffer = new ArrayBuffer(88 + 4 + vertexCount * 2 * 3 + 4 + 6 * 2);
  const view = new DataView(buffer);
  view.setFloat32(24, 0, true);
  view.setFloat32(28, TERRAIN_H, true);
  view.setUint32(88, vertexCount, true);
  let offset = 92;
  for (const values of [
    [0, 32767, 32767, 0],
    [0, 0, 32767, 32767],
    TERRAIN_H > 0 ? [32767, 32767, 32767, 32767] : [0, 32767, 32767, 0],
  ]) {
    let prev = 0;
    values.forEach((value, i) => {
      const delta = value - prev;
      prev = value;
      const encoded = delta < 0 ? ((-delta << 1) | 1) : delta << 1;
      view.setUint16(offset + i * 2, encoded, true);
    });
    offset += vertexCount * 2;
  }
  view.setUint32(offset, 2, true);
  offset += 4;
  [0, 0, 0, 1, 2, 0].forEach((code, i) => view.setUint16(offset + i * 2, code, true));
  return buffer;
}

const TERRAIN_BUFFER = buildTerrainBuffer();
const TERRAIN_BASE = "https://terrain.example.com/world";

const realFetch = global.fetch;
async function loadTerrainMetadata() {
  if (fs.existsSync(METADATA_CACHE)) return JSON.parse(fs.readFileSync(METADATA_CACHE, "utf8"));
  const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  const token = (env.match(/NEXT_PUBLIC_CESIUM_ION_TOKEN\s*=\s*(.+)/)?.[1] ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  const endpoint = await (
    await realFetch(`https://api.cesium.com/v1/assets/1/endpoint?access_token=${token}`)
  ).json();
  const base = endpoint.url.replace(/\/$/, "");
  const metadata = await (
    await realFetch(`${base}/layer.json?access_token=${endpoint.accessToken}`)
  ).json();
  fs.writeFileSync(METADATA_CACHE, JSON.stringify(metadata));
  return metadata;
}

let metadata = { available: null };

global.fetch = async (url) => {
  const target = String(url);
  if (target.includes("layer.json")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tiles: [`${TERRAIN_BASE}/{z}/{x}/{y}.terrain`],
        maxzoom: metadata.maxzoom,
        available: metadata.available,
        scheme: metadata.scheme,
      }),
    };
  }
  if (/\.terrain/.test(target)) {
    return {
      ok: true,
      status: 200,
      blob: async () => ({ arrayBuffer: async () => TERRAIN_BUFFER.slice(0) }),
    };
  }
  if (/[?&]z=\d+/.test(target)) {
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(8)]) };
  }
  return { ok: false, status: 404, blob: async () => new Blob(["x"]) };
};

const THREE = require(path.join(ROOT, "node_modules/three"));
const { CesiumTerrainLayer } = require(path.join(
  ROOT,
  "lib/sources/engine/layers/CesiumTerrainLayer.ts",
));
const { WebMercatorGIS } = require(path.join(ROOT, "lib/sources/gis/WebMercatorGIS.ts"));
const { getSuggestZoom, getViewGroundCorners, cornersToLngLatBounds } = require(path.join(
  ROOT,
  "lib/sources/engine/utils/camera-utils.ts",
));

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const FOV = 60;
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERRAIN_H = Number(process.env.TERRAIN_H ?? 0);

function createLayer(gis) {
  return new CesiumTerrainLayer(
    gis,
    { terrainUrl: TERRAIN_BASE, accessToken: "" },
    {
      minZoom: 1,
      maxZoom: 15,
      maxConcurrent: 10,
      maxQueueSize: 160,
      maxRequestsPerFrame: 8,
      maxTileRendersPerFrame: 4,
      tileYOrigin: "south",
      terrainZoomOffset: 0,
      imageryZoomOffset: 0,
      imageryMaxCanvasSize: 1024,
      terrainTilePixelSize: 512,
      maximumScreenSpaceError: 4,
      maxTilesPerView: 128,
      maxCacheSize: 256,
      exaggeration: 1,
      imageryUrlTemplate: "https://mt{s}.example.com/vt/x={x}&y={y}&z={z}",
      imagerySubdomains: ["0", "1", "2", "3"],
      imageryRequestGroup: "google",
      imageryMaximumRequestsPerServer: 12,
      maximumRequestsPerServer: 10,
      prefetchTileBudget: 0,
      revealSpreadMs: 0,
    },
  );
}

function geoTileBoundsLocal(x, y, zoom, yOrigin) {
  const numX = Math.pow(2, zoom + 1);
  const numY = Math.pow(2, zoom);
  const west = (x / numX) * 360 - 180;
  const east = ((x + 1) / numX) * 360 - 180;
  const north = yOrigin === "north" ? 90 - (y / numY) * 180 : ((y + 1) / numY) * 180 - 90;
  const south = yOrigin === "north" ? 90 - ((y + 1) / numY) * 180 : (y / numY) * 180 - 90;
  return { west, east, south, north };
}

function makeCamera(target, altitude, pitchDeg) {
  const camera = new THREE.PerspectiveCamera(FOV, VIEWPORT_WIDTH / VIEWPORT_HEIGHT, 1, 2e7);
  camera.up.set(0, 0, 1);
  const pitch = (pitchDeg * Math.PI) / 180;
  const distance = altitude / Math.sin(pitch);
  camera.position.set(0, -distance * Math.cos(pitch), altitude);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

async function main() {
  metadata = await loadTerrainMetadata();
  const lng = Number(process.argv[2] ?? 118.1371);
  const lat = Number(process.argv[3] ?? 24.49);
  const altitude = Number(process.argv[4] ?? 3000);

  const gis = new WebMercatorGIS(lng, lat);
  const target = gis.lngLatToThree(lng, lat, 0);
  const layer = createLayer(gis);
  await idle(80);

  const originalWarn = console.warn;
  console.warn = () => {};

  console.log(
    `TERRAIN_H=${TERRAIN_H} 高度=${altitude}m  planeZ=0  近地补齐= getMaxObservedSurfaceHeight（修复后行为）`,
  );
  console.log(
    "俯仰 | AABB南缘lat | 底边地面lat | 底边地面在AABB外 | 可见集覆盖 | 渲染覆盖 | 底图毯层级",
  );
  console.log("-".repeat(104));

  // 预热：先让一批地形加载完成，使 getMaxObservedSurfaceHeight 生效
  // （真实应用里首次更新时地形高度也尚未观测到，随后迅速收敛）
  {
    const camera = makeCamera(target, altitude, 60);
    const cameraDistance = camera.position.distanceTo(target);
    const bounds = cornersToLngLatBounds(getViewGroundCorners(camera, 0), gis);
    if (bounds) {
      layer.updateTilesInView(
        [bounds.west, bounds.east],
        [bounds.south, bounds.north],
        getSuggestZoom(cameraDistance, FOV, VIEWPORT_HEIGHT, lat),
        target,
        cameraDistance,
        camera.position,
        getSuggestZoom(Math.max(camera.position.z, 1), FOV, VIEWPORT_HEIGHT, lat),
        camera,
        VIEWPORT_WIDTH,
        VIEWPORT_HEIGHT,
      );
      for (let i = 0; i < 60; i++) {
        layer.update();
        await idle(16);
      }
    }
  }
  console.log(`预热完成：maxObservedSurfaceHeight=${layer.getMaxObservedSurfaceHeight()}`);

  for (let pitch = 36; pitch <= 60; pitch += 2) {
    const camera = makeCamera(target, altitude, pitch);
    const cameraDistance = camera.position.distanceTo(target);
    // 与修复后的 createMapExample 一致：用地形观测高度做近地补齐
    const groundRelief = Math.max(
      0,
      (layer.getMaxObservedSurfaceHeight() ?? 0) - 0,
    );
    const bounds = cornersToLngLatBounds(
      getViewGroundCorners(camera, 0, { groundRelief }),
      gis,
    );
    if (!bounds) continue;
    layer.updateTilesInView(
      [bounds.west, bounds.east],
      [bounds.south, bounds.north],
      getSuggestZoom(cameraDistance, FOV, VIEWPORT_HEIGHT, lat),
      target,
      cameraDistance,
      camera.position,
      getSuggestZoom(Math.max(camera.position.z, 1), FOV, VIEWPORT_HEIGHT, lat),
      camera,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    // 稳定片刻，让该俯仰角的瓦片加载完
    for (let i = 0; i < 40; i++) {
      layer.update();
      await idle(16);
    }
    layer.updateTilesInView(
      [bounds.west, bounds.east],
      [bounds.south, bounds.north],
      getSuggestZoom(cameraDistance, FOV, VIEWPORT_HEIGHT, lat),
      target,
      cameraDistance,
      camera.position,
      getSuggestZoom(Math.max(camera.position.z, 1), FOV, VIEWPORT_HEIGHT, lat),
      camera,
      VIEWPORT_WIDTH,
      VIEWPORT_HEIGHT,
    );
    for (let i = 0; i < 40; i++) {
      layer.update();
      await idle(16);
    }

    // 底边（NDC-Y=-1）地面点：打在地形高度平面上
    const raycaster = new THREE.Raycaster();
    const terrainPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -TERRAIN_H);
    const bottomPoints = [];
    for (const ndcX of [-1, -0.5, 0, 0.5, 1]) {
      raycaster.setFromCamera(new THREE.Vector2(ndcX, -1), camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(terrainPlane, hit)) {
        bottomPoints.push(gis.threeToLngLat(hit));
      }
    }

    const covering = (lngP, latP, source, rendered) => {
      let best = null;
      const iterable = rendered ? layer.loadedTiles : layer.currentVisibleKeys;
      for (const item of iterable) {
        const key = rendered ? item[0] : item;
        const entry = rendered ? item[1] : null;
        if (rendered) {
          if (!entry.mesh.visible) continue;
          if (!((entry.mesh.material?.opacity ?? 0) > 0.01)) continue;
        }
        const [x, y, zoom] = key.split(",").map(Number);
        const b = geoTileBoundsLocal(x, y, zoom, layer.tileYOrigin ?? "south");
        if (lngP < b.west || lngP > b.east || latP < b.south || latP > b.north) continue;
        if (!best || zoom > best.zoom) best = { key, zoom };
      }
      return best;
    };

    let uncovered = 0;
    let renderedUncovered = 0;
    let minSelZoom = Infinity;
    const details = [];
    for (const p of bottomPoints) {
      const inAABB =
        p[0] >= bounds.west && p[0] <= bounds.east && p[1] >= bounds.south && p[1] <= bounds.north;
      const sel = covering(p[0], p[1], layer.currentVisibleKeys, false);
      const ren = covering(p[0], p[1], layer.loadedTiles, true);
      if (!inAABB) uncovered++;
      if (!ren) renderedUncovered++;
      if (sel) minSelZoom = Math.min(minSelZoom, sel.zoom);
      details.push(
        `${p[1].toFixed(5)}${inAABB ? "" : "⚠"}/${sel ? sel.zoom : "无"}/${ren ? ren.zoom : "无"}`,
      );
    }
    // 底图毯层级（fallback 里最粗的已加载瓦片）
    let blanketZoom = Infinity;
    for (const key of layer.loadedTiles.keys()) {
      const z = Number(key.split(",")[2]);
      if (z < blanketZoom) blanketZoom = z;
    }
    console.log(
      `${String(pitch).padStart(4)} | ${bounds.south.toFixed(5).padStart(12)} | ` +
        `${Math.min(...bottomPoints.map((p) => p[1])).toFixed(5).padStart(12)} | ` +
        `${String(uncovered).padStart(4)}/${bottomPoints.length} | ` +
        `sel最细z${Number.isFinite(minSelZoom) ? minSelZoom : "-"} 渲染缺口${renderedUncovered} | ` +
        `最粗加载z${Number.isFinite(blanketZoom) ? blanketZoom : "-"}`,
    );
    if (uncovered > 0 || renderedUncovered > 0) {
      console.log("      底边各列 [lat(⚠=AABB外)/可见集zoom/渲染zoom]: " + details.join("  "));
    }
  }

  console.warn = originalWarn;
  layer.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

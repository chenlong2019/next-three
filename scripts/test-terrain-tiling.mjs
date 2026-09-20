import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import ts from "typescript";
import * as THREE from "three";

function loadTypeScript(relativePath, dependencies = {}) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url));
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const source = new Module(filename);
  source.filename = filename;
  source.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = source.require.bind(source);
  source.require = (name) => dependencies[name] ?? originalRequire(name);
  source._compile(output, filename);
  return source.exports;
}

const gisModule = loadTypeScript("../lib/sources/gis/WebMercatorGIS.ts");
const requestSchedulerModule = loadTypeScript("../lib/sources/engine/layers/RequestScheduler.ts");
const tileUrlTemplateModule = loadTypeScript("../lib/sources/engine/layers/TileUrlTemplate.ts");
const gisUtilsModule = loadTypeScript("../lib/sources/engine/utils/gis-utils.ts");
const tileRequestQueueModule = loadTypeScript("../lib/sources/engine/layers/TileRequestQueue.ts", {
  "./RequestScheduler": requestSchedulerModule,
  "./TileUrlTemplate": tileUrlTemplateModule,
});
const rasterLayerModule = loadTypeScript("../lib/sources/engine/layers/RasterTileLayer.ts", {
  "../../gis/WebMercatorGIS": gisModule,
  "../utils/gis-utils": gisUtilsModule,
  "./TileRequestQueue": tileRequestQueueModule,
});
const { CesiumTerrainLayer } = loadTypeScript(
  "../lib/sources/engine/layers/CesiumTerrainLayer.ts",
  {
    "../../gis/WebMercatorGIS": gisModule,
    "./RequestScheduler": requestSchedulerModule,
    "./TileUrlTemplate": tileUrlTemplateModule,
    "../utils/gis-utils": gisUtilsModule,
  },
);

function terrainFixture() {
  const buffer = new ArrayBuffer(120);
  const view = new DataView(buffer);
  view.setFloat32(24, 10, true);
  view.setFloat32(28, 100, true);
  view.setUint32(88, 3, true);
  [0, 65534, 65533, 0, 0, 65534, 0, 0, 65534].forEach((value, i) =>
    view.setUint16(92 + i * 2, value, true),
  );
  view.setUint32(110, 1, true);
  return buffer;
}

const originalFetch = globalThis.fetch;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const tickTerrain = async (layer) => {
  await tick();
  layer.update();
};
try {
  for (const test of [
    { name: "local TMS", host: "http://127.0.0.1:8080", metadata: { scheme: "tms" }, y: 5210 },
    {
      name: "remote TMS",
      host: "https://terrain.example.test",
      metadata: { scheme: "tms" },
      y: 5210,
    },
    { name: "slippyMap", metadata: { scheme: "slippyMap" }, y: 2981 },
    { name: "unspecified scheme", metadata: {}, y: 5210 },
    { name: "legacy files only", status: 404, y: 5210 },
    { name: "explicit north", origin: "north", y: 2981 },
    { name: "explicit south", origin: "south", y: 5210 },
  ]) {
    const urls = [];
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      return requestUrl.endsWith("/layer.json")
        ? new Response(JSON.stringify(test.metadata ?? {}), { status: test.status ?? 200 })
        : new Response(terrainFixture());
    };
    const gis = new gisModule.WebMercatorGIS(118.1371, 24.49);
    const terrain = new CesiumTerrainLayer(
      gis,
      {
        terrainUrl: test.host ?? "https://terrain.example.test",
        accessToken: "",
      },
      { tileYOrigin: test.origin, terrainZoomOffset: 0 },
    );
    try {
      await tick();
      terrain.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
      await tickTerrain(terrain);
      const requests = urls.filter((url) => url.endsWith(".terrain"));
      assert.ok(requests.length >= 1, test.name);
      assert.ok(
        requests.some((url) => url.endsWith(`/13/13568/${test.y}.terrain`)),
        test.name,
      );
      assert.ok(
        requests.some((url) => url.includes("/12/")),
        `${test.name} parent fallback`,
      );
      assert.equal(terrain.hasLoadedTiles(), true, test.name);
      const geometry = terrain.children[0].geometry;
      const position = geometry.attributes.position;
      const uv = geometry.attributes.uv;
      const index = geometry.getIndex();
      assert.ok(index, `${test.name} triangle index`);
      assert.equal(index.count % 3, 0, `${test.name} triangles`);
      let nonDegenerateTriangles = 0;
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        assert.ok(a < position.count && b < position.count && c < position.count);
        const ax = position.getX(a);
        const ay = position.getY(a);
        const az = position.getZ(a);
        const abx = position.getX(b) - ax;
        const aby = position.getY(b) - ay;
        const abz = position.getZ(b) - az;
        const acx = position.getX(c) - ax;
        const acy = position.getY(c) - ay;
        const acz = position.getZ(c) - az;
        const crossX = aby * acz - abz * acy;
        const crossY = abz * acx - abx * acz;
        const crossZ = abx * acy - aby * acx;
        const doubledArea = Math.hypot(crossX, crossY, crossZ);
        assert.ok(Number.isFinite(doubledArea));
        if (doubledArea > 1e-6) nonDegenerateTriangles++;
      }
      assert.ok(nonDegenerateTriangles > 0, `${test.name} non-degenerate triangles`);
      for (let i = 0; i < position.count; i++) {
        assert.ok(Number.isFinite(position.getY(i)));
        assert.ok(uv.getY(i) >= 0 && uv.getY(i) <= 1);
      }
      assert.equal(
        urls.some((url) => url.endsWith("layer.json")),
        !test.origin,
      );
    } finally {
      terrain.dispose();
    }
    console.log(`PASS ${test.name}`);
  }

  {
    const urls = [];
    const available = Array.from({ length: 13 }, () => []);
    available[12] = [{ startX: 6784, endX: 6784, startY: 2605, endY: 2605 }];
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      urls.push(requestUrl);
      return requestUrl.endsWith("/layer.json")
        ? new Response(JSON.stringify({ scheme: "tms", available }))
        : new Response(terrainFixture());
    };
    const terrain = new CesiumTerrainLayer(
      new gisModule.WebMercatorGIS(118.1371, 24.49),
      { terrainUrl: "https://terrain.example.test", accessToken: "" },
      { tileYOrigin: "auto", terrainZoomOffset: 0 },
    );
    try {
      await tick();
      terrain.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
      await tickTerrain(terrain);
      const requests = urls.filter((url) => url.endsWith(".terrain"));
      assert.ok(requests.some((url) => url.endsWith("/12/6784/2605.terrain")));
      assert.ok(!requests.some((url) => url.includes("/13/")), JSON.stringify(requests));
      assert.equal(terrain.hasLoadedTiles(), true);
    } finally {
      terrain.dispose();
    }
    console.log("PASS unavailable target level falls back to ancestor");
  }

  {
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      return requestUrl.endsWith(".terrain")
        ? new Response(terrainFixture())
        : new Response(JSON.stringify({ scheme: "tms" }));
    };
    const layer = new CesiumTerrainLayer(
      new gisModule.WebMercatorGIS(0, 0),
      { terrainUrl: "https://terrain.example.test", accessToken: "" },
      {
        tileYOrigin: "south",
        minZoom: 1,
        maxZoom: 2,
        maxTileRendersPerFrame: 1,
        maxRequestsPerFrame: 8,
        maxConcurrent: 8,
        maxTilesPerView: 16,
      },
    );
    try {
      layer.updateTilesInView([-170, 170], [-80, 80], 2);
      for (let index = 0; index < 20; index++) await tick();

      const readyBeforeFrame = layer.pendingTerrainRenders.length;
      assert.ok(
        readyBeforeFrame > 1,
        `multiple terrain tiles should await frame commits: ${readyBeforeFrame}`,
      );
      const loadedBeforeFrame = layer.loadedTiles.size;
      layer.update();
      assert.equal(layer.loadedTiles.size, loadedBeforeFrame + 1);
      layer.update();
      assert.equal(layer.loadedTiles.size, loadedBeforeFrame + 2);
    } finally {
      layer.dispose();
    }
    console.log("PASS terrain meshes are committed within a per-frame budget");
  }

  {
    let targetAttempts = 0;
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/1/2/1.terrain")) {
        targetAttempts++;
        if (targetAttempts === 1) throw new Error("transient terrain failure");
      }
      return new Response(terrainFixture());
    };
    const layer = new CesiumTerrainLayer(
      new gisModule.WebMercatorGIS(0.1, 0.1),
      { terrainUrl: "https://terrain.example.test", accessToken: "" },
      {
        tileYOrigin: "south",
        terrainZoomOffset: 0,
        minZoom: 1,
        maxZoom: 1,
        maxLodLevels: 0,
        maxConcurrent: 2,
        maxRequestsPerFrame: 2,
      },
    );
    layer.retryCooldown = 0;
    try {
      const bounds = [0.1, 0.2];
      layer.updateTilesInView(bounds, bounds, 1);
      for (let index = 0; index < 30; index++) {
        await tickTerrain(layer);
        if (layer.getViewportLoadState().failed > 0) break;
      }
      let state = layer.getViewportLoadState();
      assert.equal(state.failed, 1, JSON.stringify(state));
      assert.deepEqual(state.failedKeys, ["2,1,1"]);
      assert.equal(state.complete, false);

      layer.updateTilesInView(bounds, bounds, 1);
      for (let index = 0; index < 30; index++) {
        await tickTerrain(layer);
        if (layer.getViewportLoadState().complete) break;
      }
      state = layer.getViewportLoadState();
      assert.equal(targetAttempts, 2, JSON.stringify({ state, targetAttempts }));
      assert.equal(state.complete, true, JSON.stringify(state));
      assert.equal(state.failed, 0, JSON.stringify(state));
    } finally {
      layer.dispose();
    }
    console.log("PASS visible failed tiles are retried until the viewport completes");
  }

  {
    let missingTileAttempts = 0;
    globalThis.fetch = async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/1/2/1.terrain")) {
        missingTileAttempts++;
        return new Response("missing", { status: 404 });
      }
      return new Response(terrainFixture());
    };
    const layer = new CesiumTerrainLayer(
      new gisModule.WebMercatorGIS(0.1, 0.1),
      { terrainUrl: "https://terrain.example.test", accessToken: "" },
      {
        tileYOrigin: "south",
        terrainZoomOffset: 0,
        minZoom: 1,
        maxZoom: 1,
        maxLodLevels: 0,
        maxConcurrent: 2,
        maxRequestsPerFrame: 2,
      },
    );
    try {
      const bounds = [0.1, 0.2];
      for (let index = 0; index < 20; index++) {
        layer.updateTilesInView(bounds, bounds, 1);
        await tickTerrain(layer);
      }
      assert.equal(
        missingTileAttempts,
        1,
        JSON.stringify({
          missingTileAttempts,
          failures: [...layer.failedTiles.entries()],
        }),
      );
      assert.equal(layer.failedTiles.get("2,1,1")?.permanent, true);
    } finally {
      layer.dispose();
    }
    console.log("PASS permanent 404 terrain tiles are not requested repeatedly");
  }

  let finishMetadata;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      finishMetadata = resolve;
    });
  const layer = new CesiumTerrainLayer(new gisModule.WebMercatorGIS(0, 0), {
    terrainUrl: "https://terrain.example.test",
    accessToken: "",
  });
  layer.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
  assert.equal(layer.children.length, 0);
  layer.dispose();
  finishMetadata(new Response(JSON.stringify({ scheme: "slippyMap" })));
  await tick();
  layer.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
  assert.equal(layer.children.length, 0);
  console.log("PASS disposal while metadata is pending");
} finally {
  globalThis.fetch = originalFetch;
}

if (process.env.TERRAIN_TEST_URL) {
  const requested = [];
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).endsWith(".terrain"))
      requested.push({ url: args[0], status: response.status });
    return response;
  };
  const layer = new CesiumTerrainLayer(new gisModule.WebMercatorGIS(118.1371, 24.49), {
    terrainUrl: process.env.TERRAIN_TEST_URL,
    accessToken: "",
  });
  try {
    const until = Date.now() + 10000;
    while (!layer.hasLoadedTiles() && Date.now() < until) {
      layer.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
      await new Promise((resolve) => setTimeout(resolve, 50));
      layer.update();
    }
    assert.ok(layer.hasLoadedTiles(), "Live terrain must decode into a mesh");
    assert.ok(requested.some((r) => r.url.endsWith("/12/6784/2605.terrain") && r.status === 200));
    const geometry = layer.children[0].geometry;
    assert.ok(geometry.attributes.position.count > 3);
    for (const value of geometry.attributes.position.array) assert.ok(Number.isFinite(value));
    console.log(
      `PASS live terrain: ${geometry.attributes.position.count} vertices; ${JSON.stringify(requested)}`,
    );
  } finally {
    layer.dispose();
    globalThis.fetch = originalFetch;
  }
}

{
  const urls = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    urls.push(requestUrl);
    if (requestUrl.includes("/v1/assets/1/endpoint")) {
      return new Response(
        JSON.stringify({
          type: "TERRAIN",
          url: "https://assets.ion.cesium.com/us-east-1/asset_depot/1/CesiumWorldTerrain/v1.2/",
          accessToken: "resource-token",
        }),
      );
    }
    if (requestUrl.endsWith("/layer.json")) {
      const available = Array.from({ length: 20 }, () => []);
      available[13] = [{ startX: 13568, endX: 13568, startY: 5210, endY: 5210 }];
      return new Response(
        JSON.stringify({
          scheme: "tms",
          version: "1.2.0",
          maxzoom: 19,
          available,
        }),
      );
    }
    return new Response(terrainFixture());
  };
  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(118.1371, 24.49),
    {
      terrainUrl:
        "https://assets.ion.cesium.com/ap-northeast-1/asset_depot/1/CesiumWorldTerrain/v1.2/{z}/{x}/{y}.terrain?extensions=metadata&v=1.2.0",
      accessToken: "test-token",
    },
    { tileYOrigin: "south", terrainZoomOffset: 0 },
  );
  try {
    for (let index = 0; index < 5; index++) {
      layer.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
      await tickTerrain(layer);
    }
    assert.ok(urls.some((url) => String(url).includes("/v1/assets/1/endpoint")));
    assert.ok(
      urls.some((url) => String(url).endsWith("/layer.json")),
      JSON.stringify(urls),
    );
    assert.ok(
      urls.some((url) =>
        String(url).endsWith(
          "/us-east-1/asset_depot/1/CesiumWorldTerrain/v1.2/13/13568/5210.terrain?extensions=metadata&v=1.2.0",
        ),
      ),
      JSON.stringify(urls),
    );
    assert.ok(
      !urls.some((url) => /\/14\/\d+\/\d+\.terrain/.test(String(url))),
      JSON.stringify(urls),
    );
    assert.equal(layer.hasLoadedTiles(), true);
  } finally {
    layer.dispose();
    globalThis.fetch = originalFetch;
  }
  console.log("PASS Cesium Ion URL template loads metadata and respects availability");
}

{
  const imageryRequests = [];
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillStyle: "",
            fillRect() {},
            drawImage() {},
          };
        },
      };
    },
  };
  globalThis.createImageBitmap = async () => ({
    width: 256,
    height: 256,
    close() {},
  });
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith(".terrain")) return new Response(terrainFixture());
    imageryRequests.push(requestUrl);
    return new Response(new Uint8Array([0]));
  };

  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(-80, -40),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      terrainZoomOffset: 0,
      minZoom: 2,
      maxZoom: 3,
      imageryUrlTemplate: "https://t{s}.tianditu.example/{z}/{x}/{y}.png",
      imagerySubdomains: ["probe"],
    },
  );

  try {
    layer.updateTilesInView([-80, -79], [-10, -9], 2, undefined, undefined, undefined, 3);
    let entry = layer.loadedTiles.get("2,1,2");
    for (let index = 0; index < 50 && !entry?.imageryCoverage; index++) {
      await tickTerrain(layer);
      entry = layer.loadedTiles.get("2,1,2");
    }
    assert.ok(
      entry,
      `the terrain tile should remain visible while imagery loads: ${JSON.stringify({
        keys: [...layer.loadedTiles.keys()],
        imageryRequests,
      })}`,
    );
    assert.ok(
      imageryRequests.some((url) => url.endsWith("/3/2/4.png")),
      JSON.stringify(imageryRequests),
    );
    assert.ok(
      imageryRequests.every((url) => url.startsWith("https://tprobe.tianditu.example/")),
      JSON.stringify(imageryRequests),
    );
    const firstCoverage = { ...entry.imageryCoverage };

    layer.updateTilesInView([-80, -79], [-42, -41], 2, undefined, undefined, undefined, 3);
    for (let index = 0; index < 50; index++) {
      await tickTerrain(layer);
      if (imageryRequests.some((url) => url.endsWith("/3/2/5.png"))) break;
    }

    assert.ok(
      imageryRequests.some((url) => url.endsWith("/3/2/5.png")),
      `same-zoom pan must fill newly visible imagery: ${JSON.stringify({
        imageryRequests,
        coverage: entry.imageryCoverage,
        pending: entry.pendingImageryZoom,
        zoom: entry.imageryZoom,
      })}`,
    );
    assert.notDeepEqual(entry.imageryCoverage, firstCoverage);
    console.log("PASS imagery request coverage follows the current view");
  } finally {
    layer.dispose();
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.fetch = originalFetch;
  }
}

{
  class TestRasterLayer extends rasterLayerModule.RasterTileLayer {
    constructor(gis) {
      super(
        gis,
        { urlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png" },
        {
          minZoom: 1,
          maxZoom: 4,
        },
      );
    }

    addLoadedTile(x, y, zoom) {
      this.onTileLoaded(
        {
          key: this.getKey(x, y, zoom),
          x,
          y,
          zoom,
          priority: 0,
          state: "loaded",
          abortController: null,
        },
        new THREE.Texture(),
      );
    }
  }

  const layer = new TestRasterLayer(new gisModule.WebMercatorGIS(0, 0));
  try {
    layer.addLoadedTile(0, 0, 1);
    layer.addLoadedTile(0, 1, 2);
    layer.addLoadedTile(1, 1, 2);
    const parent = layer.loadedTiles.get("0,0,1");
    assert.deepEqual(
      [...parent.material.userData.childVisibility],
      [1, 1, 0, 0],
      "loaded high-resolution imagery should hide only covered parent quadrants",
    );

    layer.loadedTiles.delete("1,1,2");
    layer.updateAncestorOcclusion();
    assert.deepEqual(
      [...parent.material.userData.childVisibility],
      [1, 0, 0, 0],
      "removing a child should reveal its parent fallback quadrant",
    );
    console.log("PASS raster imagery parent quadrants are occluded by loaded children");
  } finally {
    layer.dispose();
  }
}

{
  const template = "https://t{s}.tianditu.example/{z}/{x}/{y}.png";
  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(0, 0),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      imageryUrlTemplate: template,
    },
  );
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 100_000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, 0, 5_000);
  camera.lookAt(0, 10_000, 0);
  camera.updateMatrixWorld();

  try {
    layer.currentViewLngBounds = [-5, 5];
    layer.currentViewLatBounds = [-5, 5];
    layer.currentCameraFrustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    assert.equal(layer.imageryRequestGroup, tileUrlTemplateModule.getTileRequestGroup(template));
    assert.equal(layer.isImageryTileInView(2048, 2040, 12), true);
    assert.equal(layer.isImageryTileInView(2048, 2056, 12), false);
    const visibleKeys = new Set();
    const tilesToLoad = [];
    layer.collectQuadtreeTerrainTiles(
      [-5, 5],
      [-5, 5],
      1,
      camera,
      new THREE.Vector3(0, 10_000, 0),
      camera.position,
      visibleKeys,
      tilesToLoad,
    );
    const southKeys = [...visibleKeys].filter((key) => {
      const [, y, zoom] = key.split(",").map(Number);
      return y < 2 ** (zoom - 1);
    });
    assert.deepEqual(
      southKeys,
      [],
      `tiles behind the camera must be culled: ${JSON.stringify([...visibleKeys])}`,
    );
    console.log("PASS imagery tile frustum culling and shared request group");
  } finally {
    layer.dispose();
  }
}

{
  const makeLayer = (tileYOrigin) =>
    new CesiumTerrainLayer(
      new gisModule.WebMercatorGIS(0, 0),
      { terrainUrl: "https://terrain.example.test", accessToken: "" },
      { tileYOrigin },
    );
  const addEntry = (layer, key, opacity = 1) => {
    const material = new THREE.MeshBasicMaterial({ transparent: true, opacity });
    material.userData.childVisibility = new THREE.Vector4();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.visible = true;
    layer.loadedTiles.set(key, {
      mesh,
      key,
      surfaceHeight: 0,
      imageryZoom: 0,
      imageryCoverage: null,
      pendingImageryZoom: null,
      bornAt: 0,
      imageryReady: true,
    });
    return material.userData.childVisibility;
  };

  for (const [origin, southWestKey, northEastKey] of [
    ["south", "0,0,2", "1,1,2"],
    ["north", "0,1,2", "1,0,2"],
  ]) {
    const layer = makeLayer(origin);
    const parentVisibility = addEntry(layer, "0,0,1");
    addEntry(layer, southWestKey);
    addEntry(layer, northEastKey);
    layer.updateTerrainChildOcclusion();
    assert.deepEqual(
      [...parentVisibility],
      [1, 0, 0, 1],
      `${origin} origin child quadrants must match terrain UV orientation`,
    );
    layer.dispose();
  }
  console.log("PASS coarse ancestor occlusion follows rendered LOD quadrants");
}

{
  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(0, 0),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      imageryUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
      imageryRequestGroup: "terrain-imagery-cancellation-test",
      imageryMaximumRequestsPerServer: 1,
    },
  );
  const nearPriority = layer.getImageryTilePriority(128, 127, 8);
  const farPriority = layer.getImageryTilePriority(140, 127, 8);
  assert.ok(
    nearPriority < farPriority,
    `near imagery must be requested first: ${JSON.stringify({ nearPriority, farPriority })}`,
  );

  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const pendingFetches = new Map();
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.fetch = (url, init) =>
    new Promise((resolve) => {
      pendingFetches.set(String(url), { resolve, init });
    });

  try {
    const firstRequest = layer.getOrLoadImage(
      "8/128/127",
      "https://tiles.example.test/8/128/127.png",
      10,
      "0,0,1",
    );
    const queuedRequest = layer.getOrLoadImage(
      "8/129/127",
      "https://tiles.example.test/8/129/127.png",
      11,
      "1,0,1",
    );
    const queuedRejected = assert.rejects(queuedRequest, (error) => error?.name === "AbortError");
    await tick();
    assert.equal(layer.imgLoading.size, 2);
    assert.equal(pendingFetches.size, 1);

    layer.cancelImageryExcept(new Set(["0,0,1"]), new Set());
    await queuedRejected;
    const activeFetch = pendingFetches.get("https://tiles.example.test/8/128/127.png");
    assert.equal(activeFetch.init.signal.aborted, false);
    assert.equal(layer.imgLoading.size, 1);

    activeFetch.resolve(new Response(new Uint8Array([0])));
    await firstRequest;
    assert.equal(layer.imgCache.has("8/128/127"), true);
    assert.equal(layer.imgLoading.size, 0);
    console.log("PASS imagery request priority, queued cancellation, and active caching");
  } finally {
    layer.dispose();
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.fetch = originalFetch;
  }
}

{
  const originalFetchForGesture = globalThis.fetch;
  const terrainRequests = [];
  globalThis.fetch = (url, init) => {
    const requestUrl = String(url);
    if (!requestUrl.endsWith(".terrain")) return originalFetchForGesture(url, init);
    return new Promise((resolve) => {
      terrainRequests.push({ resolve, init, url: requestUrl });
    });
  };

  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(0, 0),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      terrainZoomOffset: 0,
      minZoom: 1,
      maxZoom: 1,
      maxLodLevels: 0,
      maxConcurrent: 1,
      maxRequestsPerFrame: 1,
    },
  );

  try {
    layer.updateTilesInView([-0.2, -0.1], [0.1, 0.2], 1);
    await tick();
    assert.equal(terrainRequests.length, 1, "the first terrain request should start");

    const firstRequest = terrainRequests[0];
    layer.updateTilesInView([0.1, 0.2], [0.1, 0.2], 1);
    assert.equal(
      firstRequest.init.signal.aborted,
      false,
      "active terrain transport must survive a camera update",
    );

    firstRequest.resolve(new Response(terrainFixture()));
    await tickTerrain(layer);
    await tick();
    assert.equal(
      terrainRequests.length,
      2,
      "the current view should start after the old request settles",
    );
    assert.equal(terrainRequests[1].init.signal.aborted, false);

    terrainRequests[1].resolve(new Response(terrainFixture()));
    for (let index = 0; index < 10 && layer.loadedTiles.size === 0; index++) {
      await tickTerrain(layer);
    }
    assert.ok(layer.loadedTiles.size > 0, "the second camera view must produce terrain");
    assert.ok(
      [...layer.loadedTiles.values()].some((entry) => entry.mesh.visible),
      "the current terrain mesh must remain visible after a rapid camera change",
    );
    console.log("PASS active terrain requests survive rapid camera changes");
  } finally {
    layer.dispose();
    globalThis.fetch = originalFetchForGesture;
  }
}

{
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillStyle: "",
            fillRect() {},
            drawImage() {},
          };
        },
      };
    },
  };
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith(".terrain")) return new Response(terrainFixture());
    return new Response("imagery unavailable", { status: 503 });
  };

  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(0, 0),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      terrainZoomOffset: 0,
      minZoom: 1,
      maxZoom: 1,
      maxLodLevels: 0,
      maxConcurrent: 2,
      maxRequestsPerFrame: 2,
      imageryUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
    },
  );

  try {
    layer.updateTilesInView([0.1, 0.2], [0.1, 0.2], 1);
    for (let index = 0; index < 20 && layer.loadedTiles.size === 0; index++) {
      await tickTerrain(layer);
    }
    assert.ok(layer.loadedTiles.size > 0, "terrain geometry should be committed");
    for (const entry of layer.loadedTiles.values()) {
      const material = entry.mesh.material;
      assert.equal(entry.imageryReady, false);
      assert.equal(entry.mesh.visible, true, "terrain must remain visible without imagery");
      assert.equal(material.map, null);
      assert.equal(material.color.getHex(), 0x6f786f);
    }
    console.log("PASS terrain geometry remains visible when imagery fails");
  } finally {
    layer.dispose();
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.fetch = originalFetch;
  }
}

{
  const attempts = new Map();
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ close() {} });
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    attempts.set(requestUrl, (attempts.get(requestUrl) ?? 0) + 1);
    if (requestUrl.endsWith("/404.png")) return new Response("missing", { status: 404 });
    if (requestUrl.endsWith("/500.png") && attempts.get(requestUrl) === 1) {
      return new Response("temporary", { status: 500 });
    }
    return new Response(new Uint8Array([0]));
  };

  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(0, 0),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      imageryUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
      imageryRequestGroup: "terrain-imagery-failure-test",
    },
  );
  layer.retryCooldown = 0;
  try {
    const missingUrl = "https://tiles.example.test/404.png";
    await assert.rejects(layer.getOrLoadImage("404", missingUrl, 1, "0,0,1"));
    await assert.rejects(layer.getOrLoadImage("404", missingUrl, 1, "0,0,1"));
    assert.equal(attempts.get(missingUrl), 1);
    assert.equal(layer.failedImagery.get("404")?.permanent, true);

    const transientUrl = "https://tiles.example.test/500.png";
    await assert.rejects(layer.getOrLoadImage("500", transientUrl, 1, "0,0,1"));
    await layer.getOrLoadImage("500", transientUrl, 1, "0,0,1");
    assert.equal(attempts.get(transientUrl), 2);
    assert.equal(layer.failedImagery.has("500"), false);
  } finally {
    layer.dispose();
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.fetch = originalFetch;
  }
  console.log("PASS imagery distinguishes permanent 404s from transient retries");
}

{
  const imageryRequests = [];
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            fillStyle: "",
            fillRect() {},
            drawImage() {},
          };
        },
      };
    },
  };
  globalThis.createImageBitmap = async () => ({
    width: 256,
    height: 256,
    close() {},
  });
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith(".terrain")) return new Response(terrainFixture());
    imageryRequests.push(requestUrl);
    return new Response(new Uint8Array([0]));
  };

  const layer = new CesiumTerrainLayer(
    new gisModule.WebMercatorGIS(118.1371, 24.49),
    { terrainUrl: "https://terrain.example.test", accessToken: "" },
    {
      tileYOrigin: "south",
      terrainZoomOffset: 0,
      minZoom: 1,
      maxZoom: 15,
      maxLodLevels: 2,
      imageryUrlTemplate: "https://t{s}.tianditu.example/{z}/{x}/{y}.png",
      imagerySubdomains: ["probe"],
      imageryMaxCanvasSize: 4096,
    },
  );

  try {
    layer.updateTilesInView(
      [118.13708, 118.13712],
      [24.48998, 24.49002],
      12,
      undefined,
      100_000_000,
      undefined,
      16,
    );
    for (let index = 0; index < 50 && imageryRequests.length === 0; index++) {
      await tickTerrain(layer);
    }

    assert.ok(
      imageryRequests.some((url) => /\/13\/\d+\/\d+\.png$/.test(url)),
      `a terrain-resolution imagery preview should arrive first: ${JSON.stringify({
        imageryRequests,
        keys: [...layer.loadedTiles.keys()],
      })}`,
    );

    layer.updateTilesInView(
      [118.13708, 118.13712],
      [24.48998, 24.49002],
      12,
      undefined,
      100_000_000,
      undefined,
      16,
    );
    for (let index = 0; index < 50; index++) {
      await tickTerrain(layer);
      if (imageryRequests.some((url) => /\/16\/\d+\/\d+\.png$/.test(url))) break;
    }

    assert.ok(
      imageryRequests.some((url) => /\/16\/\d+\/\d+\.png$/.test(url)),
      `imagery must follow the camera zoom instead of the terrain LOD: ${JSON.stringify({
        imageryRequests,
        keys: [...layer.loadedTiles.keys()],
      })}`,
    );
    console.log("PASS imagery zoom follows camera above low terrain LOD");
  } finally {
    layer.dispose();
    globalThis.document = originalDocument;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    globalThis.fetch = originalFetch;
  }
}

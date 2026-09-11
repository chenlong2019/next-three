import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import ts from "typescript";

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
const { CesiumTerrainLayer } = loadTypeScript(
  "../lib/sources/engine/layers/CesiumTerrainLayer.ts",
  {
    "../../gis/WebMercatorGIS": gisModule,
    "./RequestScheduler": requestSchedulerModule,
    "./TileUrlTemplate": tileUrlTemplateModule,
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
      await tick();
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
      await tick();
      const requests = urls.filter((url) => url.endsWith(".terrain"));
      assert.ok(requests.some((url) => url.endsWith("/12/6784/2605.terrain")));
      assert.ok(!requests.some((url) => url.includes("/13/")), JSON.stringify(requests));
      assert.equal(terrain.hasLoadedTiles(), true);
    } finally {
      terrain.dispose();
    }
    console.log("PASS unavailable target level falls back to ancestor");
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
      return new Response(
        JSON.stringify({
          scheme: "tms",
          version: "1.2.0",
          tiles: ["{z}/{x}/{y}.terrain?v={version}"],
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
    await tick();
    await tick();
    layer.updateTilesInView([118.137, 118.1372], [24.4899, 24.4901], 13);
    await tick();
    assert.ok(urls.some((url) => String(url).includes("/v1/assets/1/endpoint")));
    assert.ok(urls.some((url) => String(url).endsWith("/layer.json")));
    assert.ok(urls.some((url) => String(url).endsWith("/13/13568/5210.terrain?v=1.2.0")));
    assert.equal(layer.hasLoadedTiles(), true);
  } finally {
    layer.dispose();
    globalThis.fetch = originalFetch;
  }
  console.log("PASS Cesium Ion asset depot URL template");
}

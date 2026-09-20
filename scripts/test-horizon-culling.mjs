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
const gisUtilsModule = loadTypeScript("../lib/sources/engine/utils/gis-utils.ts");
const cameraUtils = loadTypeScript("../lib/sources/engine/utils/camera-utils.ts", {
  "../../gis/WebMercatorGIS": gisModule,
  "./gis-utils": gisUtilsModule,
});

const { WebMercatorGIS } = gisModule;
const { getHorizonDistance, getViewGroundCorners, cornersToLngLatBounds } = cameraUtils;
const earthRadius = WebMercatorGIS.EARTH_RADIUS;

assert.equal(getHorizonDistance(0), 0);
assert.equal(getHorizonDistance(-100), 0);
const eyeHeight = 18000;
const geometricHorizon = earthRadius * Math.acos(earthRadius / (earthRadius + eyeHeight));
assert.ok(Math.abs(getHorizonDistance(eyeHeight, { horizonFactor: 1 }) - geometricHorizon) < 1e-6);

function makeCamera(polarDeg, distance = 18000) {
  const camera = new THREE.PerspectiveCamera(60, 1.7, 0.1, 1e9);
  camera.up.set(0, 0, 1);
  const polar = THREE.MathUtils.degToRad(polarDeg);
  camera.position.set(0, -Math.sin(polar) * distance, Math.cos(polar) * distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

for (const polarDeg of [45, 59, 60, 70, 80, 88]) {
  const corners = getViewGroundCorners(makeCamera(polarDeg), 0, { horizonFactor: 1 });
  assert.equal(corners.length, 4, `near-horizon view ${polarDeg} must keep four finite corners`);
  for (const corner of corners) {
    assert.ok(Number.isFinite(corner.x) && Number.isFinite(corner.y));
    assert.ok(Math.hypot(corner.x, corner.y) <= geometricHorizon + 1e-6);
  }
}

const clipped = getViewGroundCorners(makeCamera(59), 0, { horizonFactor: 1 });
const rawFarDistance = 515688;
assert.ok(Math.hypot(clipped[3].x, clipped[3].y) < rawFarDistance);

const hardLimited = getViewGroundCorners(makeCamera(88), 0, {
  horizonFactor: 1,
  maxGroundDistance: 100000,
});
for (const corner of hardLimited) {
  assert.ok(Math.hypot(corner.x, corner.y) <= 100000 + 1e-6);
}

const bounds = cornersToLngLatBounds(clipped, new WebMercatorGIS(0, 0));
assert.ok(bounds);
for (const value of [bounds.west, bounds.east, bounds.south, bounds.north]) {
  assert.ok(Number.isFinite(value));
}

console.log("PASS horizon clipping keeps near-horizontal view bounds finite");

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import ts from "typescript";
import * as THREE from "three";

// Run the isolated TS material helper with the project's existing toolchain.
const filename = fileURLToPath(
  new URL("../lib/sources/engine/materials/DaylightBuildingMaterial.ts", import.meta.url),
);
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const source = new Module(filename);
source.filename = filename;
source.paths = Module._nodeModulePaths(path.dirname(filename));
source._compile(compiled, filename);
const { prepareDaylightGeometry, createDaylightBuildingMaterial } = source.exports;

for (const indexed of [true, false]) {
  const box = new THREE.BoxGeometry(12, 30, 10).translate(0, 15, 0);
  const geometry = indexed ? box : box.toNonIndexed();
  const original = Array.from(geometry.attributes.position.array);
  prepareDaylightGeometry(geometry);
  assert.deepEqual(Array.from(geometry.attributes.position.array), original);
  const top = geometry.getAttribute("buildingTop");
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < top.count; i++) {
    assert.equal(top.getX(i), normal.getY(i) < -0.5 ? 0 : 30);
  }
  geometry.dispose();
  box.dispose();
}

const material = createDaylightBuildingMaterial({ floorHeight: 0, windowSpacing: -1 }, 0.5);
const shader = {
  uniforms: {},
  vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader,
};
material.onBeforeCompile(shader, null);
assert.equal(material.isMeshStandardMaterial, true);
assert.equal(material.transparent, true);
assert.equal(shader.uniforms.uFloorHeight.value, 0.5);
assert.equal(shader.uniforms.uWindowSpacing.value, 0.5);
assert.ok(shader.vertexShader.includes("vBuildingTop = buildingTop"));
assert.ok(shader.fragmentShader.includes("fwidth(grid)"));
assert.ok(shader.fragmentShader.includes("#include <fog_fragment>"));
assert.ok(shader.fragmentShader.includes("#include <logdepthbuf_fragment>"));
material.dispose();
console.log(
  "Daylight material: indexed/non-indexed geometry, original positions, facade shader and parameter bounds passed.",
);

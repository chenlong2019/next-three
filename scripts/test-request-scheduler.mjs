import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import ts from "typescript";

function loadTypeScript(relativePath) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url));
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const source = new Module(filename);
  source.filename = filename;
  source.paths = Module._nodeModulePaths(path.dirname(filename));
  source._compile(output, filename);
  return source.exports;
}

const { RequestScheduler } = loadTypeScript("../lib/sources/engine/layers/RequestScheduler.ts");
const { getTileRequestGroup, replaceTileTemplate } = loadTypeScript(
  "../lib/sources/engine/layers/TileUrlTemplate.ts",
);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function testPerServerLimit() {
  const scheduler = new RequestScheduler({
    maximumRequests: 50,
    maximumRequestsPerServer: 6,
  });
  const resolvers = [];
  let active = 0;
  let maximumActive = 0;
  let started = 0;

  const requests = Array.from({ length: 12 }, (_, index) =>
    scheduler.schedule({
      url: `https://tiles.example.test/${index}.png`,
      priority: index,
      load: () =>
        new Promise((resolve) => {
          active++;
          started++;
          maximumActive = Math.max(maximumActive, active);
          resolvers.push(() => {
            active--;
            resolve();
          });
        }),
    }),
  );

  await tick();
  assert.equal(started, 6, "only six requests may start for one origin");
  assert.equal(scheduler.getActiveRequestCountFor("https://tiles.example.test/0.png"), 6);
  assert.equal(scheduler.pendingRequestCount, 6);

  for (const resolve of resolvers.splice(0)) resolve();
  await tick();
  await tick();
  assert.equal(started, 12, "completed requests should release server slots");
  assert.equal(maximumActive, 6, "per-origin concurrency must never exceed six");

  for (const resolve of resolvers.splice(0)) resolve();
  await Promise.all(requests);
  assert.equal(scheduler.activeRequestCount, 0);
}

async function testDifferentOriginsRunIndependently() {
  const scheduler = new RequestScheduler({
    maximumRequests: 50,
    maximumRequestsPerServer: 6,
  });
  const resolvers = [];
  const makeRequest = (host, index) =>
    scheduler.schedule({
      url: `https://${host}/${index}.png`,
      priority: index,
      load: () => new Promise((resolve) => resolvers.push(resolve)),
    });

  const requests = [
    ...Array.from({ length: 6 }, (_, index) => makeRequest("a.example.test", index)),
    ...Array.from({ length: 6 }, (_, index) => makeRequest("b.example.test", index)),
  ];

  await tick();
  assert.equal(scheduler.getActiveRequestCountFor("https://a.example.test/0.png"), 6);
  assert.equal(scheduler.getActiveRequestCountFor("https://b.example.test/0.png"), 6);
  assert.equal(scheduler.activeRequestCount, 12);

  for (const resolve of resolvers) resolve();
  await Promise.all(requests);
}

async function testSharedRequestGroup() {
  const scheduler = new RequestScheduler({
    maximumRequests: 50,
    maximumRequestsPerServer: 6,
  });
  const resolvers = [];
  let started = 0;
  const requests = Array.from({ length: 8 }, (_, index) =>
    scheduler.schedule({
      url: `https://t${index}.tianditu.example.test/${index}.png`,
      priority: index,
      requestGroup: "tianditu",
      maximumRequestsPerServer: 2,
      load: () =>
        new Promise((resolve) => {
          started++;
          resolvers.push(resolve);
        }),
    }),
  );

  await tick();
  assert.equal(started, 2, "shared request groups must use one concurrency limit");
  assert.equal(scheduler.getActiveRequestCountFor("https://t0.tianditu.example.test"), 0);
  assert.equal(scheduler.pendingRequestCount, 6);

  for (const expected of [4, 6, 8]) {
    for (const resolve of resolvers.splice(0)) resolve();
    await tick();
    await tick();
    assert.equal(started, expected, "shared group slots should release together");
  }

  for (const resolve of resolvers.splice(0)) resolve();
  await Promise.all(requests);
}

async function testPriorityAndAbort() {
  const scheduler = new RequestScheduler({
    maximumRequests: 50,
    maximumRequestsPerServer: 1,
  });
  const order = [];
  const resolvers = [];
  const makeRequest = (priority, name) =>
    scheduler.schedule({
      url: "https://priority.example.test/tile.png",
      priority,
      load: () =>
        new Promise((resolve) => {
          order.push(name);
          resolvers.push(resolve);
        }),
    });

  const low = makeRequest(10, "low");
  const high = makeRequest(1, "high");
  const middle = makeRequest(5, "middle");

  await tick();
  assert.deepEqual(order, ["high"]);

  resolvers.shift()();
  await tick();
  assert.deepEqual(order, ["high", "middle"]);

  resolvers.shift()();
  await tick();
  assert.deepEqual(order, ["high", "middle", "low"]);
  resolvers.shift()();
  await Promise.all([low, high, middle]);

  const controller = new RequestScheduler({ maximumRequestsPerServer: 1 });
  const firstResolve = [];
  const first = controller.schedule({
    url: "https://abort.example.test/first.png",
    priority: 0,
    load: () => new Promise((resolve) => firstResolve.push(resolve)),
  });
  const abortController = new AbortController();
  const aborted = controller.schedule({
    url: "https://abort.example.test/second.png",
    priority: 1,
    signal: abortController.signal,
    load: () => new Promise(() => {}),
  });
  const abortedAssertion = assert.rejects(aborted, (error) => error?.name === "AbortError");
  abortController.abort();
  await abortedAssertion;
  assert.equal(controller.pendingRequestCount, 0);
  firstResolve[0]();
  await first;
}

function testTileTemplateSubdomains() {
  const hosts = new Set();
  for (let x = 0; x < 8; x++) {
    const url = replaceTileTemplate(
      "https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
      x,
      2,
      3,
    );
    const parsed = new URL(url);
    hosts.add(parsed.hostname);
    assert.ok(parsed.pathname.endsWith(`/lyrs=y&x=${x}&y=2&z=3`));
  }
  assert.deepEqual([...hosts].sort(), [
    "mt0.google.com",
    "mt1.google.com",
    "mt2.google.com",
    "mt3.google.com",
  ]);
  assert.equal(
    getTileRequestGroup("https://t{s}.tianditu.example/{z}/{x}/{y}.png"),
    "tile-template:https://t0.tianditu.example",
  );
  assert.equal(getTileRequestGroup("https://tiles.example/{z}/{x}/{y}.png"), undefined);
}

await testPerServerLimit();
await testDifferentOriginsRunIndependently();
await testSharedRequestGroup();
await testPriorityAndAbort();
testTileTemplateSubdomains();

console.log("PASS request scheduler");

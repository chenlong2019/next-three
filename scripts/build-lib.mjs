#!/usr/bin/env node
/**
 * three-gis 库构建编排脚本。
 *
 *   node scripts/build-lib.mjs            一次性构建
 *   node scripts/build-lib.mjs --watch    先构建一次，然后 rollup 进入监听模式
 *
 * 步骤：
 *   1. 清理 lib/dist 与临时目录 lib/.rollup-tmp
 *   2. tsc -p lib/tsconfig.build.json  → lib/.rollup-tmp/（ESM JS + 逐文件 d.ts）
 *   3. rollup -c lib/rollup.config.mjs → lib/dist/
 *   4. 清理临时目录（--watch 时保留，方便排查产物）
 *
 * 刻意用 process.execPath 直接跑 node_modules 里的 JS 入口，避免依赖 PATH 上的
 * tsc / rollup 可执行文件（Windows 下 .cmd 与 shell 的行为差异很容易踩坑）。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const libDir = path.join(rootDir, "lib");
const outDir = path.join(libDir, "dist");
const tmpDir = path.join(libDir, ".rollup-tmp");

const watch = process.argv.includes("--watch");

const TSC_BIN = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const ROLLUP_BIN = path.join(rootDir, "node_modules", "rollup", "dist", "bin", "rollup");

function fail(message) {
  console.error(`\n[build-lib] ${message}\n`);
  process.exit(1);
}

function requireFile(file, hint) {
  if (!fs.existsSync(file)) fail(`找不到 ${file}\n${hint}`);
}

function run(label, entry, args, { stream = false } = {}) {
  console.log(`\n[build-lib] ${label}`);
  // 非监听模式把子进程的 stdout / stderr 都收进自己的 stdout：
  // rollup 的进度是往 stderr 写的，直接 inherit 会让 Windows PowerShell 把整条
  // 命令判成 NativeCommandError，CI 里也会刷一屏红字。
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: rootDir,
    encoding: stream ? undefined : "utf8",
    stdio: stream ? "inherit" : "pipe",
  });
  if (result.error) fail(`${label} 启动失败：${result.error.message}`);
  if (!stream) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stdout.write(result.stderr);
  }
  if (result.status !== 0) fail(`${label} 失败（退出码 ${result.status}）`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function report() {
  if (!fs.existsSync(outDir)) return;
  const files = fs
    .readdirSync(outDir)
    .filter((name) => !name.endsWith(".map"))
    .sort();
  const rows = files.map((name) => {
    const size = fs.statSync(path.join(outDir, name)).size;
    return `  ${name.padEnd(28)} ${formatKB(size).padStart(10)}`;
  });
  console.log(`\n[build-lib] 产物 lib/dist/：\n${rows.join("\n")}\n`);
}

// ---- 0. 前置检查 ----
requireFile(TSC_BIN, "请先执行 npm install（需要 typescript）。");
requireFile(ROLLUP_BIN, "请先执行 npm install（需要 rollup 及 @rollup/* 插件）。");
requireFile(
  path.join(libDir, "index.ts"),
  "lib/index.ts 是库的公共入口，缺失说明源码树被改动过。",
);

// ---- 1. 清理 ----
console.log("[build-lib] 清理 lib/dist 与 lib/.rollup-tmp");
rmrf(outDir);
rmrf(tmpDir);

// ---- 2. tsc：TypeScript → ESM JS + d.ts ----
run("编译 TypeScript（tsc）", TSC_BIN, ["-p", path.join(libDir, "tsconfig.build.json")]);

// ---- 3. rollup：打包成 ESM / CJS / IIFE / d.ts ----
const rollupArgs = ["-c", path.join(libDir, "rollup.config.mjs")];
if (watch) {
  run("打包（rollup --watch）", ROLLUP_BIN, [...rollupArgs, "--watch"], { stream: true });
  report();
  process.exit(0);
}
run("打包（rollup）", ROLLUP_BIN, rollupArgs);

// ---- 4. 清理临时目录 ----
rmrf(tmpDir);

report();
console.log("[build-lib] 完成。\n");

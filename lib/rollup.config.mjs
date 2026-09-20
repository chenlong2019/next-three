// three-gis rollup 打包配置。
//
// 构建分两步（由 scripts/build-lib.mjs 编排）：
//   1. tsc -p lib/tsconfig.build.json  → lib/.rollup-tmp/（ESM JS + 逐文件 d.ts）
//   2. rollup -c lib/rollup.config.mjs → lib/dist/（本文件负责）
//
// 产物：
//   dist/three-gis.mjs           ESM，three 走 external，给 Vite / Vue / React / Next
//   dist/three-gis.cjs           CJS，three 走 external，给 Node 侧或老 webpack
//   dist/three-gis.global.js     IIFE，three + uuid 全部内联，给原生 HTML <script src>
//   dist/three-gis.global.min.js 同上，压缩版
//   dist/index.d.ts              合并后的类型声明
//
// 为什么 ESM/CJS 把 three 外置、IIFE 却内联？
//   three 从 r150 起不再发布 UMD 构建，npm 包里只有 three.module.js / three.cjs，
//   没有可供 <script> 全局引用的 THREE。若 IIFE 也外置，普通 HTML 页面无法零构建使用，
//   所以全局构建把 three 打进去；而打包器场景必须外置，否则会与业务项目里的 three 变成两份实例。

import path from "node:path";
import { fileURLToPath } from "node:url";

import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";
import replace from "@rollup/plugin-replace";
import { dts } from "rollup-plugin-dts";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(pkgDir, ".rollup-tmp");
const outDir = path.join(pkgDir, "dist");

const input = path.join(tmpDir, "index.js");
const inputTypes = path.join(tmpDir, "index.d.ts");

/** 运行时依赖只保留 three；uuid 体积很小且 uuid@14 没有 CJS 入口，直接内联更省事。 */
const external = (id) => id === "three" || id.startsWith("three/");

const onwarn = (warning, warn) => {
  // 第三方包（three addons / uuid）内部的循环引用与 PURE 注释提示与本次打包无关
  if (warning.code === "CIRCULAR_DEPENDENCY" && !warning.ids?.[0]?.includes("lib")) return;
  if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
  warn(warning);
};

/** 库需要在纯浏览器里跑，process.env.NODE_ENV 必须被静态替换掉。 */
const replacePlugin = () =>
  replace({
    preventAssignment: true,
    values: { "process.env.NODE_ENV": JSON.stringify("production") },
  });

const basePlugins = () => [
  replacePlugin(),
  nodeResolve({ browser: true, exportConditions: ["browser", "import", "default"] }),
  commonjs(),
];

const banner = `/*! three-gis v${process.env.npm_package_version ?? "0.1.0"} | MIT */`;

export default [
  // ---- ESM / CJS：three 外置 ----
  {
    input,
    external,
    onwarn,
    plugins: basePlugins(),
    output: [
      {
        file: path.join(outDir, "three-gis.mjs"),
        format: "es",
        sourcemap: true,
        banner,
      },
      {
        file: path.join(outDir, "three-gis.cjs"),
        format: "cjs",
        exports: "named",
        sourcemap: true,
        banner,
        interop: "auto",
      },
    ],
  },

  // ---- IIFE：three 内联，供原生 HTML 直接 <script> 引入 ----
  {
    input,
    onwarn,
    plugins: basePlugins(),
    output: [
      {
        file: path.join(outDir, "three-gis.global.js"),
        format: "iife",
        name: "ThreeGIS",
        extend: false,
        sourcemap: false,
        banner,
      },
      {
        file: path.join(outDir, "three-gis.global.min.js"),
        format: "iife",
        name: "ThreeGIS",
        extend: false,
        sourcemap: false,
        banner,
        // 输出级插件：只压缩 min 版本，避免同一份 bundle 被打包两遍
        plugins: [
          terser({
            compress: { passes: 2 },
            format: { comments: /^!/ },
          }),
        ],
      },
    ],
  },

  // ---- 类型声明：把逐文件 d.ts 合并成单个 index.d.ts ----
  {
    input: inputTypes,
    external,
    plugins: [dts()],
    output: {
      file: path.join(outDir, "index.d.ts"),
      format: "es",
    },
  },
];

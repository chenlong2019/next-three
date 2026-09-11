import type { NextConfig } from "next";

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // Turbopack 基础配置
  output: "export",
  distDir: "dist",
  basePath: basePath || undefined,
  // 本地双击html打开修复资源路径（./相对路径）
  trailingSlash: true,
  // 关键：允许局域网IP访问开发HMR（Next15+强制校验origin）
  allowedDevOrigins: [
    "192.168.0.188",
    "192.168.0.*", // 通配符，同网段全部设备放行
    "localhost",
  ],

  staticPageGenerationTimeout: 120,
};

export default nextConfig;

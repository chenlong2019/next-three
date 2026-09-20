import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "next-three | Spatial Engine for the Web",
  description: "一套仿 Cesium 设计的 Three.js 三维 GIS / CAD 引擎。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

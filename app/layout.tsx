import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "next-three",
  description: "基于 Three.js 的三维 GIS / CAD 示例项目",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={` h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

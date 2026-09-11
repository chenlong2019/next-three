import type { ReactNode } from "react";
import { demoRoutes } from "../demoRoutes";

export const dynamicParams = false;

export function generateStaticParams() {
  return demoRoutes.map((demo) => ({ demo: demo.key }));
}

export default function DemoRouteLayout({ children }: { children: ReactNode }) {
  return children;
}

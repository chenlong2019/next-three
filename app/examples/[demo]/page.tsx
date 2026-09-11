import ExamplesExplorer from "../ExamplesExplorer";
import type { DemoKey } from "../demoRoutes";

export default async function ExampleDemoPage({ params }: { params: Promise<{ demo: string }> }) {
  const { demo } = await params;
  return <ExamplesExplorer activeKey={demo as DemoKey} />;
}

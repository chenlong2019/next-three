import ExamplesExplorer from "./ExamplesExplorer";
import { defaultDemoKey } from "./demoRoutes";

export default function ExamplesPage() {
  return <ExamplesExplorer activeKey={defaultDemoKey} />;
}

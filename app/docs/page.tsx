import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import ApiDocsExplorer, { type ApiDocEntry } from "./ApiDocsExplorer";

export const metadata: Metadata = {
  title: "API 文档 | Next CAD",
  description: "Next CAD 三维 GIS 库 API 文档",
};

const DOCS_ROOT = path.join(process.cwd(), "docs", "api");

function cleanTitle(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
}

function getTitle(markdown: string, filePath: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1];
  if (heading) return cleanTitle(heading);

  const fileName = path.basename(filePath, ".md");
  return fileName === "README" ? "模块概览" : fileName;
}

function getKind(relativePath: string): ApiDocEntry["kind"] {
  const segments = relativePath.split("/");
  if (segments.at(-1) === "README.md") return "module";
  if (segments.includes("classes")) return "class";
  if (segments.includes("interfaces")) return "interface";
  if (segments.includes("type-aliases")) return "type";
  if (segments.includes("enumerations")) return "enum";
  if (segments.includes("functions")) return "function";
  if (segments.includes("variables")) return "variable";
  return "document";
}

function getGroupName(segment: string): string {
  const labels: Record<string, string> = {
    core: "Core",
    engine: "Engine",
    examples: "Examples",
    gis: "GIS",
    types: "Types",
  };
  return labels[segment] ?? segment;
}

function collectDocs(directory: string, root: string): ApiDocEntry[] {
  if (!fs.existsSync(directory)) return [];

  const entries: ApiDocEntry[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectDocs(fullPath, root));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const id = path.relative(root, fullPath).replaceAll(path.sep, "/");
    const segments = id.split("/");
    const moduleSegments =
      segments.at(-1) === "README.md" ? segments.slice(0, -1) : segments.slice(0, -2);
    const modulePath = moduleSegments.join("/") || "overview";
    const markdown = fs.readFileSync(fullPath, "utf8");

    entries.push({
      id,
      title: getTitle(markdown, fullPath),
      group: getGroupName(segments[0] === "README.md" ? "overview" : segments[0]),
      module: modulePath,
      kind: getKind(id),
      markdown,
    });
  }

  return entries.sort((a, b) => {
    const groupCompare = a.group.localeCompare(b.group);
    if (groupCompare !== 0) return groupCompare;
    const moduleCompare = a.module.localeCompare(b.module);
    if (moduleCompare !== 0) return moduleCompare;
    if (a.kind === "module" && b.kind !== "module") return -1;
    if (a.kind !== "module" && b.kind === "module") return 1;
    return a.title.localeCompare(b.title);
  });
}

export default function DocsPage() {
  const docs = collectDocs(DOCS_ROOT, DOCS_ROOT);
  const initialDocId =
    docs.find((doc) => doc.id === "core/Scene/classes/Scene.md")?.id ??
    docs.find((doc) => doc.id === "README.md")?.id ??
    docs[0]?.id ??
    "";

  return <ApiDocsExplorer docs={docs} initialDocId={initialDocId} />;
}

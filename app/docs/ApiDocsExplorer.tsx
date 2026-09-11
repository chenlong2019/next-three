"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ElementType, ReactNode } from "react";
import Link from "next/link";
import styles from "./ApiDocs.module.css";

export interface ApiDocEntry {
  id: string;
  title: string;
  group: string;
  module: string;
  kind: "module" | "class" | "interface" | "type" | "enum" | "function" | "variable" | "document";
  markdown: string;
}

interface ApiDocsExplorerProps {
  docs: ApiDocEntry[];
  initialDocId: string;
}

interface Heading {
  level: number;
  text: string;
  id: string;
}

type MarkdownBlock =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; lines: string[] }
  | { type: "code"; language: string; value: string }
  | { type: "list"; items: string[] }
  | { type: "quote"; lines: string[] }
  | { type: "rule" }
  | { type: "table"; headers: string[]; rows: string[][] };

const kindLabels: Record<ApiDocEntry["kind"], string> = {
  module: "模块",
  class: "类",
  interface: "接口",
  type: "类型",
  enum: "枚举",
  function: "函数",
  variable: "变量",
  document: "文档",
};

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function extractHeadings(markdown: string): Heading[] {
  const used = new Map<string, number>();
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!match) return [];

    const text = match[2].replace(/[`*_]/g, "").trim();
    const base = slugify(text);
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return [{ level: match[1].length, text, id: count ? `${base}-${count}` : base }];
  });
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const usedHeadingIds = new Map<string, number>();
  let index = 0;

  const getHeadingId = (text: string): string => {
    const base = slugify(text);
    const count = usedHeadingIds.get(base) ?? 0;
    usedHeadingIds.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fence[1].trim(),
        value: codeLines.join("\n"),
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({
        type: "heading",
        level: Math.min(6, heading[1].length),
        text,
        id: getHeadingId(text),
      });
      index += 1;
      continue;
    }

    if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = parseTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }

  return blocks;
}

function resolveDocId(currentId: string, href: string): string | null {
  const [rawPath] = href.split("#");
  if (!rawPath.endsWith(".md")) return null;

  const stack = currentId.split("/").slice(0, -1);
  for (const segment of rawPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

function renderInline(
  value: string,
  keyPrefix: string,
  currentId: string,
  docIds: Set<string>,
  onNavigate: (id: string) => void,
): ReactNode[] {
  const tokens = value.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return tokens.filter(Boolean).map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`") && token.endsWith("`")) {
      return (
        <code key={key} className={styles.inlineCode}>
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith("**") && token.endsWith("**")) {
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    }

    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
    if (link) {
      const [, label, href] = link;
      const docId = resolveDocId(currentId, href);
      if (docId && docIds.has(docId)) {
        return (
          <a
            key={key}
            href={`/docs?doc=${encodeURIComponent(docId)}`}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(docId);
            }}
          >
            {label}
          </a>
        );
      }
      return (
        <a key={key} href={href}>
          {label}
        </a>
      );
    }

    return <span key={key}>{token}</span>;
  });
}

function MarkdownContent({
  doc,
  docIds,
  onNavigate,
}: {
  doc: ApiDocEntry;
  docIds: Set<string>;
  onNavigate: (id: string) => void;
}) {
  const blocks = useMemo(() => parseMarkdown(doc.markdown), [doc.markdown]);

  return (
    <article className={styles.article}>
      {blocks.map((block, blockIndex) => {
        const key = `${doc.id}-${blockIndex}`;
        if (block.type === "heading") {
          const HeadingTag = `h${block.level}` as ElementType;
          return (
            <HeadingTag key={key} id={block.id}>
              {renderInline(block.text, key, doc.id, docIds, onNavigate)}
            </HeadingTag>
          );
        }
        if (block.type === "code") {
          return (
            <div key={key} className={styles.codeBlock}>
              {block.language && <span className={styles.codeLanguage}>{block.language}</span>}
              <pre>
                <code>{block.value}</code>
              </pre>
            </div>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  {renderInline(item, `${key}-${itemIndex}`, doc.id, docIds, onNavigate)}
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote key={key}>
              {block.lines.map((line, lineIndex) => (
                <p key={`${key}-${lineIndex}`}>
                  {renderInline(line, `${key}-${lineIndex}`, doc.id, docIds, onNavigate)}
                </p>
              ))}
            </blockquote>
          );
        }
        if (block.type === "table") {
          return (
            <div key={key} className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((cell) => (
                      <th key={cell}>{renderInline(cell, key, doc.id, docIds, onNavigate)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${key}-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`${key}-${rowIndex}-${cellIndex}`}>
                          {renderInline(cell, key, doc.id, docIds, onNavigate)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === "rule") return <hr key={key} />;

        return (
          <p key={key}>{renderInline(block.lines.join("\n"), key, doc.id, docIds, onNavigate)}</p>
        );
      })}
    </article>
  );
}

export default function ApiDocsExplorer({ docs, initialDocId }: ApiDocsExplorerProps) {
  const [selectedId, setSelectedId] = useState(initialDocId);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");

  const docIds = useMemo(() => new Set(docs.map((doc) => doc.id)), [docs]);
  const selectedDoc = docs.find((doc) => doc.id === selectedId) ?? docs[0];
  const groups = useMemo(() => Array.from(new Set(docs.map((doc) => doc.group))).sort(), [docs]);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("doc");
    if (!value || !docIds.has(value)) return;
    const frame = window.requestAnimationFrame(() => setSelectedId(value));
    return () => window.cancelAnimationFrame(frame);
  }, [docIds]);

  const filteredDocs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return docs.filter((doc) => {
      if (group !== "all" && doc.group !== group) return false;
      if (!normalizedQuery) return true;
      return `${doc.title} ${doc.module} ${doc.id}`.toLowerCase().includes(normalizedQuery);
    });
  }, [docs, group, query]);

  const groupedDocs = useMemo(() => {
    const result = new Map<string, Map<string, ApiDocEntry[]>>();
    for (const doc of filteredDocs) {
      if (!result.has(doc.group)) result.set(doc.group, new Map());
      const modules = result.get(doc.group)!;
      if (!modules.has(doc.module)) modules.set(doc.module, []);
      modules.get(doc.module)!.push(doc);
    }
    return result;
  }, [filteredDocs]);

  const selectDoc = useCallback((id: string) => {
    setSelectedId(id);
    window.history.replaceState(null, "", `/docs?doc=${encodeURIComponent(id)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const headings = useMemo(
    () => (selectedDoc ? extractHeadings(selectedDoc.markdown) : []),
    [selectedDoc],
  );

  return (
    <div className={styles.docsShell}>
      <header className={styles.topbar}>
        <div className={styles.brandBlock}>
          <Link className={styles.brand} href="/">
            Next CAD
          </Link>
          <span className={styles.productLabel}>API Reference</span>
        </div>
        <nav className={styles.topnav} aria-label="主导航">
          <Link href="/examples/">示例</Link>
          <Link className={styles.activeTopnav} href="/docs/">
            文档
          </Link>
        </nav>
      </header>

      <div className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarIntro}>
            <span className={styles.eyebrow}>LIBRARY API</span>
            <h1>开发者文档</h1>
            <p>按模块浏览三维 GIS 核心类、图层、图元和工具。</p>
          </div>

          <label className={styles.searchBox}>
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索类、接口或模块"
              aria-label="搜索 API 文档"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} aria-label="清除搜索">
                ×
              </button>
            )}
          </label>

          <div className={styles.filterRow} aria-label="文档分类">
            <button
              type="button"
              className={group === "all" ? styles.filterActive : ""}
              onClick={() => setGroup("all")}
            >
              全部
            </button>
            {groups.map((item) => (
              <button
                key={item}
                type="button"
                className={group === item ? styles.filterActive : ""}
                onClick={() => setGroup(item)}
              >
                {item}
              </button>
            ))}
          </div>

          <div className={styles.docTree}>
            {Array.from(groupedDocs.entries()).map(([groupName, modules]) => (
              <section key={groupName} className={styles.treeGroup}>
                <h2>{groupName}</h2>
                {Array.from(modules.entries()).map(([moduleName, moduleDocs]) => (
                  <div key={moduleName} className={styles.moduleGroup}>
                    <div className={styles.moduleName}>
                      {moduleName === "overview" ? "项目概览" : moduleName}
                    </div>
                    {moduleDocs.map((doc) => (
                      <button
                        key={doc.id}
                        type="button"
                        className={`${styles.docLink} ${selectedDoc?.id === doc.id ? styles.docLinkActive : ""}`}
                        onClick={() => selectDoc(doc.id)}
                      >
                        <span>{doc.title}</span>
                        <small>{kindLabels[doc.kind]}</small>
                      </button>
                    ))}
                  </div>
                ))}
              </section>
            ))}
            {!filteredDocs.length && <div className={styles.emptySidebar}>没有匹配的 API 文档</div>}
          </div>
        </aside>

        <main className={styles.content}>
          {selectedDoc ? (
            <>
              <div className={styles.contentHeader}>
                <div className={styles.breadcrumb}>
                  {selectedDoc.group} / {selectedDoc.module}
                </div>
                <div className={styles.contentMeta}>
                  {kindLabels[selectedDoc.kind]} · {selectedDoc.id}
                </div>
              </div>
              <MarkdownContent doc={selectedDoc} docIds={docIds} onNavigate={selectDoc} />
            </>
          ) : (
            <div className={styles.emptyContent}>
              没有可显示的 API 文档，请先运行 <code>npm run docs:api</code>。
            </div>
          )}
        </main>

        <aside className={styles.toc}>
          <div className={styles.tocTitle}>本页目录</div>
          {headings.map((heading) => (
            <a
              key={heading.id}
              className={heading.level === 3 ? styles.tocNested : ""}
              href={`#${heading.id}`}
            >
              {heading.text}
            </a>
          ))}
        </aside>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

// A deliberately tiny Markdown renderer for the weekly brief. It builds React elements
// (never HTML strings), so every character of the brief is escaped by construction.
// Supported: # headings, paragraphs, - / * / 1. lists, **bold**, *italic*, `code`, [text](https://…).

type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "p", text: para.join(" ") });
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "h", level: (h[1] ?? "#").length, text: h[2] ?? "" });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === "ul") last.items.push(ul[1] ?? "");
      else blocks.push({ type: "ul", items: [ul[1] ?? ""] });
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.type === "ol") last.items.push(ol[1] ?? "");
      else blocks.push({ type: "ol", items: [ol[1] ?? ""] });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE_SRC = "(\\*\\*[^*\\n]+\\*\\*|`[^`\\n]+`|\\[[^\\]\\n]+\\]\\([^)\\s]+\\)|\\*[^*\\n]+\\*)";

export function renderInline(text: string): ReactNode[] {
  const re = new RegExp(INLINE_SRC, "g");
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<strong key={key++}>{renderInline(tok.slice(2, -2))}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(
        <code key={key++} className="mono">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = mm?.[1] ?? tok;
      const href = mm?.[2] ?? "";
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a key={key++} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        out.push(<span key={key++}>{label}</span>);
      }
    } else {
      out.push(<em key={key++}>{renderInline(tok.slice(1, -1))}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders the brief inside a panel: headings are demoted (# → h3) so the panel's own title stays the h2. */
export function renderMarkdown(md: string): ReactNode {
  const blocks = parseBlocks(md);
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h": {
            const level = Math.min(6, b.level + 2);
            const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
            return (
              <Tag key={i} className={`md-h md-h${b.level}`}>
                {renderInline(b.text)}
              </Tag>
            );
          }
          case "ul":
            return (
              <ul key={i} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={i} className="md-p">
                {renderInline(b.text)}
              </p>
            );
        }
      })}
    </>
  );
}

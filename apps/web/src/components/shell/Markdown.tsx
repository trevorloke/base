import { renderMarkdown } from "@/lib/markdown";

// Settings copy is short and the same on every request, so keep the rendered
// HTML instead of parsing it again each time.
const rendered = new Map<string, string>();

function toHtml(text: string): string {
  let html = rendered.get(text);
  if (html === undefined) {
    html = renderMarkdown(text);
    if (rendered.size > 500) rendered.clear();
    rendered.set(text, html);
  }
  return html;
}

/** Staff-written Markdown (sanitized) in a block wrapper that carries the styling class. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  if (!text.trim()) return null;
  return <div className={["md", className].filter(Boolean).join(" ")} dangerouslySetInnerHTML={{ __html: toHtml(text) }} />;
}

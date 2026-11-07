import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED = {
  allowedTags: ["p", "br", "strong", "em", "b", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "h2", "h3", "h4", "hr", "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td", "code", "pre"],
  allowedAttributes: { a: ["href", "title", "rel", "target"], img: ["src", "alt", "title", "width", "height"], th: ["align"], td: ["align"] },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  transformTags: {
    a: (tagName: string, attribs: Record<string, string>) => {
      const external = /^https?:\/\//i.test(attribs.href ?? "") && !attribs.href.startsWith(process.env.NEXT_PUBLIC_SITE_URL ?? "\u0000");
      return { tagName, attribs: external ? { ...attribs, rel: "noopener noreferrer", target: "_blank" } : attribs };
    },
  },
};

/** Markdown written by staff → HTML safe to render with dangerouslySetInnerHTML. */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  // h1 is the page title; demote any heading the author typed as #.
  return sanitizeHtml(html.replace(/<(\/?)h1>/g, "<$1h2>"), ALLOWED);
}

/** Markdown → plain text, for email text parts and summaries. */
export function markdownToText(markdown: string): string {
  return sanitizeHtml(marked.parse(markdown, { async: false }) as string, { allowedTags: [], allowedAttributes: {} })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function excerpt(markdown: string, length = 160): string {
  const text = markdownToText(markdown).replace(/\s+/g, " ");
  return text.length <= length ? text : text.slice(0, length - 1).replace(/\s\S*$/, "") + "…";
}

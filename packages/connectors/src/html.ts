import { classifyHttpStatus } from "./http.ts";
import { ConnectorError } from "./types.ts";

/**
 * Starsign post text → safe HTML for blog and newsletter platforms (WordPress, Ghost, Mailchimp, Kit).
 *
 * A post's `text` is markdown-ish plain text written in the composer. We render a deliberately small subset:
 * paragraphs (blank line), line breaks, `#`/`##`/`###` headings, `-`/`*` bullet and `1.` numbered lists, `>` quotes,
 * `**bold**`, `*italic*`/`_italic_`, `` `code` ``, `[label](https://...)` links and bare http(s) URLs.
 *
 * Safety: everything that is not one of those constructs is HTML-escaped, so a post can never inject markup or
 * script. Links are only emitted for http(s) URLs, and attribute values are escaped. Raw HTML in the text is shown
 * as text, by design.
 */

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** The URL when it is an absolute http(s) URL, else null (javascript:, data:, relative paths are refused). */
export function safeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function anchor(href: string, label: string): string {
  const safe = safeUrl(href);
  return safe ? `<a href="${escapeHtml(safe)}">${label}</a>` : label;
}

// One pass over a line: markdown links, bare URLs, bold, inline code, italics. Everything between matches is escaped.
const INLINE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'])|\*\*([^*\n]+?)\*\*|`([^`\n]+)`|(?<![\w*])\*([^*\s|](?:[^*\n|]*[^*\s|])?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])/g;

/** Render one line (or paragraph fragment) of inline markdown to escaped HTML. */
export function inlineHtml(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    out += escapeHtml(text.slice(last, i));
    last = i + m[0].length;
    const [, label, href, bare, bold, code, star, under] = m;
    if (label !== undefined && href !== undefined) out += anchor(href, escapeHtml(label));
    else if (bare !== undefined) out += anchor(bare, escapeHtml(bare));
    else if (bold !== undefined) out += `<strong>${inlineHtml(bold)}</strong>`;
    else if (code !== undefined) out += `<code>${escapeHtml(code)}</code>`;
    else if (star !== undefined) out += `<em>${inlineHtml(star)}</em>`;
    else if (under !== undefined) out += `<em>${inlineHtml(under)}</em>`;
  }
  return out + escapeHtml(text.slice(last));
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function block(lines: string[]): string {
  const first = lines[0] ?? "";
  const heading = lines.length === 1 ? first.match(HEADING) : null;
  if (heading) {
    // Post titles are the page's h1, so body headings start at h2.
    const level = Math.min((heading[1] ?? "#").length + 1, 4);
    return `<h${level}>${inlineHtml(heading[2] ?? "")}</h${level}>`;
  }
  if (lines.every((l) => BULLET.test(l))) return `<ul>${lines.map((l) => `<li>${inlineHtml(l.match(BULLET)?.[1] ?? "")}</li>`).join("")}</ul>`;
  if (lines.every((l) => NUMBERED.test(l))) return `<ol>${lines.map((l) => `<li>${inlineHtml(l.match(NUMBERED)?.[1] ?? "")}</li>`).join("")}</ol>`;
  if (lines.every((l) => QUOTE.test(l))) return `<blockquote><p>${lines.map((l) => inlineHtml(l.match(QUOTE)?.[1] ?? "")).join("<br>")}</p></blockquote>`;
  return `<p>${lines.map((l) => inlineHtml(l)).join("<br>")}</p>`;
}

export interface HtmlImage {
  src: string;
  alt?: string | null | undefined;
}

/** An <img> (inside a <figure>) for a public image URL; empty when the URL is not http(s). */
export function imageHtml(img: HtmlImage): string {
  const src = safeUrl(img.src);
  return src ? `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(img.alt ?? "")}"></figure>` : "";
}

/**
 * Body text → HTML blocks. `images` are appended after the text (each in a figure); `link` is appended as its own
 * paragraph when the text does not already contain it.
 */
export function textToHtml(text: string, opts: { images?: HtmlImage[]; link?: string | undefined } = {}): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const blocks: string[] = [];
  if (normalized) {
    for (const para of normalized.split(/\n\s*\n/)) {
      const lines = para.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) continue;
      // A heading line followed directly by text still reads as a heading plus a paragraph.
      const head = lines[0] ?? "";
      if (lines.length > 1 && HEADING.test(head)) {
        blocks.push(block([head]), block(lines.slice(1)));
      } else {
        blocks.push(block(lines));
      }
    }
  }
  if (opts.link && !normalized.includes(opts.link)) {
    const safe = safeUrl(opts.link);
    if (safe) blocks.push(`<p>${anchor(safe, escapeHtml(safe))}</p>`);
  }
  for (const img of opts.images ?? []) {
    const html = imageHtml(img);
    if (html) blocks.push(html);
  }
  return blocks.join("\n");
}

/** Markdown-ish text → plain text (markers stripped), for subjects, excerpts and titles. */
export function plainText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(?<![\w*])\*([^*\s|](?:[^*\n|]*[^*\s|])?)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^_\n]+?)_(?![\w_])/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .trim();
}

/** The first non-empty line as plain text: the fallback subject line for newsletters. */
export function firstLine(text: string): string {
  return plainText(text).split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** The first paragraph as plain text, cut at `max` characters on a word boundary. */
export function firstParagraph(text: string, max = 300): string {
  const para = plainText(text).split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (para.length <= max) return para;
  const cut = para.slice(0, max - 1);
  // Keep the cut as is when it already ends on a word boundary; otherwise back up to the last space.
  const space = /\s/.test(para.charAt(max - 1)) ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const DECODE: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—" };

/** Rendered HTML from a platform (a WordPress or Ghost comment) → readable plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
      if (ent[0] === "#") {
        const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
      }
      return DECODE[ent.toLowerCase()] ?? whole;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A filename for an upload: the URL's last path segment when it has an extension, else one from the mime type. */
export function uploadFileName(url: string, mime: string, fallback = "upload"): string {
  const last = url.split(/[?#]/)[0]?.split("/").pop() ?? "";
  const clean = last.replace(/[^A-Za-z0-9._-]/g, "_");
  if (/\.[A-Za-z0-9]{2,5}$/.test(clean) && clean.length <= 120) return clean;
  const ext = (mime.split("/")[1] ?? "bin").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
  const stem = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(clean) ? clean : fallback;
  return `${stem}.${ext}`;
}

/** Retry-After (seconds or HTTP date) → seconds from now, when present. */
export function retryAfterSeconds(headers: Headers, now: Date = new Date()): number | undefined {
  const v = headers.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now.getTime()) / 1000)) : undefined;
}

/** Site URL → stable account key "host[/path]" (no scheme, no trailing slash, lowercase host). */
export function siteKey(siteUrl: string): string {
  const u = new URL(siteUrl);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.host.toLowerCase()}${path}`;
}

/** Normalize a site URL a person typed: add https:// when missing, drop query/hash and trailing slashes. */
export function normalizeSiteUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * HTTP failure → ConnectorError for the blog/newsletter connectors. 429 is rate_limit (retryable) with the
 * Retry-After hint in the message; 5xx is a retryable network error; 401/403 are auth unless `forbiddenIsRejected`.
 * `detail` is the platform's own error text; never pass anything that may contain a credential.
 */
export function httpFailure(prefix: string, status: number, detail: string, headers: Headers, cause: unknown, opts: { now?: Date; forbiddenIsRejected?: boolean } = {}): ConnectorError {
  const msg = `${prefix}: HTTP ${status}${detail ? ` ${detail}` : ""}`;
  if (status === 429) {
    const after = retryAfterSeconds(headers, opts.now);
    return new ConnectorError(`${msg}; rate limited, retry after ${after ?? "?"}s`, "rate_limit", true, { status, retryAfterSeconds: after, body: cause });
  }
  if (status === 403 && opts.forbiddenIsRejected) return new ConnectorError(msg, "rejected", false, { status, body: cause });
  const { kind, retryable } = classifyHttpStatus(status);
  return new ConnectorError(msg, kind, retryable, { status, body: cause });
}

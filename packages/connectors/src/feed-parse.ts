/**
 * A small, forgiving XML reader and RSS/Atom parser for the `rss` connector. No dependencies.
 *
 * Reads RSS 0.9x/2.0, RSS 1.0 (RDF) and Atom 1.0. It builds a light element tree with a single linear scan:
 * CDATA sections are text, comments and processing instructions are skipped, and a DOCTYPE (with any internal
 * subset) is skipped without expanding its entities, so entity-expansion and external-entity attacks do nothing.
 * Namespaces are resolved from xmlns declarations, so `content:encoded`, `dc:creator` and `atom:link` are found
 * whatever prefix a feed uses. Malformed feeds (unclosed tags, stray `&`, HTML entities in XML) still parse.
 */

export const NS = {
  atom: "http://www.w3.org/2005/Atom",
  rss1: "http://purl.org/rss/1.0/",
  rss090: "http://my.netscape.com/rdf/simple/0.9/",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  content: "http://purl.org/rss/1.0/modules/content/",
  dc: "http://purl.org/dc/elements/1.1/",
  xml: "http://www.w3.org/XML/1998/namespace",
} as const;

/** Conventional prefixes, used when a feed forgets to declare a namespace (common with `content:` and `dc:`). */
const CONVENTIONAL: Record<string, string> = { atom: NS.atom, content: NS.content, dc: NS.dc, rdf: NS.rdf, xml: NS.xml };

export interface XmlElement {
  /** Qualified name as written ("content:encoded"). */
  name: string;
  local: string;
  /** Namespace URI ("" when none). */
  ns: string;
  attrs: Record<string, string>;
  children: (XmlElement | string)[];
  /** In-scope xml:lang, inherited from ancestors. */
  lang: string | null;
}

// ---------------------------------------------------------------- entities

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  // HTML entities that feeds put in XML anyway (or that show up after unescaping HTML content).
  nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", copy: "©", reg: "®",
  trade: "™", deg: "°", middot: "·", bull: "•", euro: "€", pound: "£", yen: "¥",
  cent: "¢", sect: "§", para: "¶", times: "×", divide: "÷", plusmn: "±", frac12: "½",
  frac14: "¼", frac34: "¾", iexcl: "¡", iquest: "¿", shy: "­", zwj: "‍", zwnj: "‌",
  thinsp: " ", ensp: " ", emsp: " ", lrm: "‎", rlm: "‏", prime: "′", dagger: "†",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", agrave: "à", egrave: "è",
  igrave: "ì", ograve: "ò", ugrave: "ù", acirc: "â", ecirc: "ê", icirc: "î", ocirc: "ô",
  ucirc: "û", auml: "ä", euml: "ë", iuml: "ï", ouml: "ö", uuml: "ü", yuml: "ÿ", atilde: "ã",
  otilde: "õ", ntilde: "ñ", ccedil: "ç", aring: "å", aelig: "æ", oslash: "ø", szlig: "ß",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Agrave: "À", Egrave: "È",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Ntilde: "Ñ", Ccedil: "Ç", Aring: "Å", AElig: "Æ", Oslash: "Ø",
};

/** Decode XML/HTML character references: named (XML + common HTML), decimal and hex. Unknown ones stay as written. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Invalid code points (surrogates, beyond U+10FFFF, NUL) become U+FFFD rather than throwing.
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return NAMED[ref] ?? whole;
  });
}

// ---------------------------------------------------------------- XML tree

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** Find the `>` closing a tag that starts at `from`, skipping `>` inside quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** Skip `<!DOCTYPE ...>` including an internal subset in brackets. Returns the index after it. */
function skipDoctype(xml: string, from: number): number {
  let depth = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0) return i + 1;
  }
  return xml.length;
}

interface Scope {
  prefixes: Record<string, string>;
}

/**
 * Parse XML into a tree. Returns the root element, or null when the text holds no element.
 * Tolerant: mismatched close tags close back to the nearest matching open element; unclosed elements end at EOF.
 */
export function parseXml(xml: string): XmlElement | null {
  const docRoot: XmlElement = { name: "#document", local: "#document", ns: "", attrs: {}, children: [], lang: null };
  const stack: { el: XmlElement; scope: Scope }[] = [{ el: docRoot, scope: { prefixes: { ...CONVENTIONAL, "": "" } } }];
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const top = () => stack[stack.length - 1]!;
  const pushText = (t: string) => {
    if (!t) return;
    const kids = top().el.children;
    const last = kids[kids.length - 1];
    if (typeof last === "string") kids[kids.length - 1] = last + t;
    else kids.push(t);
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      pushText(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      pushText(xml.slice(lt + 9, end < 0 ? xml.length : end));
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith("<!", lt)) {
      i = skipDoctype(xml, lt + 2);
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? xml.length : end + 2;
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt + 2);
      const name = xml.slice(lt + 2, end < 0 ? xml.length : end).trim();
      i = end < 0 ? xml.length : end + 1;
      // Close back to the matching element; ignore a close tag nothing matches.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d]!.el.name === name) {
          stack.length = d;
          break;
        }
      }
    } else {
      const end = tagEnd(xml, lt + 1);
      if (end < 0) {
        pushText(decodeEntities(xml.slice(lt)));
        break;
      }
      let inner = xml.slice(lt + 1, end);
      i = end + 1;
      const selfClosing = inner.endsWith("/");
      if (selfClosing) inner = inner.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch) {
        pushText("<");
        i = lt + 1;
        continue;
      }
      const name = nameMatch[0];
      const attrs: Record<string, string> = {};
      for (const m of inner.slice(name.length).matchAll(ATTR)) {
        if (!m[1]) continue;
        attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
      }
      const parent = top();
      const prefixes = { ...parent.scope.prefixes };
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "xmlns") prefixes[""] = v;
        else if (k.startsWith("xmlns:")) prefixes[k.slice(6)] = v;
      }
      const colon = name.indexOf(":");
      const prefix = colon > 0 ? name.slice(0, colon) : "";
      const local = colon > 0 ? name.slice(colon + 1) : name;
      const lang = attrs["xml:lang"] ?? parent.el.lang;
      const el: XmlElement = { name, local, ns: prefixes[prefix] ?? "", attrs, children: [], lang: lang || null };
      parent.el.children.push(el);
      if (!selfClosing) stack.push({ el, scope: { prefixes } });
    }
  }
  return docRoot.children.find((c): c is XmlElement => typeof c !== "string") ?? null;
}

export function elements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== "string");
}

/** Children with this local name, optionally limited to namespaces. */
export function childrenOf(el: XmlElement, local: string, ns?: readonly string[]): XmlElement[] {
  return elements(el).filter((c) => c.local === local && (!ns || ns.includes(c.ns)));
}

export function childOf(el: XmlElement, local: string, ns?: readonly string[]): XmlElement | undefined {
  return elements(el).find((c) => c.local === local && (!ns || ns.includes(c.ns)));
}

/** All descendant text, in document order (entities already decoded, CDATA as written). */
export function textContent(el: XmlElement | undefined): string {
  if (!el) return "";
  let out = "";
  for (const c of el.children) out += typeof c === "string" ? c : textContent(c);
  return out;
}

// ---------------------------------------------------------------- HTML → text

/** HTML (as found in feed descriptions) → plain text: drops scripts/styles/tags, keeps paragraph breaks, decodes entities. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section|article|figure|pre)\s*>/gi, "\n\n")
      .replace(/<(li)\b[^>]*>/gi, "\n• ")
      // Inline tags vanish without a gap ("<a>rocket</a>." stays "rocket."); other tags separate words.
      .replace(/<\/?(a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)\b[^>]*>/gi, "")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- feeds

export interface ParsedFeedItem {
  /** guid / id, when the feed gives one. */
  id: string | null;
  title: string;
  /** Absolute http(s) link to the item, or null. */
  link: string | null;
  /** Plain-text body (summary or content, HTML stripped), uncapped. */
  summary: string;
  author: string | null;
  /** ISO timestamp from pubDate / published / updated / dc:date, or null when missing or unreadable. */
  published: string | null;
  /** xml:lang on the entry, when present. */
  lang: string | null;
}

export interface ParsedFeed {
  format: "rss2" | "rss1" | "atom";
  title: string;
  /** The site the feed belongs to. */
  link: string | null;
  /** Feed language as written (`<language>`, `dc:language`, xml:lang), or null. */
  language: string | null;
  items: ParsedFeedItem[];
}

/** RSS 2.0 elements carry no namespace; RSS 1.0 and 0.90 have their own. Atom elements embedded in RSS do not count. */
const RSS_NS = ["", NS.rss1, NS.rss090] as const;
const ATOM_NS = [NS.atom] as const;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Resolve a link against the feed URL; only http(s) results are kept. */
export function absoluteHttpUrl(href: string | null | undefined, base: string | undefined): string | null {
  const h = (href ?? "").trim();
  if (!h) return null;
  try {
    const u = base ? new URL(h, base) : new URL(h);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** RFC 822 / RFC 3339 / W3CDTF dates → ISO, or null. */
export function parseFeedDate(s: string | null | undefined): string | null {
  const v = (s ?? "").trim();
  if (!v) return null;
  let t = Date.parse(v);
  if (!Number.isFinite(t)) {
    // "Tue, 03 Jun 2026 09:39:21 +0000 (UTC)", single-digit days, a trailing weekday or "UT": trim and retry.
    const simplified = v.replace(/\s*\([^)]*\)\s*$/, "").replace(/\bUT\b/, "GMT").replace(/^[A-Za-z]{3,9},?\s*/, "");
    t = Date.parse(simplified);
  }
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "jane@example.com (Jane Doe)" → "Jane Doe"; a bare e-mail address is dropped (never shown as a name). */
function authorName(raw: string): string | null {
  const v = clean(raw);
  if (!v) return null;
  const paren = /\(([^)]+)\)\s*$/.exec(v);
  if (paren?.[1] && /@/.test(v.slice(0, paren.index))) return clean(paren[1]);
  if (/^[^\s@]+@[^\s@]+$/.test(v)) return null;
  return v;
}

/** The text of an Atom text construct (type text | html | xhtml) or an RSS element that may hold escaped HTML. */
function textConstruct(el: XmlElement | undefined, assumeHtml: boolean): string {
  if (!el) return "";
  const type = (el.attrs.type ?? "").toLowerCase();
  if (type === "xhtml") return htmlToText(serializeChildren(el));
  const raw = textContent(el);
  if (type === "text" || type === "text/plain") return clean(raw);
  return assumeHtml || type === "html" || type === "text/html" || /<[a-z!/]/i.test(raw) ? htmlToText(raw) : raw.trim();
}

/** Titles are one line; feeds often double-escape them ("Tom &amp;amp; Jerry"), so decode once more. */
function titleOf(el: XmlElement | undefined): string {
  return clean(decodeEntities(textConstruct(el, false)));
}

/** Re-serialize child markup (for Atom xhtml content) so htmlToText keeps its block breaks. */
function serializeChildren(el: XmlElement): string {
  let out = "";
  for (const c of el.children) {
    if (typeof c === "string") out += c.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    else out += `<${c.local}>${serializeChildren(c)}</${c.local}>`;
  }
  return out;
}

function atomLink(el: XmlElement, base: string | undefined): string | null {
  const links = childrenOf(el, "link", ATOM_NS);
  const alt = links.find((l) => (l.attrs.rel ?? "alternate") === "alternate" && (!l.attrs.type || /html/i.test(l.attrs.type))) ?? links.find((l) => (l.attrs.rel ?? "alternate") === "alternate");
  return absoluteHttpUrl(alt?.attrs.href, base);
}

function atomAuthor(el: XmlElement | undefined): string | null {
  if (!el) return null;
  const a = childOf(el, "author", ATOM_NS);
  return a ? authorName(textContent(childOf(a, "name", ATOM_NS))) : null;
}

/** Parse an RSS/Atom document. Returns null when the XML is not a feed (an HTML page, an error body). */
export function parseFeed(xml: string, feedUrl?: string): ParsedFeed | null {
  const root = parseXml(xml);
  if (!root) return null;
  if (root.local === "feed" && (root.ns === NS.atom || root.ns === "")) return parseAtom(root, feedUrl);
  if (root.local === "rss") {
    const channel = childOf(root, "channel");
    return channel ? parseRss(channel, childrenOf(channel, "item", RSS_NS), "rss2", feedUrl) : null;
  }
  if (root.local === "RDF") {
    const channel = childOf(root, "channel", RSS_NS);
    // RSS 1.0 items are siblings of the channel; some feeds nest them anyway.
    const items = [...childrenOf(root, "item", RSS_NS), ...(channel ? childrenOf(channel, "item", RSS_NS) : [])];
    return channel || items.length ? parseRss(channel ?? root, items, "rss1", feedUrl) : null;
  }
  return null;
}

function parseRss(channel: XmlElement, items: XmlElement[], format: "rss2" | "rss1", feedUrl: string | undefined): ParsedFeed {
  const channelLink = absoluteHttpUrl(textContent(childOf(channel, "link", RSS_NS)), feedUrl);
  const language = clean(textContent(childOf(channel, "language", RSS_NS))) || clean(textContent(childOf(channel, "language", [NS.dc]))) || channel.lang || null;
  return {
    format,
    title: titleOf(childOf(channel, "title", RSS_NS)),
    link: channelLink,
    language,
    items: items.map((it) => {
      const guid = childOf(it, "guid", RSS_NS);
      const id = clean(textContent(guid)) || it.attrs["rdf:about"] || null;
      const linkText = textContent(childOf(it, "link", RSS_NS));
      const permalink = guid && (guid.attrs.isPermaLink ?? "true").toLowerCase() !== "false" ? textContent(guid) : null;
      const link = absoluteHttpUrl(linkText, feedUrl) ?? atomLink(it, feedUrl) ?? absoluteHttpUrl(permalink, feedUrl) ?? absoluteHttpUrl(it.attrs["rdf:about"], feedUrl);
      const content = textConstruct(childOf(it, "encoded", [NS.content]), true);
      const description = textConstruct(childOf(it, "description", RSS_NS), true);
      const author = authorName(textContent(childOf(it, "author", RSS_NS))) ?? authorName(textContent(childOf(it, "creator", [NS.dc]))) ?? atomAuthor(it);
      const published = parseFeedDate(textContent(childOf(it, "pubDate", RSS_NS))) ?? parseFeedDate(textContent(childOf(it, "date", [NS.dc]))) ?? parseFeedDate(textContent(childOf(it, "published", ATOM_NS))) ?? parseFeedDate(textContent(childOf(it, "updated", ATOM_NS)));
      return { id, title: titleOf(childOf(it, "title", RSS_NS)), link, summary: content || description, author, published, lang: it.lang && it.lang !== channel.lang ? it.lang : null };
    }),
  };
}

function parseAtom(feed: XmlElement, feedUrl: string | undefined): ParsedFeed {
  const ns = feed.ns === "" ? (["", NS.atom] as const) : ATOM_NS;
  const linkOf = (el: XmlElement) => {
    const links = childrenOf(el, "link", ns);
    const alt = links.find((l) => (l.attrs.rel ?? "alternate") === "alternate" && (!l.attrs.type || /html/i.test(l.attrs.type))) ?? links.find((l) => (l.attrs.rel ?? "alternate") === "alternate");
    return absoluteHttpUrl(alt?.attrs.href, feedUrl);
  };
  const authorOf = (el: XmlElement) => {
    const a = childOf(el, "author", ns);
    return a ? authorName(textContent(childOf(a, "name", ns))) : null;
  };
  const feedAuthor = authorOf(feed);
  return {
    format: "atom",
    title: titleOf(childOf(feed, "title", ns)),
    link: linkOf(feed),
    language: feed.lang,
    items: childrenOf(feed, "entry", ns).map((e) => {
      const content = childOf(e, "content", ns);
      // An out-of-line content (src=...) has no text; fall back to the summary.
      const body = content && !content.attrs.src ? textConstruct(content, false) : "";
      const summary = textConstruct(childOf(e, "summary", ns), false);
      return {
        id: clean(textContent(childOf(e, "id", ns))) || null,
        title: titleOf(childOf(e, "title", ns)),
        link: linkOf(e),
        summary: body || summary,
        author: authorOf(e) ?? feedAuthor,
        published: parseFeedDate(textContent(childOf(e, "published", ns))) ?? parseFeedDate(textContent(childOf(e, "updated", ns))),
        lang: e.lang && e.lang !== feed.lang ? e.lang : null,
      };
    }),
  };
}

/** `<link rel="alternate" type="application/rss+xml|atom+xml" href>` in an HTML page: the feed a site advertises. */
export function discoverFeedLink(html: string, pageUrl: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    const val = (name: string) => {
      const a = attr(name);
      return a ? decodeEntities(a[1] ?? a[2] ?? a[3] ?? "") : "";
    };
    if (!/\balternate\b/i.test(val("rel"))) continue;
    if (!/application\/(rss|atom|rdf)\+xml/i.test(val("type"))) continue;
    const href = absoluteHttpUrl(val("href"), pageUrl);
    if (href) return href;
  }
  return null;
}

/** "en-US" → "en"; anything that is not a 2-3 letter primary subtag → null. */
export function primaryLanguage(lang: string | null | undefined): string | null {
  const p = (lang ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return /^[a-z]{2,3}$/.test(p) ? p : null;
}

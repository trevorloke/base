// Email HTML built with plain strings so it works in every mail client and
// needs no React rendering. All dynamic text goes through `esc`.

const NAVY = "#003979";
const RED = "#D81B1E";
const YELLOW = "#FFF100";

export function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#0F1E33">${text}</p>`;
}

export function button(url: string, label: string, color: "red" | "navy" | "yellow" = "red"): string {
  const bg = color === "red" ? RED : color === "navy" ? NAVY : YELLOW;
  const fg = color === "yellow" ? NAVY : "#FFFFFF";
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 20px"><tr><td style="border-radius:6px;background:${bg}"><a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font-size:17px;font-weight:700;color:${fg};text-decoration:none;font-family:Montserrat,Arial,sans-serif">${esc(label)}</a></td></tr></table>`;
}

export type LayoutOptions = {
  title: string;
  /** Already-escaped HTML for the body. */
  bodyHtml: string;
  siteUrl: string;
  orgName?: string;
  orgEmail?: string;
  /** Shown in the footer: "You're getting this because…" */
  reason?: string;
  unsubscribeUrl?: string | null;
  /** Hidden preview text some clients show in the inbox. */
  preheader?: string;
};

export function layout(o: LayoutOptions): string {
  const org = esc(o.orgName ?? "Imagine Surrey");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#F2F4F8;font-family:Montserrat,Arial,Helvetica,sans-serif">
${o.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F2F4F8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:10px;overflow:hidden">
<tr><td style="background:${NAVY};padding:22px 28px"><a href="${esc(o.siteUrl)}" style="color:#FFFFFF;font-size:22px;font-weight:900;text-decoration:none;letter-spacing:0.02em">${org}</a></td></tr>
<tr><td style="height:6px;background:${YELLOW}"></td></tr>
<tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 18px;font-size:26px;line-height:1.2;color:${NAVY}">${esc(o.title)}</h1>${o.bodyHtml}</td></tr>
<tr><td style="padding:16px 28px 28px;border-top:1px solid #E3E7EF;font-size:13px;line-height:1.5;color:#4A5872">
${o.reason ? `<p style="margin:0 0 8px">${esc(o.reason)}</p>` : ""}
<p style="margin:0 0 8px">${org}${o.orgEmail ? ` · <a href="mailto:${esc(o.orgEmail)}" style="color:${NAVY}">${esc(o.orgEmail)}</a>` : ""} · Surrey, BC</p>
${o.unsubscribeUrl ? `<p style="margin:0"><a href="${esc(o.unsubscribeUrl)}" style="color:${NAVY}">Unsubscribe</a> from these emails.</p>` : ""}
</td></tr></table></td></tr></table></body></html>`;
}

/** A plain-text version from the same pieces, for clients that prefer text. */
export function textVersion(lines: string[], o: { orgName?: string; unsubscribeUrl?: string | null }): string {
  const out = [...lines, "", `— ${o.orgName ?? "Imagine Surrey"}`];
  if (o.unsubscribeUrl) out.push("", `Unsubscribe: ${o.unsubscribeUrl}`);
  return out.join("\n");
}

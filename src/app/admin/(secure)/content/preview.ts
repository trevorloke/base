"use server";

import { renderMarkdown } from "@/lib/markdown";
import { requireAdmin } from "@/lib/server/admin-auth";

/** Live preview for the Markdown editors: sanitized on the server, like the public pages. */
export async function previewMarkdown(markdown: string): Promise<string> {
  await requireAdmin("content");
  return renderMarkdown(String(markdown ?? "").slice(0, 60_000));
}

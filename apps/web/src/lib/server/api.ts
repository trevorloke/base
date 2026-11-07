import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { fieldErrors } from "@/lib/validation";
import { verifyHuman } from "./human";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(message: string, status = 400, fields?: Record<string, string>) {
  return NextResponse.json({ error: message, fields }, { status });
}

// A small fixed-window limiter per client IP. It is per server instance, which
// is enough to blunt form spam; put a WAF rule in front for anything stronger.
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimited(req: NextRequest, bucket: string, limit = 10, windowMs = 60_000): boolean {
  return keyRateLimited(`${bucket}:${clientIp(req) ?? "local"}`, limit, windowMs);
}

/** The visitor's IP address as the host reports it, if any. */
export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

/** The same fixed-window limiter for any key, e.g. one email address across every IP. */
export function keyRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt < now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: NextResponse };

/** The request header the forms' human check (HumanCheck) sends its token in. */
export const HUMAN_TOKEN_HEADER = "x-human-token";

export type ParseOptions = {
  /**
   * Require the human check (Cloudflare Turnstile, see ./human) when it is
   * configured. Set on every public route that creates a record, sends an
   * email or files a request for the desk.
   */
  human?: boolean;
};

/**
 * Rate-limit, read the JSON body, drop honeypot hits with a fake success,
 * run the human check (when asked for) and validate. In that order: a bot
 * that fills the honeypot never costs a call to Cloudflare.
 */
export async function parseBody<S extends z.ZodType>(req: NextRequest, schema: S, bucket: string, options: ParseOptions = {}): Promise<Parsed<z.output<S>>> {
  if (rateLimited(req, bucket)) return { ok: false, response: error("Too many requests. Please wait a minute and try again.", 429) };
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { ok: false, response: error("Expected a JSON body.") };
  }
  if (body && typeof body === "object" && "website" in body && (body as { website?: unknown }).website) {
    return { ok: false, response: json({ ok: true }) };
  }
  if (options.human) {
    const check = await verifyHuman(req.headers.get(HUMAN_TOKEN_HEADER), clientIp(req));
    if (!check.ok) return { ok: false, response: error(check.message, check.status, { human: check.field }) };
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, response: error("Please check the highlighted fields.", 422, fieldErrors(result.error)) };
  }
  return { ok: true, data: result.data };
}

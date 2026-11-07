import "server-only";

/**
 * Where to send a staff member after signing in: only a path inside /admin,
 * so a crafted link cannot bounce them to another site.
 */
export function safeNext(value: unknown): string {
  return typeof value === "string" && /^\/admin(\/[^/]|$)/.test(value) ? value : "/admin";
}

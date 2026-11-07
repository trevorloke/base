// Admin preview mode: with ADMIN_PREVIEW_MODE=1, anyone who opens /admin is
// signed in automatically as an owner, so the back office can be looked at
// without a password. It is for a copy of the site on someone's own machine
// with sample data, and it refuses to switch on anywhere else: the database
// must be on the same machine (localhost), and never on a Vercel production
// deploy or on Render. The live site keeps supporters' personal and
// political information, which must never be one click away.
// Pure, so the proxy (which runs without Node APIs) and the server share it.

type Env = Record<string, string | undefined>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function adminPreviewAllowed(env: Env = process.env): boolean {
  if (env.ADMIN_PREVIEW_MODE !== "1") return false;
  if (env.VERCEL_ENV === "production" || env.RENDER === "true" || env.VERCEL === "1") return false;
  try {
    const host = new URL(env.DATABASE_URL ?? "").hostname;
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

export const PREVIEW_OWNER_EMAIL = "preview@localhost";

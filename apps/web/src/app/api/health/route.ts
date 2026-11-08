// Render's health check (healthCheckPath: /api/health). It answers from the
// process alone, so a slow database never makes Render restart the site.
export const dynamic = "force-dynamic";

export function GET() {
  const commit = process.env.RENDER_GIT_COMMIT || process.env.BASE_WEB_COMMIT || null;
  return Response.json({ ok: true, service: "base-web", commit }, { headers: { "cache-control": "no-store" } });
}

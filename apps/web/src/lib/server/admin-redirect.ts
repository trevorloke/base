import "server-only";

/**
 * Where to send a staff member after signing in: only a path inside /admin,
 * so a crafted link cannot bounce them to another site.
 */
export function safeNext(value: unknown): string {
  return typeof value === "string" && /^\/admin(\/[^/]|$)/.test(value) ? value : "/admin";
}

/**
 * The email to show (or pre-fill) on the sign-in page after a redirect back
 * to it. It travels in a short-lived HttpOnly cookie scoped to the sign-in
 * page, never in the URL, so it stays out of browser history, server logs
 * and Referer headers.
 */
export const LOGIN_EMAIL_COOKIE = "is_admin_login_email";

export function loginEmailCookie(email: string) {
  return {
    name: LOGIN_EMAIL_COOKIE,
    value: email.trim().slice(0, 320),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/admin/login",
    maxAge: 5 * 60,
  };
}

// The Base switcher's list (SUITE.md, "The app switcher"): the client's apps
// a staffer may open from Base Web's admin. Base Ground's two faces come
// from BASE_GROUND_URL; Base Air appears when BASE_AIR_URL is set and opens
// through its own /auth/base, so the hop is already signed in.

export type SuiteApp = { id: "field" | "ground" | "air" | "web"; label: string; description: string; href: string; current: boolean };

export function suiteLinks(opts: { groundUrl?: string; airUrl?: string }): SuiteApp[] {
  const trim = (u: string) => u.replace(/\/+$/, "");
  const apps: SuiteApp[] = [];
  if (opts.groundUrl) {
    const ground = trim(opts.groundUrl);
    apps.push({ id: "field", label: "Field", description: "Base Ground for volunteers", href: `${ground}/field/`, current: false });
    apps.push({ id: "ground", label: "Ground", description: "Base Ground, the desk", href: `${ground}/ground/`, current: false });
  }
  if (opts.airUrl) apps.push({ id: "air", label: "Air", description: "Base Air: listening and posts", href: `${trim(opts.airUrl)}/auth/base?next=/`, current: false });
  apps.push({ id: "web", label: "Web", description: "Base Web: this website's admin", href: "/admin", current: true });
  return apps;
}

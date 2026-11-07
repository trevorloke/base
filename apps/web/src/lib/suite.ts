// The base switcher's list (SUITE.md, "The app switcher"): the client's apps
// a staffer may open from base web's admin. base ground's two faces come
// from BASE_GROUND_URL; base air appears when BASE_AIR_URL is set and opens
// through its own /auth/base, so the hop is already signed in.

export type SuiteApp = { id: "field" | "ground" | "air" | "web"; label: string; description: string; href: string; current: boolean };

export function suiteLinks(opts: { groundUrl?: string; airUrl?: string }): SuiteApp[] {
  const trim = (u: string) => u.replace(/\/+$/, "");
  const apps: SuiteApp[] = [];
  if (opts.groundUrl) {
    const ground = trim(opts.groundUrl);
    apps.push({ id: "field", label: "field", description: "base ground for volunteers", href: `${ground}/field/`, current: false });
    apps.push({ id: "ground", label: "ground", description: "base ground, the desk", href: `${ground}/ground/`, current: false });
  }
  if (opts.airUrl) apps.push({ id: "air", label: "air", description: "base air: listening and posts", href: `${trim(opts.airUrl)}/auth/base?next=/`, current: false });
  apps.push({ id: "web", label: "web", description: "base web: this website's admin", href: "/admin", current: true });
  return apps;
}

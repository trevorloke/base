import type { SectionKey } from "@/lib/settings";

/** Where each settings section shows on the public site, for the Preview links. */
export const PREVIEW_PATHS: Record<SectionKey, string> = {
  header: "/",
  homeModules: "/",
  org: "/",
  announcement: "/",
  hero: "/#top",
  pillars: "/#stand",
  membership: "/#join",
  stop: "/#stop",
  donate: "/donate",
  skytrain: "/#skytrain",
  organize: "/#join",
  board: "/#about",
  committees: "/#committees",
  socials: "/#social",
  footer: "/",
  seo: "/",
};

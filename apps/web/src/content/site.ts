// The main navigation and the shared shape of the site's pillars. Each
// client's own copy lives in src/seeds/<client>.

export type PillarIcon = "shield" | "bus" | "trend" | "tag" | "civic";

// The main navigation (the header). The red Donate button and the supporter
// sign-in link sit after these.
export const nav = [
  { href: "/tracker", label: "Promise tracker" },
  { href: "/volunteer", label: "Volunteer" },
  { href: "/events", label: "Events" },
  { href: "/act", label: "Act" },
  { href: "/#join", label: "Join" },
  { href: "/news", label: "News" },
];

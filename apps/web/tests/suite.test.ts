// The Base switcher in the admin's top bar (SUITE.md, "The app switcher").
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { suiteLinks } from "@/lib/suite";
import { BaseSwitcher } from "@/components/admin/BaseSwitcher";

describe("the switcher's apps", () => {
  it("lists Base Ground's field and ground, Base Air through its sign-in, and this admin", () => {
    expect(suiteLinks({ groundUrl: "https://imaginesurrey.base.win/", airUrl: "https://imaginesurrey.base.win/air" }).map((a) => [a.id, a.href, a.current])).toEqual([
      ["field", "https://imaginesurrey.base.win/field/", false],
      ["ground", "https://imaginesurrey.base.win/ground/", false],
      ["air", "https://imaginesurrey.base.win/air/auth/base?next=/", false],
      ["web", "/admin", true],
    ]);
  });
  it("leaves Base Air out when BASE_AIR_URL isn't set", () => {
    expect(suiteLinks({ groundUrl: "https://imaginesurrey.base.win" }).map((a) => a.id)).toEqual(["field", "ground", "web"]);
  });
});

describe("the switcher's markup", () => {
  const html = renderToStaticMarkup(createElement(BaseSwitcher, { apps: suiteLinks({ groundUrl: "https://x.base.win", airUrl: "https://x.base.win/air" }) }));
  it("is a closed disclosure button that names itself and controls the list", () => {
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"/);
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<ul id="${controls}" class="base-switcher__list" hidden="">`);
    expect(html).toMatch(/>Base<\/span><span class="visually-hidden">: switch app<\/span>/);
    expect(html).toContain(">Base</span> Air");
    expect(html).toContain(">Base</span> Web");
  });
  it("holds real links, with this app marked as the current page", () => {
    expect(html).toContain('href="https://x.base.win/field/"');
    expect(html).toContain('href="https://x.base.win/ground/"');
    expect(html).toContain('href="https://x.base.win/air/auth/base?next=/"');
    expect(html).toMatch(/href="\/admin" aria-current="page"/);
  });
});

// The base switcher in the admin's top bar (SUITE.md, "The app switcher").
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { suiteLinks } from "@/lib/suite";
import { BaseSwitcher } from "@/components/admin/BaseSwitcher";

describe("the switcher's apps", () => {
  it("lists base ground's field and ground, base air through its sign-in, and this admin", () => {
    expect(suiteLinks({ groundUrl: "https://base.win/imaginesurrey/", airUrl: "https://base.win/imaginesurrey/air" }).map((a) => [a.id, a.href, a.current])).toEqual([
      ["field", "https://base.win/imaginesurrey/field/", false],
      ["ground", "https://base.win/imaginesurrey/ground/", false],
      ["air", "https://base.win/imaginesurrey/air/auth/base?next=/", false],
      ["web", "/admin", true],
    ]);
  });
  it("leaves base air out when BASE_AIR_URL isn't set", () => {
    expect(suiteLinks({ groundUrl: "https://base.win/imaginesurrey" }).map((a) => a.id)).toEqual(["field", "ground", "web"]);
  });
});

describe("the switcher's markup", () => {
  const html = renderToStaticMarkup(createElement(BaseSwitcher, { apps: suiteLinks({ groundUrl: "https://base.win/x", airUrl: "https://base.win/x/air" }) }));
  it("is a closed disclosure button that names itself and controls the list", () => {
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"/);
    const controls = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<ul id="${controls}" class="base-switcher__list" hidden="">`);
    expect(html).toMatch(/>base<\/span><span class="visually-hidden">: switch app<\/span>/);
  });
  it("holds real links, with this app marked as the current page", () => {
    expect(html).toContain('href="https://base.win/x/field/"');
    expect(html).toContain('href="https://base.win/x/ground/"');
    expect(html).toContain('href="https://base.win/x/air/auth/base?next=/"');
    expect(html).toMatch(/href="\/admin" aria-current="page"/);
  });
});

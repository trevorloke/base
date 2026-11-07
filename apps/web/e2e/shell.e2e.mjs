// The site shell: the home page's "Act now" rail (with no public counts), the
// header, skip link and mobile menu, SEO files, the retired /stats page, the
// accessibility statement, news pages, phone widths and structural
// accessibility checks.
import { chromium } from "playwright";
import { adminCookie, BASE, finish, ok, sql } from "./helpers.mjs";

// ── Seed by SQL, then refresh the cached public pages ──────────────────────
const people = [];
for (let i = 1; i <= 14; i++) {
  const email = `shell-${i}@example.com`;
  const [p] = await sql`insert into people (email, first_name, last_name) values (${email}, ${"Shell" + i}, 'Tester')
    on conflict (email) do update set first_name = excluded.first_name returning id, email`;
  people.push(p);
}
// Members and signers exist, so a count would have something to show if one were still published.
for (const p of people.slice(0, 10)) await sql`insert into memberships (person_id, status, fee_cents, voting_eligible, starts_at) values (${p.id}, 'active', 1000, true, now())`;
const sign = (campaign, p, postal) =>
  sql`insert into campaign_signatures (campaign, person_id, first_name, last_name, email, postal_code) values (${campaign}, ${p.id}, 'Shell', 'Tester', ${p.email}, ${postal}) on conflict do nothing`;
for (const p of people.slice(0, 11)) await sign("stop-mccallum-pledge", p, "V3T 1A1");
for (const p of people.slice(0, 4)) await sign("skytrain-south-surrey", p, "V3T 2B2");
await sql`insert into events (slug, title, starts_at, location, summary) values ('shell-rail-meetup', 'Shell rail meetup', now() + interval '2 days', 'Whalley Library', 'Come say hi.') on conflict do nothing`;
await sql`insert into events (slug, title, starts_at, location, summary, published) values ('shell-hidden-event', 'Shell hidden event', now() + interval '1 day', 'Nowhere', 'Draft.', false) on conflict do nothing`;
await sql`insert into shift_openings (date, slot, title, location) values ((now() at time zone 'America/Vancouver')::date + 3, 'morning', 'Shell door-knock in Whalley', 'King George Station')`;
await sql`insert into tracker_updates (promise_id, date, status, note) select id, (now() at time zone 'America/Vancouver')::date, 'broken', 'Shell suite update' from tracker_promises where number = 7`;
const [promise7] = await sql`select title from tracker_promises where number = 7`;
await sql`insert into news_posts (slug, title, summary, body, published_at) values ('shell-news-post', 'Shell news post with a long headline about neighbourhoods', 'A summary for sharing.', 'Body with **bold** text.

A second paragraph.', now()) on conflict do nothing`;
// The home page is cached; the rows above went in behind the site's back.
ok((await fetch(BASE + "/api/admin/revalidate", { method: "POST", headers: { cookie: await adminCookie() } })).ok, "cached public pages refreshed after seeding");
await sql`delete from admin_users`;

const [{ members }] = await sql`select count(distinct person_id)::int as members from memberships where status = 'active' and (expires_at is null or expires_at > now())`;
const [{ pledge }] = await sql`select count(distinct lower(email))::int as pledge from campaign_signatures where campaign = 'stop-mccallum-pledge'`;

const browser = await chromium.launch();

// ── The rail: what's next, and no counts ───────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const res = await page.goto(BASE + "/");
  ok(res.status() === 200, "home page renders");
  const rail = page.locator("#act-now");
  ok((await rail.count()) === 1, "the Act now rail is on the home page");
  ok((await page.locator(".rail-stats, .rail-stat, .countup, [data-stat]").count()) === 0, "the rail has no live numbers");
  const railText = await rail.textContent();
  ok(!railText.includes("members organizing") && !railText.includes("signed the pledge to stop") && !railText.includes("want SkyTrain to South Surrey"), "the rail's count labels are gone");
  ok(members >= 10 && pledge >= 11, `members (${members}) and pledge signers (${pledge}) are on file, so a published count would have had something to show`);
  ok((await page.locator(".area-chip, .local-block, .your-surrey").count()) === 0, "the 'Your area' chip and local counts are gone");
  ok((await rail.locator('a[href="/neighbourhoods"]').count()) === 1, "the rail links to the neighbourhood pages instead");
  // Other suites may have added sooner events; the rail shows the next two published ones.
  const nextTwo = (await sql`select slug from events where published and starts_at >= now() order by starts_at limit 2`).map((e) => e.slug);
  ok(nextTwo.length > 0 && (await Promise.all(nextTwo.map(async (slug) => (await page.locator(`#act-now a[href="/events/${slug}"]`).count()) === 1))).every(Boolean), `Next up links to the next upcoming events (${nextTwo.join(", ")})`);
  ok((await page.locator('#act-now a[href="/events/shell-hidden-event"]').count()) === 0, "unpublished events stay off the rail");
  // Seeded sample openings can fall sooner than this suite's, depending on the day.
  const [nextOpening] = await sql`select title from shift_openings where published and date >= (now() at time zone 'America/Vancouver')::date order by date, slot limit 1`;
  ok(nextOpening && (await page.locator("#volunteer").textContent()).includes(nextOpening.title), `Next up shows the next published shift opening (${nextOpening?.title})`);
  ok((await page.locator('#volunteer a[href="/volunteer"]').count()) === 1, "the shift card links to /volunteer");
  const strip = page.locator(".tracker-strip li").first();
  ok((await strip.textContent()).includes(promise7.title) && (await strip.locator(".status-stamp svg").count()) === 1, "latest tracker update is listed with an icon status stamp");
  ok((await strip.locator(".status-stamp").textContent()).trim() === "Broken", "the stamp names the status in words");
  // Every existing anchor is still on the page.
  for (const id of ["top", "stand", "news", "join", "newsletter", "stop", "pledge", "donate", "skytrain", "organize", "about", "committees", "events", "shop", "social", "act-now", "volunteer"])
    ok((await page.locator(`[id="${id}"]`).count()) === 1, `#${id} exists`);
  const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').first().textContent());
  ok(ld["@type"] === "Organization" && ld.sameAs.length > 0 && ld.url === BASE, "JSON-LD Organization with sameAs");
  ok((await page.locator('meta[property="og:image"]').getAttribute("content")).includes("/opengraph-image"), "pages share the generated card");
  ok((await ctx.cookies()).every((c) => c.name !== "is_area"), "the home page sets no area cookie");
  await ctx.close();
}

// ── /stats is retired ──────────────────────────────────────────────────────
{
  const r = await fetch(BASE + "/stats", { redirect: "manual" });
  ok((r.status === 301 || r.status === 308) && new URL(r.headers.get("location"), BASE).pathname === "/", `/stats redirects permanently to the home page (${r.status} → ${r.headers.get("location")})`);
  ok((await fetch(BASE + "/api/stats")).status === 404, "/api/stats is gone");
  ok((await fetch(BASE + "/api/campaigns/skytrain-south-surrey/count")).status === 404, "the public campaign count endpoint is gone");
}

// ── Skip link, header and menu ─────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/news");
  await page.keyboard.press("Tab");
  ok(await page.evaluate(() => document.activeElement?.classList.contains("skip-link")), "the skip link is the first focusable element");
  await page.keyboard.press("Enter");
  ok(await page.evaluate(() => document.activeElement?.id === "main" && document.activeElement.tagName === "MAIN"), "the skip link focuses <main>");
  ok((await page.locator('header a[href="/news"]').getAttribute("aria-current")) === "page", "the current section is marked aria-current");
  ok((await page.locator('header a[href="/tracker"]').getAttribute("aria-current")) === null, "other links are not");
  await page.close();

  // The title bar stays plain at every width: the logo, Donate and Menu.
  for (const w of [1440, 1280, 1200, 400]) {
    const p = await browser.newPage({ viewport: { width: w, height: 800 } });
    await p.goto(BASE + "/");
    const bar = await p.locator(".nav-bar > *").evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.textContent.trim()));
    const h = await p.locator(".site-header").evaluate((e) => e.getBoundingClientRect().height);
    ok(bar.length === 2 && bar[0] === "Donate" && bar[1].endsWith("Menu") && h < 110, `title bar is just the logo, Donate and Menu at ${w}px (${bar.join(" | ")}; ${Math.round(h)}px tall)`);
    ok(!(await p.locator("#nav-links").isVisible()), `the full navigation waits behind Menu at ${w}px`);
    await p.close();
  }

  const mobile = await browser.newPage({ viewport: { width: 400, height: 800 } });
  await mobile.goto(BASE + "/");
  const toggle = mobile.locator(".menu-toggle");
  ok(!(await mobile.locator(".nav-signin").isVisible()), "on a phone, sign-in waits in the menu");
  ok((await toggle.getAttribute("aria-expanded")) === "false" && (await toggle.getAttribute("aria-controls")) === "nav-links", "menu button starts collapsed and controls the menu");
  await toggle.click();
  ok((await toggle.getAttribute("aria-expanded")) === "true" && (await mobile.locator("#nav-links").isVisible()), "menu opens");
  ok((await mobile.locator('#nav-links a[href="/me"]').isVisible()) && (await mobile.locator('#nav-links a[href="/tracker"]').isVisible()), "the menu holds Supporter sign-in and every section");
  await mobile.keyboard.press("Escape");
  ok((await toggle.getAttribute("aria-expanded")) === "false" && !(await mobile.locator("#nav-links").isVisible()), "Escape closes the menu");
  ok(await mobile.evaluate(() => document.activeElement?.classList.contains("menu-toggle")), "focus returns to the menu button");
  await toggle.click();
  await mobile.locator('#nav-links a[href="/news"]').click();
  await mobile.waitForURL(BASE + "/news");
  ok((await toggle.getAttribute("aria-expanded")) === "false", "the menu closes on navigation");
  ok((await mobile.locator(".sticky-actions a").count()) === 3 && (await mobile.locator(".sticky-actions").isVisible()), "the Act / Join / Give bar shows on a phone");
  await mobile.goto(BASE + "/admin/login");
  ok((await mobile.locator(".sticky-actions").count()) === 0, "the action bar is hidden in the admin");
  await mobile.close();
}

// ── Rotating words can be paused ───────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/");
  const btn = page.locator(".rotate-toggle");
  ok((await btn.getAttribute("aria-pressed")) === "false" && (await btn.getAttribute("aria-label")) === "Pause the rotating words", "pause button starts unpressed, with a name");
  const box = await btn.boundingBox();
  ok(box.width >= 24 && box.height >= 24, "pause button is at least 24px");
  await btn.click();
  ok((await btn.getAttribute("aria-pressed")) === "true", "pausing sets aria-pressed");
  const word = await page.locator(".hero-word").textContent();
  await page.waitForTimeout(3200);
  ok((await page.locator(".hero-word").textContent()) === word, "the word stays put while paused");
  ok((await page.locator(".hero-word-wrap").getAttribute("aria-live")) === "off", "the rotating word is not announced");
  await btn.click();
  ok((await btn.getAttribute("aria-pressed")) === "false", "playing again clears aria-pressed");
  await page.close();
  const still = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await still.goto(BASE + "/");
  const first = await still.locator(".hero-word").textContent();
  await still.waitForTimeout(3000);
  ok((await still.locator(".hero-word").textContent()) === first, "no rotation under reduced motion");
  await still.close();
}

// ── 404, SEO files ─────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  const res = await page.goto(BASE + "/this-page-does-not-exist");
  ok(res.status() === 404 && (await page.locator("h1").textContent()).includes("Page not found"), "unknown pages get the 404 page");
  ok((await page.locator('main a[href="/tracker"]').count()) >= 1 && (await page.locator('main a[href="/act"]').count()) >= 1, "the 404 page links to the main sections");
  await page.close();

  const sitemap = await (await fetch(BASE + "/sitemap.xml")).text();
  ok(sitemap.includes(`<loc>${BASE}/tracker</loc>`), "sitemap lists /tracker");
  ok(sitemap.includes(`<loc>${BASE}/act/skytrain-south-surrey</loc>`), "sitemap lists /act/skytrain-south-surrey");
  ok(sitemap.includes(`<loc>${BASE}/news/shell-news-post</loc>`) && sitemap.includes(`<loc>${BASE}/events/shell-rail-meetup</loc>`), "sitemap lists published news and upcoming events");
  ok(!sitemap.includes("shell-hidden-event"), "sitemap leaves out unpublished events");
  ok(!sitemap.includes("/stats"), "sitemap leaves out the retired /stats page");

  const robots = await (await fetch(BASE + "/robots.txt")).text();
  ok(/Disallow: \/admin\b/.test(robots) && /Disallow: \/api\b/.test(robots) && robots.includes(`Sitemap: ${BASE}/sitemap.xml`), "robots.txt disallows /admin and /api and names the sitemap");

  const manifestRes = await fetch(BASE + "/manifest.webmanifest");
  let manifest = null;
  try {
    manifest = await manifestRes.json();
  } catch {}
  ok(manifest?.theme_color === "#003979" && manifest.display === "standalone" && manifest.icons.some((i) => i.src === "/icons/icon.svg" && i.sizes === "any"), "manifest JSON parses with theme colour and SVG icon");
  ok((await fetch(BASE + "/icons/icon.svg")).headers.get("content-type")?.includes("image/svg+xml"), "the manifest icon is served");

  const og = await fetch(BASE + "/opengraph-image");
  const bytes = new Uint8Array(await og.arrayBuffer());
  ok(og.headers.get("content-type") === "image/png" && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, "/opengraph-image returns a PNG");
}

// ── News pages ─────────────────────────────────────────────────────────────
{
  const page = await browser.newPage();
  await page.goto(BASE + "/news/shell-news-post");
  ok((await page.title()).startsWith("Shell news post"), "news post title in <title>");
  ok((await page.locator('meta[property="og:type"]').getAttribute("content")) === "article", "news post is shared as an article");
  ok((await page.locator(".prose strong").textContent()) === "bold", "news body is rendered from Markdown");
  const wa = await page.locator('.share-row a:has-text("WhatsApp")').getAttribute("href");
  ok(wa.startsWith("https://wa.me/?text=") && wa.includes(encodeURIComponent(`${BASE}/news/shell-news-post`)), "share row links WhatsApp to the post");
  ok((await page.locator(".share-row a, .share-row button").count()) === 6, "share row has WhatsApp, text, X, Facebook, email and copy");
  await page.close();
}

// ── Phone width: no sideways scroll ────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  for (const path of ["/", "/accessibility", "/news", "/news/shell-news-post", "/this-page-does-not-exist"]) {
    await page.goto(BASE + path);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    ok(sw <= iw, `no horizontal scroll at 360px on ${path} (${sw} ≤ ${iw})`);
  }
  await page.close();
}

// ── Structural accessibility checks ────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const path of ["/", "/accessibility", "/news"]) {
    await page.goto(BASE + path);
    const r = await page.evaluate(() => {
      const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !el.closest('[aria-hidden="true"]');
      const textOf = (id) => (id ? id.split(/\s+/).map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim() : "");
      const name = (el) => (el.getAttribute("aria-label") || textOf(el.getAttribute("aria-labelledby")) || el.textContent || el.getAttribute("title") || "").trim();
      const fields = [...document.querySelectorAll("input, select, textarea")].filter((el) => el.type !== "hidden" && !el.closest('[aria-hidden="true"]'));
      return {
        h1: document.querySelectorAll("h1").length,
        main: document.querySelectorAll("main, [role=main]").length,
        imgNoAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).map((i) => i.src),
        unnamedButtons: [...document.querySelectorAll("button, [role=button]")].filter(visible).filter((b) => !name(b)).map((b) => b.outerHTML.slice(0, 80)),
        unlabelled: fields.filter((f) => !(f.labels?.length || f.getAttribute("aria-label") || f.getAttribute("aria-labelledby"))).map((f) => f.name || f.id),
        unnamedLinks: [...document.querySelectorAll("a[href]")].filter(visible).filter((a) => !name(a) && !a.querySelector("img[alt]:not([alt=''])")).map((a) => a.href),
        landmarks: { banner: document.querySelectorAll("header.site-header").length, nav: document.querySelectorAll('nav[aria-label="Main"]').length, footer: document.querySelectorAll("footer").length },
        lang: document.documentElement.lang,
      };
    });
    ok(r.h1 === 1, `${path}: exactly one h1 (${r.h1})`);
    ok(r.main === 1, `${path}: one main landmark`);
    ok(r.imgNoAlt.length === 0, `${path}: every img has alt ${r.imgNoAlt.join(" ")}`);
    ok(r.unnamedButtons.length === 0, `${path}: every button has an accessible name ${r.unnamedButtons.join(" ")}`);
    ok(r.unlabelled.length === 0, `${path}: every input has a label ${r.unlabelled.join(" ")}`);
    ok(r.unnamedLinks.length === 0, `${path}: every link has a name ${r.unnamedLinks.join(" ")}`);
    ok(r.landmarks.banner === 1 && r.landmarks.nav === 1 && r.landmarks.footer === 1 && r.lang === "en", `${path}: header, main nav, footer and lang="en"`);
  }
  await page.goto(BASE + "/accessibility");
  ok((await page.locator("main").textContent()).includes("WCAG") && (await page.locator('main a[href^="mailto:"]').count()) >= 1, "the accessibility statement names WCAG and how to report a problem");
  ok((await page.locator('footer a[href="/accessibility"]').count()) === 1 && (await page.locator('footer a[href="/privacy"]').count()) === 1, "the footer links to accessibility and privacy");
  for (const href of ["/act", "/me", "/preferences", "/volunteer"]) ok((await page.locator(`footer a[href="${href}"]`).count()) === 1, `the footer links to ${href}`);
  ok((await page.locator('footer a[href="/stats"]').count()) === 0, "the footer no longer links to /stats");
  await page.close();
}

await browser.close();
await sql`delete from tracker_updates where note = 'Shell suite update'`;
await finish();

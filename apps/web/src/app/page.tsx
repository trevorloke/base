import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { DonateWidget } from "@/components/forms/DonateWidget";
import { MembershipForm } from "@/components/forms/MembershipForm";
import { NewsletterForm } from "@/components/forms/NewsletterForm";
import { SignatureForm } from "@/components/forms/SignatureForm";
import { PillarIcon, PlusIcon, SkyTrainMap, StopDougSign } from "@/components/Icons";
import { RotatingWord } from "@/components/RotatingWord";
import { Markdown } from "@/components/shell/Markdown";
import { SiteImage } from "@/components/shell/SiteImage";
import { SmartLink } from "@/components/shell/SmartLink";
import { StatusStamp } from "@/components/shell/StatusStamp";
import { dayAndMonth, formatDate, timeOnly } from "@/lib/dates";
import { normalizeModules, type BuiltInKind, type HomeModule } from "@/lib/home-modules";
import { formatCents } from "@/lib/money";
import { NEIGHBOURHOODS } from "@/lib/neighbourhoods";
import { activeProducts, latestNews, upcomingEvents } from "@/lib/server/content";
import { homeLive, shellSettings, type HomeLive } from "@/lib/server/home";
import { formatDay, SLOTS } from "@/lib/shifts";
import { buildingWithoutDatabase } from "@/lib/server/render-time";

export const revalidate = 3600;

/** "Anne Blunt" → "AB"; placeholders such as "[Name to confirm]" get none. */
function initials(name: string): string | null {
  if (!/^\p{L}[\p{L}'’.-]*(\s+\p{L}[\p{L}'’.-]*)*$/u.test(name.trim())) return null;
  const words = name.trim().split(/\s+/);
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
}

const isoDateLabel = (iso: string) => {
  const { weekday, date } = formatDay(iso);
  return `${weekday}, ${date}`;
};

export default async function Home() {
  const [settings, live, news, events, products] = await Promise.all([
    shellSettings(),
    homeLive().catch((err) => {
      if (!buildingWithoutDatabase()) console.error("The home page rail could not be loaded", err);
      return null;
    }),
    latestNews(3),
    upcomingEvents(3),
    activeProducts(),
  ]);
  const { org, hero, pillars, membership, stop, donate, skytrain, organize, board, committees, socials } = settings;
  const [nextEvent, ...moreEvents] = events;

  // Each built-in module, ready to place; Admin → Home page decides which
  // show and in what order (settings.homeModules).
  const blocks: Record<BuiltInKind, ReactNode> = {
    // ── Hero ──
    hero: (
      <>
      <section id="top" className="section section--navy hero">
        <div className="container hero-inner">
          <div className="hero-copy">
            <RotatingWord prefix={hero.titlePrefix} words={hero.words} />
            <Markdown text={hero.text} className="hero-text" />
            <div className="btn-row" style={{ marginTop: 8 }}>
              <SmartLink href={hero.primaryCta.href} className="btn btn--yellow btn--lg">
                {hero.primaryCta.label}
              </SmartLink>
              {hero.secondaryCtas.map((cta) => (
                <SmartLink key={cta.href + cta.label} href={cta.href} className="btn btn--ghost btn--lg">
                  {cta.label}
                </SmartLink>
              ))}
            </div>
          </div>
          {hero.image.url && (
            <SiteImage src={hero.image.url} alt={hero.image.alt} width={1600} height={1200} priority sizes="(max-width: 1000px) 100vw, 400px" className="hero-image" />
          )}
        </div>
      </section>
      </>
    ),
    // ── Act now ──
    actNow: (
      <>
      {live && <ActNow live={live} />}
      </>
    ),
    // ── What we stand for ──
    pillars: (
      <>
      <section id="stand" className="section">
        <div className="container stack" style={{ gap: 40 }}>
          <div className="intro">
            <h2 className="display pop">{pillars.title}</h2>
            <Markdown text={pillars.intro} className="lede" />
          </div>
          <div className="pillars">
            {pillars.items.map((p) => (
              <div key={p.title} className="pillar">
                <div className="pillar-head">
                  <div className="pillar-icon">
                    <PillarIcon name={p.icon} />
                  </div>
                  <h3>{p.title}</h3>
                </div>
                <Markdown text={p.body} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "14px 24px" }}>
            {org.platformUrl && (
              <SmartLink href={org.platformUrl} className="btn btn--outline">
                {org.platformLabel}
              </SmartLink>
            )}
            {pillars.ctaText && (
              <a href="#join" className="text-link">
                {pillars.ctaText}
              </a>
            )}
          </div>
        </div>
      </section>
      </>
    ),
    // ── News ──
    news: (
      <>
      <section id="news" className="section" style={{ paddingTop: 0 }}>
        <div className="container stack" style={{ gap: 32, paddingTop: 72, borderTop: "1px solid var(--line)" }}>
          <div className="section-head">
            <h2 className="display pop">Latest news</h2>
            <Link href="/news" className="text-link">
              All news
            </Link>
          </div>
          {news.length === 0 ? (
            <p className="empty-state">News releases will appear here. Sign up for the newsletter below to hear first.</p>
          ) : (
            <div className="card-grid">
              {news.map((post) => (
                <article key={post.id} className="card">
                  <p className="eyebrow">{formatDate(post.publishedAt!)}</p>
                  <h3 className="h3">{post.title}</h3>
                  <p>{post.summary}</p>
                  <Link href={`/news/${post.slug}`} className="text-link" style={{ fontSize: 15 }}>
                    Read more<span className="visually-hidden">: {post.title}</span>
                  </Link>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
      </>
    ),
    // ── Become a member ──
    join: (
      <>
      <section id="join" className="section section--surface">
        <div className="container stack" style={{ gap: 48 }}>
          {membership.photo.url && (
            <SiteImage src={membership.photo.url} alt={membership.photo.alt} width={1024} height={458} sizes="(max-width: 1168px) 100vw, 1120px" className="join-photo" />
          )}
          <div className="split">
            <div className="stack" style={{ flex: "1 1 320px", gap: 28 }}>
              <div className="stack" style={{ gap: 14 }}>
                <h2 className="display pop">{membership.title}</h2>
                <Markdown text={membership.intro} className="lede" />
              </div>
              <div className="stack" style={{ gap: 20 }}>
                {membership.benefits.map((b) => (
                  <div key={b.title} className="stack" style={{ gap: 6 }}>
                    <div className="bar" />
                    <h3 style={{ margin: "6px 0 0", fontWeight: 700, fontSize: 20, lineHeight: 1.25, color: "var(--navy)" }}>{b.title}</h3>
                    <Markdown text={b.body} className="benefit-body" />
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: "1 1 460px" }}>
              <MembershipForm />
            </div>
          </div>
          <div id="newsletter" className="newsletter-bar">
            <div className="copy">
              <label htmlFor="nl-email">{membership.newsletterTitle}</label>
              <p className="small">{membership.newsletterText}</p>
            </div>
            <NewsletterForm source="home" />
          </div>
        </div>
      </section>
      </>
    ),
    // ── Stop McCallum's chaos ──
    pledge: (
      <>
      <section id="stop" className="section section--navy on-dark">
        <div className="container stack" style={{ gap: 40 }}>
          <div className="stop-head">
            <StopDougSign />
            <div className="stack" style={{ flex: "1 1 480px", minWidth: 0, gap: 14 }}>
              <h2 className="display pop">{stop.title}</h2>
              <Markdown text={stop.intro} className="lede" />
            </div>
          </div>
          <div className="features">
            {stop.items.map((item) => (
              <article key={item.title} className="feature">
                <div className="bar bar--red" />
                <h3>{item.title}</h3>
                <Markdown text={item.body} />
              </article>
            ))}
          </div>
          <div id="pledge" className="pledge">
            <div className="pledge-copy">
              <p className="eyebrow eyebrow--yellow">{stop.pledgeEyebrow}</p>
              <h3>{stop.pledgeTitle}</h3>
              <blockquote>{stop.pledgeText}</blockquote>
            </div>
            <SignatureForm campaign="stop-mccallum-pledge" variant="pledge" />
          </div>
          <div className="btn-row">
            <a href="#join" className="btn btn--yellow btn--lg">
              Help stop it: become a member
            </a>
            <Link href="/donate" className="btn btn--ghost btn--lg">
              Chip in
            </Link>
            <Link href="/volunteer" className="btn btn--ghost btn--lg">
              Volunteer
            </Link>
            <Link href="/shop" className="btn btn--ghost btn--lg">
              Get the merch
            </Link>
            <Link href="/tracker" className="btn btn--ghost btn--lg">
              Track their promises
            </Link>
          </div>
        </div>
      </section>
      </>
    ),
    // ── Chip in ──
    donate: (
      <>
      <section id="donate" className="section">
        <div className="container split">
          <div className="stack" style={{ flex: "1 1 320px", gap: 16 }}>
            <h2 className="display pop">{donate.title}</h2>
            <Markdown text={donate.intro} className="lede" />
            <Markdown text={donate.text} className="body" />
          </div>
          <DonateWidget />
        </div>
      </section>
      </>
    ),
    // ── SkyTrain ──
    skytrain: (
      <>
      <section id="skytrain" className="section--navy-dark skytrain on-dark">
        <div className="skytrain-hero" style={skytrain.image.url ? { backgroundImage: `url(${JSON.stringify(skytrain.image.url)})` } : undefined}>
          <div className="container">
            <h2 className="display pop">
              {skytrain.title} {skytrain.highlight && <span className="hl">{skytrain.highlight}</span>}
            </h2>
            <p className="skytrain-claim">
              {skytrain.claim} {skytrain.claimHighlight && <span className="hl">{skytrain.claimHighlight}</span>}
            </p>
            {skytrain.callout && (
              <p className="skytrain-callout">
                {skytrain.callout} {skytrain.calloutHighlight && <span className="hl">{skytrain.calloutHighlight}</span>}
              </p>
            )}
          </div>
        </div>
        <div className="container split skytrain-body">
          <div className="map-card">
            <p className="map-title">Imagine Surrey SkyTrain proposal</p>
            <SkyTrainMap />
            <div className="map-legend">
              <span>
                <span aria-hidden="true" className="swatch" style={{ background: "var(--navy)" }} />
                SkyTrain today
              </span>
              <span>
                <span aria-hidden="true" className="swatch" style={{ background: "var(--field-border)" }} />
                Surrey Langley SkyTrain
              </span>
              <span>
                <span aria-hidden="true" className="swatch" style={{ background: "repeating-linear-gradient(90deg, #EF2023 0 6px, transparent 6px 11px)" }} />
                The extension to South Surrey
              </span>
            </div>
          </div>
          <div style={{ flex: "1 1 420px" }}>
            <SignatureForm campaign="skytrain-south-surrey" variant="petition" />
          </div>
        </div>
        {skytrain.asks.length > 0 && (
          <div className="container stack" style={{ padding: "48px 24px 0", gap: 18 }}>
            <p style={{ margin: 0, fontSize: 18, fontWeight: 700, lineHeight: 1.4 }}>{skytrain.asksIntro}</p>
            <ol className="asks">
              {skytrain.asks.map((ask, i) => (
                <li key={ask}>
                  <span aria-hidden="true" className="num">
                    {i + 1}
                  </span>
                  <p>{ask}</p>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>
      </>
    ),
    // ── Organize ──
    organize: (
      <>
      <section id="organize" className="section section--yellow organize">
        <div className="container" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "32px 48px" }}>
          <h2 className="display pop">
            {organize.title} {organize.highlight && <span className="underline">{organize.highlight}</span>}
          </h2>
          <SmartLink href={organize.ctaHref} className="btn btn--navy btn--xl">
            {organize.ctaLabel}
          </SmartLink>
        </div>
      </section>
      </>
    ),
    // ── Board ──
    board: (
      <>
      <section id="about" className="section section--surface">
        <div className="container stack" style={{ gap: 36 }}>
          <div className="intro" style={{ maxWidth: 720 }}>
            <h2 className="display pop">{board.title}</h2>
            <Markdown text={board.intro} className="lede" />
          </div>
          <div className="board-grid">
            {board.seats.map((seat, i) => {
              const name = seat.name.trim();
              const letters = name ? initials(name) : null;
              return (
                <article key={i} className="card card--white">
                  {seat.photo?.url ? (
                    <SiteImage src={seat.photo.url} alt={seat.photo.alt || ""} width={96} height={96} sizes="96px" className="avatar avatar--photo" />
                  ) : letters ? (
                    <div aria-hidden="true" className="avatar">
                      {letters}
                    </div>
                  ) : (
                    <div aria-hidden="true" className="avatar avatar--open">
                      <PlusIcon />
                    </div>
                  )}
                  <p className="eyebrow" style={{ marginTop: 10 }}>
                    {seat.role}
                  </p>
                  <h3 className="h3">{name || "Seat open"}</h3>
                  {seat.bio && <Markdown text={seat.bio} className="seat-bio" />}
                  {!name && (
                    <a href="#join" className="text-link" style={{ fontSize: 15 }}>
                      Put your name forward<span className="visually-hidden">: {seat.role}</span>
                    </a>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </section>
      </>
    ),
    // ── Committees ──
    committees: (
      <>
      <section id="committees" className="section">
        <div className="container stack" style={{ gap: 44 }}>
          <div className="intro" style={{ maxWidth: 720 }}>
            <h2 className="display pop">{committees.title}</h2>
            <Markdown text={committees.intro} className="lede" />
          </div>
          <div className="features" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))" }}>
            {committees.items.map((c) => (
              <article key={c.title} className="feature">
                <div className="bar" />
                <h3>{c.title}</h3>
                <Markdown text={c.body} />
              </article>
            ))}
          </div>
          <div className="stack" style={{ gap: 16 }}>
            <h3 className="h3" style={{ fontSize: 24 }}>
              {committees.neighbourhoodsTitle}
            </h3>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: "var(--muted)" }}>{committees.neighbourhoodsIntro}</p>
            <div className="tile-grid">
              {NEIGHBOURHOODS.map((n) => (
                <a key={n} href="#join" className="tile">
                  {n}
                </a>
              ))}
            </div>
          </div>
          {committees.campuses.length > 0 && (
            <div className="stack" style={{ gap: 16 }}>
              <h3 className="h3" style={{ fontSize: 24 }}>
                {committees.campusTitle}
              </h3>
              <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: "var(--muted)" }}>{committees.campusIntro}</p>
              <div className="tile-grid">
                {committees.campuses.map((c) => (
                  <a key={c} href="#join" className="tile">
                    {c}
                  </a>
                ))}
              </div>
            </div>
          )}
          <a href="#join" className="text-link" style={{ alignSelf: "flex-start" }}>
            Be part of it by joining as a member
          </a>
        </div>
      </section>
      </>
    ),
    // ── Events ──
    events: (
      <>
      <section id="events" className="section section--red on-dark">
        <div className="container stack" style={{ gap: 28 }}>
          <div className="section-head">
            <div className="stack" style={{ gap: 10 }}>
              <p className="eyebrow" style={{ color: "#fff", fontSize: 14, letterSpacing: "0.14em" }}>
                Next event
              </p>
              <h2 className="display pop--navy">Come and meet us</h2>
            </div>
            <Link href="/events" className="text-link">
              All events
            </Link>
          </div>
          {nextEvent ? (
            <>
              <div className="event-feature">
                <div className="date-badge">
                  <span className="day">{dayAndMonth(nextEvent.startsAt).day}</span>
                  <span className="mon">{dayAndMonth(nextEvent.startsAt).mon}</span>
                </div>
                <div className="info">
                  <h3>{nextEvent.title}</h3>
                  <p className="event-when">
                    {timeOnly(nextEvent.startsAt)}, {nextEvent.location}
                  </p>
                  <p className="summary">{nextEvent.summary}</p>
                </div>
                <Link href={`/events/${nextEvent.slug}`} className="btn btn--yellow btn--lg" style={{ fontSize: 19, minHeight: 56, padding: "0 32px" }}>
                  RSVP<span className="visually-hidden"> for {nextEvent.title}</span>
                </Link>
              </div>
              {moreEvents.length > 0 && (
                <div className="event-list">
                  {moreEvents.map((ev) => (
                    <article key={ev.id} className="event-row">
                      <div className="date-badge date-badge--sm">
                        <span className="day">{dayAndMonth(ev.startsAt).day}</span>
                        <span className="mon">{dayAndMonth(ev.startsAt).mon}</span>
                      </div>
                      <div className="info">
                        <h3>{ev.title}</h3>
                        <p>
                          {timeOnly(ev.startsAt)}, {ev.location}
                        </p>
                      </div>
                      <Link href={`/events/${ev.slug}`} className="text-link" style={{ fontSize: 15, flex: "none" }}>
                        RSVP<span className="visually-hidden"> for {ev.title}</span>
                      </Link>
                    </article>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="event-feature">
              <div className="info">
                <h3>New events are on the way</h3>
                <p className="summary">Get the newsletter and we&apos;ll tell you as soon as the next one is booked.</p>
              </div>
              <a href="#newsletter" className="btn btn--yellow btn--lg">
                Get the newsletter
              </a>
            </div>
          )}
        </div>
      </section>
      </>
    ),
    // ── Shop ──
    shop: (
      <>
      <section id="shop" className="section section--surface">
        <div className="container stack" style={{ gap: 32 }}>
          <div className="section-head">
            <div className="intro" style={{ maxWidth: 720, gap: 12 }}>
              <h2 className="display pop">Get the merch</h2>
              <p className="lede">Lawn signs, shirts, and buttons. Pick something to see it and check out.</p>
            </div>
            <Link href="/shop" className="btn btn--red btn--lg">
              Shop and check out
            </Link>
          </div>
          <div className="products">
            {products.map((p) => (
              <Link key={p.id} href="/shop" className="product">
                <div className="product-tile" style={{ background: p.tileBackground, color: p.tileForeground }}>
                  {p.tileLabel}
                </div>
                <div className="product-meta">
                  <h3>{p.name}</h3>
                  <span className="price">{formatCents(p.priceCents)}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
      </>
    ),
    // ── Social ──
    social: (
      <>
      {socials.accounts.length > 0 && (
        <section id="social" className="section">
          <div className="container stack" style={{ gap: 32 }}>
            <div className="intro" style={{ maxWidth: 720, gap: 12 }}>
              <h2 className="display pop">Follow along</h2>
              <Markdown text={socials.intro} className="lede" />
            </div>
            <div className="social-grid">
              {socials.accounts.map((s) => (
                <article key={s.url} className="social-card">
                  <div className="head">
                    <h3>{s.name}</h3>
                    <span className="handle">{s.handle}</span>
                  </div>
                  <a href={s.url} className="btn btn--outline">
                    {s.cta}
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
      </>
    ),
  };
  const modules = normalizeModules(settings.homeModules.modules).filter((m) => m.enabled);

  return (
    <>
      {modules.map((m, i) =>
        m.kind === "custom" ? <CustomModule key={`custom-${i}`} module={m} index={i} /> : <Fragment key={m.kind}>{blocks[m.kind]}</Fragment>,
      )}
    </>
  );
}

/**
 * The rail under the hero: what's next and the latest from the tracker. It
 * shows no counts: the site publishes no supporter numbers (they stay in the
 * admin), so the rail is about the next thing to do.
 */
function ActNow({ live }: { live: HomeLive }) {
  const shiftSlot = live.nextShift ? SLOTS.find((s) => s.id === live.nextShift!.slot) : undefined;
  return (
    <section id="act-now" className="act-rail" aria-labelledby="act-now-title">
      <div className="container stack" style={{ gap: 28 }}>
        <div className="rail-head">
          <h2 id="act-now-title" className="rail-title">
            Act now
          </h2>
          <Link href="/neighbourhoods" className="area-link">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
              <circle cx="12" cy="9.5" r="2.5" />
            </svg>
            What&apos;s on near you
          </Link>
        </div>

        <div className="rail-grid">
          <div className="stack" style={{ gap: 14 }}>
            <h3 className="rail-subtitle">Next up</h3>
            <ul className="next-list" role="list">
              {live.nextEvents.map((ev) => {
                const when = new Date(ev.startsAt);
                const { day, mon } = dayAndMonth(when);
                return (
                  <li key={ev.slug} className="next-card">
                    <div className="date-badge date-badge--sm" aria-hidden="true">
                      <span className="day">{day}</span>
                      <span className="mon">{mon}</span>
                    </div>
                    <div className="next-info">
                      <p className="eyebrow">Event</p>
                      <Link href={`/events/${ev.slug}`} className="next-title">
                        {ev.title}
                      </Link>
                      <p className="next-meta">
                        {formatDate(when)}, {timeOnly(when)} · {ev.location}
                      </p>
                    </div>
                  </li>
                );
              })}
              <li id="volunteer" className="next-card">
                <div className="next-icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 11V7a2 2 0 0 1 4 0v4M11 10V5a2 2 0 0 1 4 0v6M15 10V7a2 2 0 0 1 4 0v6a7 7 0 0 1-7 7h-1a6 6 0 0 1-5.2-3L4 14a2 2 0 0 1 3.4-2" />
                  </svg>
                </div>
                <div className="next-info">
                  <p className="eyebrow">Volunteer</p>
                  {live.nextShift?.kind === "opening" ? (
                    <>
                      <Link href="/volunteer" className="next-title">
                        {live.nextShift.title}
                      </Link>
                      <p className="next-meta">
                        {isoDateLabel(live.nextShift.date)}, {shiftSlot?.label.toLowerCase()} ({shiftSlot?.hours})
                        {live.nextShift.location ? ` · ${live.nextShift.location}` : ""}
                      </p>
                    </>
                  ) : live.nextShift ? (
                    <>
                      <Link href="/volunteer" className="next-title">
                        Join the next volunteer shift
                      </Link>
                      <p className="next-meta">
                        {isoDateLabel(live.nextShift.date)}, {shiftSlot?.label.toLowerCase()} ({shiftSlot?.hours})
                      </p>
                    </>
                  ) : (
                    <>
                      <Link href="/volunteer" className="next-title">
                        Pick a volunteer shift
                      </Link>
                      <p className="next-meta">Door-knocking, phone banks and events, a few hours at a time.</p>
                    </>
                  )}
                </div>
              </li>
            </ul>
          </div>

          <div className="stack" style={{ gap: 14 }}>
            <h3 className="rail-subtitle">Latest from the tracker</h3>
            {live.trackerUpdates.length === 0 ? (
              <p className="next-meta">
                Every promise, scored in public. <Link href="/tracker">See the promise tracker</Link>.
              </p>
            ) : (
              <ul className="tracker-strip" role="list">
                {live.trackerUpdates.map((u, i) => (
                  <li key={`${u.number}-${u.date}-${i}`} className="tracker-item">
                    <StatusStamp status={u.status} />
                    <Link href={`/tracker#promise-${u.number}`} className="next-title">
                      <span className="visually-hidden">Promise </span>#{u.number}: {u.title}
                    </Link>
                    <p className="next-meta">{isoDateLabel(u.date)}</p>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/tracker" className="text-link">
              All promises
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

const TONE_CLASS: Record<HomeModule["tone"], string> = {
  white: "section",
  grey: "section section--surface",
  navy: "section section--navy on-dark",
  yellow: "section section--yellow",
};

/** A text block an organizer added in Admin → Home page. */
function CustomModule({ module: m, index }: { module: HomeModule; index: number }) {
  if (!m.heading && !m.body && !m.buttonLabel) return null;
  const headingId = `module-${index}-title`;
  return (
    <section className={`${TONE_CLASS[m.tone]} custom-module`} aria-labelledby={m.heading ? headingId : undefined}>
      <div className="container stack" style={{ gap: 20, maxWidth: 820 }}>
        {m.heading && (
          <h2 id={headingId} className="display">
            {m.heading}
          </h2>
        )}
        {m.body && <Markdown text={m.body} className="lede" />}
        {m.buttonLabel && m.buttonHref && (
          <div className="btn-row">
            <SmartLink href={m.buttonHref} className={`btn btn--lg ${m.tone === "navy" ? "btn--yellow" : "btn--red"}`}>
              {m.buttonLabel}
            </SmartLink>
          </div>
        )}
      </div>
    </section>
  );
}

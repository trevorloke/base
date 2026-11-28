// Website → Overview (/website): the campaign's site at a glance.
//   Is it live (its home page published), where it lives (the app's own
//   /site/ address; the campaign's own domain once it points here — saved
//   under Settings, or SITE_HOSTS on the server), the one yellow "View site".
//   Then: sign-ups from the site this week (by kind), pages (live, with
//   changes not on the site yet), news, petitions and pledges, and whether
//   online giving is set up (donate and join need it). One row for the
//   campaign's other websites ("Other websites · 2 live").
//   Before the tiles (WEB 3b): a line for each legal piece the site still
//   lacks — no one named on the Authorized by line, no privacy policy link —
//   each to its field in Settings → Who's behind the site, gone once set;
//   and a row for the look it wears ("Look · Evergreen"), to Theme.
// The 'site' area (managers by default; App.jsx guards the route, the
// server refuses everyone else).
import { Link, useOutletContext } from 'react-router-dom';
import { hasFeature } from '../brand.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { WebsiteTabs } from '../components/site/Bits.jsx';
import { useSite, plural } from '../components/site/useSite.js';
import { lookOf } from '@base-win/shared/site/theme';
import { GUIDE_STATE, useSiteGuide } from '../components/site/useSiteGuide.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-sites.css';
import { authorizedSet } from '@base-win/shared/site/authorized';
import { dayWords, useAuthorized } from '../components/Authorized.jsx';

const KIND_WORDS = {
  petition: ['petition signature', 'petition signatures'],
  pledge: ['pledge', 'pledges'],
  newsletter: ['newsletter sign-up', 'newsletter sign-ups'],
  volunteer: ['volunteer offer', 'volunteer offers'],
  rsvp: ['RSVP', 'RSVPs'],
  contact: ['message', 'messages'],
  join: ['membership form', 'membership forms'],
  donate: ['donation form', 'donation forms'],
};
// membership: the campaign has one (only then can there be membership forms).
const kindLine = (byKind = {}, membership = false) => Object.entries(byKind)
  .filter(([k]) => k !== 'join' || membership)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${n} ${(KIND_WORDS[k] || [k, k])[n === 1 ? 0 : 1]}`)
  .join(' · ');
const hostOf = (u) => String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');

// The website in other languages (TR): "Languages · ਪੰਜਾਬੀ 简体 繁體 on".
const LANG_LABELS = { pa: 'ਪੰਜਾਬੀ', 'zh-Hans': '简体', 'zh-Hant': '繁體' };

export default function WebsiteHome() {
  const { me } = useOutletContext() || {};
  const q = useSite();
  const vg = useSiteGuide();
  const d = q.data;
  const home = d?.pages?.find((p) => p.slug === 'home');
  const live = home?.status === 'published';
  const waiting = (d?.pages || []).filter((p) => p.changed && p.status === 'published');
  const drafts = (d?.pages || []).filter((p) => p.status !== 'published');
  const own = [...(d?.urls?.domains || []), ...(d?.urls?.hosts || [])];
  // Its own domain, once the server names it (BASE_SITE_DOMAIN): /site/ sends people there.
  const domain = d?.urls?.domain || null;
  const view = domain || d?.urls?.site;
  const here = domain ? hostOf(domain) : typeof window !== 'undefined' ? `${window.location.host}${d?.urls?.site || '/site/'}` : d?.urls?.site;
  const c = d?.counts || {};
  const org = d?.settings?.org || {};
  // "Authorized by …" (components/Authorized.jsx): the soft row while it
  // isn't set; red, with its date, once the date it is needed from has come.
  const auth = useAuthorized().data;
  const authDue = auth?.warn?.level === 'due';
  const missing = [
    authorizedSet(org) !== 'set' && {
      key: 'auth', red: authDue,
      words: authDue ? `The Authorized by line is needed from ${dayWords(auth.warn.from)} and ${auth.warn.gap === 'missing' ? 'isn’t filled in' : 'has no way to reach your financial agent'}` : 'No one is named on the Authorized by line yet',
      to: '/website/settings#wb-s-agent', fix: 'Add who authorized the site',
    },
    !org.privacyUrl && { key: 'privacy', words: 'No privacy policy link yet', to: '/website/settings#wb-s-priv', fix: 'Add the link' },
  ].filter(Boolean);
  const theme = d?.settings?.theme || {};
  const lookName = theme.follow ? 'The campaign’s brand' : lookOf(theme.skin)?.label || 'Its own';
  return (
    <div className="wb-page">
      <div className="ops-head">
        <h1>Website</h1>
        {d && (
          <a className="btn btn-primary ops-tap" href={view} target="_blank" rel="noopener">
            View site<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span>
          </a>
        )}
      </div>
      <WebsiteTabs />

      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}

      {d && (
        <>
          <section className="card wb-live" data-live={live ? '' : undefined} aria-labelledby="wb-live-h">
            <h2 id="wb-live-h" className="wb-live__h">
              <span className="wb-dot" aria-hidden="true" />
              {live ? 'Your site is live' : 'Your site isn’t live yet'}
            </h2>
            <p className="wb-live__line">
              {live ? 'Anyone can see it at ' : 'When its home page is published, it shows at '}
              <a href={view} target="_blank" rel="noopener" className="wb-addr">{here}<span className="ws-sr"> (opens a new tab)</span></a>
              {domain ? ', its own domain.' : own.length > 0 ? ' — base.win’s own address for it.' : '.'}
            </p>
            {domain ? null : own.length > 0 ? (
              <p className="wb-live__line">
                Your own domain: {own.map((u, i) => (
                  <span key={u}>{i > 0 && ', '}<a className="wb-addr" href={u} target="_blank" rel="noopener">{hostOf(u)}<span className="ws-sr"> (opens a new tab)</span></a></span>
                ))}{' '}— once its DNS points at this server, the site answers there.
              </p>
            ) : (
              <p className="wb-live__line muted">
                Using your own domain (like yourcampaign.ca)? Add it under <Link to="/website/settings#domains">Settings</Link>.
              </p>
            )}
            {waiting.length > 0 && (
              <p className="wb-live__line wb-warn">
                {plural(waiting.length, 'page has', 'pages have')} changes that aren’t on the site yet:{' '}
                {waiting.map((p, i) => <span key={p.id}>{i > 0 && ', '}<Link to={`/website/pages/${p.id}`}>{p.title}</Link></span>)}.
              </p>
            )}
          </section>

          {missing.length > 0 && (
            <section className="card wb-todo" aria-labelledby="wb-todo-h">
              <h2 id="wb-todo-h" className="wb-todo__h">Before you share the site</h2>
              <ul className="wb-todo__list">
                {missing.map((m) => (
                  <li key={m.key} className={`wb-todo__item${m.red ? ' wb-todo__item--red' : ''}`} data-todo={m.key}>
                    <span>{m.words}.</span> <Link to={m.to}>{m.fix}</Link>
                  </li>
                ))}
              </ul>
              <p className="wb-tile__sub muted">Once they are filled in, base.win puts them on every page of the site.</p>
            </section>
          )}

          <Link className="card ms-home-row" to="/website/theme">
            <span className="ms-home-row__name">Look</span>
            <span className="ms-home-row__n">{lookName}</span>
            <span aria-hidden="true">›</span>
          </Link>

          <Link className="card ms-home-row" to="/website/sites">
            <span className="ms-home-row__name">Other websites</span>
            <span className="ms-home-row__n">{c.microsites ? `${c.microsites_live ?? 0} live${c.microsites > (c.microsites_live ?? 0) ? ` · ${plural(c.microsites - (c.microsites_live ?? 0), 'draft')}` : ''}` : 'None yet'}</span>
            <span aria-hidden="true">›</span>
          </Link>

          <Link className="card ms-home-row" to="/website/languages">
            <span className="ms-home-row__name">Languages</span>
            <span className="ms-home-row__n">{(d.settings?.languages?.on || []).length
              ? <>{d.settings.languages.on.map((c) => <span key={c} lang={c}>{LANG_LABELS[c]} </span>)}on</>
              : 'English only'}</span>
            <span aria-hidden="true">›</span>
          </Link>

          <Link className="card ms-home-row" to="/website/guide">
            <span className="ms-home-row__name">Voter guide</span>
            <span className="ms-home-row__n">{vg.data ? GUIDE_STATE[vg.data.state] : vg.isError ? 'Unavailable' : 'Loading…'}</span>
            <span aria-hidden="true">›</span>
          </Link>

          <div className="wb-tiles">
            <section className="wb-tile" aria-labelledby="wb-t-week">
              <h2 id="wb-t-week" className="wb-tile__h">Sign-ups this week</h2>
              <p className="wb-tile__n">{c.actions_week ?? 0}</p>
              <p className="wb-tile__sub">{c.actions_week ? kindLine(c.actions_week_by_kind, hasFeature(me, 'membership')) : 'Nothing from the site in the last 7 days.'}</p>
              <p className="wb-tile__sub muted">{plural(c.actions ?? 0, 'sign-up', 'sign-ups')} from the site in all.</p>
            </section>
            <section className="wb-tile" aria-labelledby="wb-t-pages">
              <h2 id="wb-t-pages" className="wb-tile__h">Pages</h2>
              <p className="wb-tile__n">{c.pages ?? 0}</p>
              <p className="wb-tile__sub">{c.published ?? 0} on the site{drafts.length ? ` · ${plural(drafts.length, 'draft')}` : ''}</p>
              {/* A typo on the home page: fixed and published in a few taps (WA). */}
              {(d.pages || []).some((p) => p.slug === 'home') && (
                <Link className="wb-tile__go" to={`/website/pages/${d.pages.find((p) => p.slug === 'home').id}`}>Edit the home page</Link>
              )}
              <Link className="wb-tile__go" to="/website/pages">Edit pages</Link>
            </section>
            <section className="wb-tile" aria-labelledby="wb-t-news">
              <h2 id="wb-t-news" className="wb-tile__h">News</h2>
              <p className="wb-tile__n">{c.posts ?? 0}</p>
              <p className="wb-tile__sub">{c.posts ? `${c.posts_published ?? 0} published` : 'No posts yet'}</p>
              <Link className="wb-tile__go" to="/website/news">Write news</Link>
            </section>
            <section className="wb-tile" aria-labelledby="wb-t-act">
              <h2 id="wb-t-act" className="wb-tile__h">Petitions and pledges</h2>
              <p className="wb-tile__n">{c.campaigns ?? 0}</p>
              <p className="wb-tile__sub">{c.campaigns ? `${c.campaigns_open ?? 0} open to sign` : 'None yet'}</p>
              <Link className="wb-tile__go" to="/website/petitions">See them</Link>
            </section>
            <section className="wb-tile" data-tone={d.payments?.ready ? 'ok' : 'warn'} aria-labelledby="wb-t-pay">
              <h2 id="wb-t-pay" className="wb-tile__h">Online giving</h2>
              <p className="wb-tile__state">{d.payments?.ready ? 'Set up' : 'Not set up yet'}</p>
              <p className="wb-tile__sub">
                {hasFeature(me, 'membership')
                  ? (d.payments?.ready
                    ? 'Donations and memberships on the site are paid by card, then land in Donations.'
                    : 'The site’s Donate and Become a member forms say online giving isn’t ready until it is.')
                  : (d.payments?.ready
                    ? 'Donations on the site are paid by card, then land in Donations.'
                    : 'The site’s Donate form says online giving isn’t ready until it is.')}
              </p>
              {!d.payments?.ready && me?.role === 'manager' && <Link className="wb-tile__go" to="/settings/services">Settings → Services</Link>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

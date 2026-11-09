// Website → Overview (/website): the campaign's site at a glance.
//   Is it live (its home page published), where it lives (the app's own
//   /site/ address; the campaign's own domain once it points here — saved
//   under Settings, or SITE_HOSTS on the server), the one yellow "View site".
//   Then: sign-ups from the site this week (by kind), pages (live, with
//   changes not on the site yet), news, petitions and pledges, and whether
//   online giving is set up (donate and join need it).
// The 'site' area (managers by default; App.jsx guards the route, the
// server refuses everyone else).
import { Link, useOutletContext } from 'react-router-dom';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { WebsiteTabs } from '../components/site/Bits.jsx';
import { useSite, plural } from '../components/site/useSite.js';
import './shifts.css';
import '../editor.css';
import './website.css';

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
const kindLine = (byKind = {}) => Object.entries(byKind)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${n} ${(KIND_WORDS[k] || [k, k])[n === 1 ? 0 : 1]}`)
  .join(' · ');
const hostOf = (u) => String(u).replace(/^https?:\/\//, '').replace(/\/$/, '');

export default function WebsiteHome() {
  const { me } = useOutletContext() || {};
  const q = useSite();
  const d = q.data;
  const home = d?.pages?.find((p) => p.slug === 'home');
  const live = home?.status === 'published';
  const waiting = (d?.pages || []).filter((p) => p.changed && p.status === 'published');
  const drafts = (d?.pages || []).filter((p) => p.status !== 'published');
  const own = [...(d?.urls?.domains || []), ...(d?.urls?.hosts || [])];
  const here = typeof window !== 'undefined' ? `${window.location.host}${d?.urls?.site || '/site/'}` : d?.urls?.site;
  const c = d?.counts || {};
  return (
    <div className="wb-page">
      <div className="ops-head">
        <h1>Website</h1>
        {d && (
          <a className="btn btn-primary ops-tap" href={d.urls.site} target="_blank" rel="noopener">
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
              <a href={d.urls.site} target="_blank" rel="noopener" className="wb-addr">{here}<span className="ws-sr"> (opens a new tab)</span></a>
              {own.length > 0 ? ' — base.win’s own address for it.' : '.'}
            </p>
            {own.length > 0 ? (
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

          <div className="wb-tiles">
            <section className="wb-tile" aria-labelledby="wb-t-week">
              <h2 id="wb-t-week" className="wb-tile__h">Sign-ups this week</h2>
              <p className="wb-tile__n">{c.actions_week ?? 0}</p>
              <p className="wb-tile__sub">{c.actions_week ? kindLine(c.actions_week_by_kind) : 'Nothing from the site in the last 7 days.'}</p>
              <p className="wb-tile__sub muted">{plural(c.actions ?? 0, 'sign-up', 'sign-ups')} from the site in all.</p>
            </section>
            <section className="wb-tile" aria-labelledby="wb-t-pages">
              <h2 id="wb-t-pages" className="wb-tile__h">Pages</h2>
              <p className="wb-tile__n">{c.pages ?? 0}</p>
              <p className="wb-tile__sub">{c.published ?? 0} on the site{drafts.length ? ` · ${plural(drafts.length, 'draft')}` : ''}</p>
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
                {d.payments?.ready
                  ? 'Donations and memberships on the site are paid by card, then land in Donations.'
                  : 'The site’s Donate and Become a member forms say online giving isn’t ready until it is.'}
              </p>
              {!d.payments?.ready && me?.role === 'manager' && <Link className="wb-tile__go" to="/settings/services">Settings → Services</Link>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

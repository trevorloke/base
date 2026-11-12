// Website → Other websites (/website/sites): the campaign's small
// one-purpose sites (a petition, a contrast site) on domains of their own,
// whose forms land in the same people database (SITE.md "Other websites").
//   Each row: its name, Live or Draft, its domain (or "No domain yet") and
//   this week's sign-ups. One yellow "New website" (managers: the server
//   refuses anyone else) opens a short form in place: a name and, if there
//   is one, the domain — checked as it's typed in the save's own words —
//   then "Make it" opens the new website.
//   A deleted website whose address still says "This website has closed"
//   is listed under "Closed websites", so a manager can bring it back or
//   release its address.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { WebsiteTabs } from '../components/site/Bits.jsx';
import { useMicrosites, useSiteRefresh, plural } from '../components/site/useSite.js';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-sites.css';

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const bareHost = (raw) => String(raw ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '')
  .replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
// The domain and its www. (Render adds the www. too).
export const bothHosts = (h) => [h, `www.${h}`];

// A typed address, checked as it's typed: the format here, then the
// server's own refusal (the app's addresses, the main site's, another
// website's…) a moment after the typing stops. → { host, why, checking }
export function useHostCheck(typed, siteId = null) {
  const [res, setRes] = useState({ host: '', why: null, checking: false });
  useEffect(() => {
    const h = bareHost(typed);
    if (!h) { setRes({ host: '', why: null, checking: false }); return undefined; }
    if (!HOST.test(h)) { setRes({ host: h, why: 'A web address, like yourcampaign.ca', checking: false }); return undefined; }
    setRes({ host: h, why: null, checking: true });
    let gone = false;
    const t = setTimeout(async () => {
      try {
        const r = await apiGet(`/site/microsites/host?host=${encodeURIComponent(h)}${siteId ? `&id=${siteId}` : ''}`);
        if (!gone) setRes({ host: h, why: r.why || null, checking: false });
      } catch {
        // No answer: the save checks it again.
        if (!gone) setRes({ host: h, why: null, checking: false });
      }
    }, 350);
    return () => { gone = true; clearTimeout(t); };
  }, [typed, siteId]);
  return res;
}

// "Unavailable — Try again": a read that failed, never an empty list.
export function Unavailable({ q }) {
  return (
    <p className="error ms-unavail" role="alert">
      Unavailable — <button type="button" className="btn btn-quiet ops-tap" onClick={() => q.refetch()}>Try again</button>
    </p>
  );
}

function NewWebsite({ onClose }) {
  const navigate = useNavigate();
  const refresh = useSiteRefresh();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const check = useHostCheck(domain);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Give it a name'); return; }
    if (check.why) return;
    setBusy(true);
    setError(null);
    try {
      const h = domain.trim() ? check.host : '';
      const res = await action('site.microsite.create', { name: name.trim(), domain: h || undefined });
      // And its www., which Render answers on too.
      if (h) await action('site.microsite.domains', { id: res.microsite.id, domains: bothHosts(h) }).catch(() => {});
      await refresh(['microsites'], ['site']);
      navigate(`/website/sites/${res.microsite.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="card wb-new ms-new" onSubmit={submit} aria-label="New website">
      <div className="field">
        <label htmlFor="ms-new-name">Name</label>
        <input id="ms-new-name" className="input" required autoFocus maxLength={60} autoComplete="off"
          placeholder="Doug Didn’t" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ms-new-domain">Web address (optional)</label>
        <input id="ms-new-domain" className="input" maxLength={300} autoComplete="off" spellCheck={false} inputMode="url"
          placeholder="yourcampaign.ca" value={domain} aria-invalid={check.why ? 'true' : undefined}
          aria-describedby="ms-new-domain-say" onChange={(e) => setDomain(e.target.value)} />
        <p className={check.why ? 'wb-field__err' : 'wb-field__hint'} id="ms-new-domain-say" aria-live="polite">
          {check.why || (check.host && !check.checking ? `It answers at ${check.host} and www.${check.host}.` : 'You can add it later.')}
        </p>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || Boolean(check.why) || check.checking}>{busy ? 'Making it…' : 'Make it'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

export function SiteChip({ m }) {
  if (m.deleted_at) return <span className="chip ops-chip-muted">Deleted</span>;
  return m.status === 'live' ? <span className="chip chip-ok">Live</span> : <span className="chip ops-chip-muted">Draft</span>;
}

export default function WebsiteSites() {
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1' && manager;
  const online = useOnline();
  const q = useMicrosites();
  const sites = q.data?.microsites || [];
  const full = q.data && sites.length >= (q.data.limit || 5);
  const empty = q.data && sites.length === 0;
  const open = () => setParams({ new: '1' });
  return (
    <div className="wb-page">
      <div className="ops-head">
        <h1>Other websites</h1>
        {manager && online && !showNew && q.data && !empty && !full && (
          <button type="button" className="btn btn-primary ops-tap" onClick={open}>New website</button>
        )}
      </div>
      <WebsiteTabs />
      <p className="wb-help">Small sites on their own domains — a petition, a contrast site. Every sign-up lands in People.</p>
      {showNew && <NewWebsite onClose={() => setParams({})} />}

      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <Unavailable q={q} />}

      {empty && !showNew && (
        <div className="card ms-empty">
          <p>No other websites yet.</p>
          {manager && online && <button type="button" className="btn btn-primary ops-tap" onClick={open}>New website</button>}
        </div>
      )}
      {full && manager && <p className="wb-help">Five other websites is the most — delete one first.</p>}

      {sites.length > 0 && (
        <ul className="wb-rows ms-rows" aria-label="Other websites">
          {sites.map((m) => (
            <li key={m.id} className="wb-row ms-row">
              <div className="wb-row__main">
                <span className="ms-row__top">
                  <Link className="wb-row__name" to={`/website/sites/${m.id}`}>{m.name}</Link>
                  <SiteChip m={m} />
                </span>
                <span className="wb-row__sub">
                  <span className="wb-row__addr">{m.domains[0] || 'No domain yet'}</span>
                  <span>{plural(m.signups_7, 'sign-up')} this week</span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {q.data?.closed?.length > 0 && (
        <section className="ms-closed" aria-labelledby="ms-closed-h">
          <h2 id="ms-closed-h" className="wb-card-h">Closed websites</h2>
          <ul className="wb-rows" aria-labelledby="ms-closed-h">
            {q.data.closed.map((m) => (
              <li key={m.id} className="wb-row ms-row">
                <div className="wb-row__main">
                  <span className="ms-row__top">
                    <Link className="wb-row__name" to={`/website/sites/${m.id}`}>{m.name}</Link>
                    <SiteChip m={m} />
                  </span>
                  <span className="wb-row__sub">
                    <span>{[...m.domains, ...m.held_domains].filter((d, i, a) => a.indexOf(d) === i)[0]} says “This website has closed”</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

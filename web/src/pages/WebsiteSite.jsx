// One of the campaign's other websites, at a glance (/website/sites/:siteId),
// and its domain (/website/sites/:siteId/domain). Its pages and look are
// today's screens with the website passed in (WebsitePages, WebsiteTheme).
//   Overview: its name and Live / Draft; the one yellow button — "Go live"
//   (a draft; a manager) or "View site" (live). While a draft, what going
//   live needs, each a tick or a link to fix it; "Go live" with something
//   missing says the server's words in place. Sign-ups for 7 or 30 days and
//   where they came from (counts, never people), then "See everyone from
//   this site" in People. Pages · Look · Domain. Under ⋯ (a manager):
//   Rename, Take offline, Delete (Undo in the toast) and, when an old
//   address still says "This website has closed", Release it.
//   Domain: the address (the www. is added), then the three steps in the
//   safe order — base.win first, then Render, then the registrar's DNS —
//   shown only once the address is saved, each with Copy.
// Managers decide everything but pages and looks; the server refuses
// anyone else, so for them those buttons aren't drawn.
import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { MoreMenu, Toast, useToast } from '../components/site/Bits.jsx';
import { useMicrosite, useSiteRefresh, plural } from '../components/site/useSite.js';
import { SiteChip, Unavailable, bothHosts, useHostCheck } from './WebsiteSites.jsx';
import './shifts.css';
import '../editor.css';
import './website.css';
import './website-sites.css';

const n = (x) => Number(x || 0).toLocaleString('en-CA');
const viewUrl = (d) => d.urls.domains[0] || d.urls.site;

// "← Doug Didn't" back to the website's overview (or the list).
export function SiteBack({ d, id, to }) {
  return to === 'list'
    ? <Link className="ops-back" to="/website/sites">← Other websites</Link>
    : <Link className="ops-back" to={`/website/sites/${id}`}>← {d?.microsite?.name || 'The website'}</Link>;
}

function Ask({ words, yes, onYes, onNo, busy }) {
  return (
    <div className="ms-ask" role="group" aria-label={words}>
      <span>{words}</span>
      <button type="button" className="btn ops-tap" disabled={busy} onClick={onYes}>{yes || 'Yes'}</button>
      <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onNo}>No</button>
    </div>
  );
}

const CHECK = {
  home: ['Home page published', (d) => (d.home ? `/website/pages/${d.home.id}` : `/website/sites/${d.microsite.id}/pages`)],
  authorized: ['Authorized by line', () => '/website/settings#org'],
  privacy: ['Privacy policy link', () => '/website/settings#org'],
};

export default function WebsiteSite() {
  const { siteId: id } = useParams();
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const online = useOnline();
  const q = useMicrosite(id);
  const refresh = useSiteRefresh();
  const { toast, say, clear } = useToast();
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [asking, setAsking] = useState(null); // 'offline' | 'delete' | 'release'
  const [renaming, setRenaming] = useState(null);
  const d = q.data;
  const m = d?.microsite;
  const deleted = Boolean(d?.deleted);
  const where = m ? m.domains[0] || m.name : '';
  const closedHosts = m ? [...new Set([...m.held_domains, ...(deleted ? m.domains : [])])] : [];

  const run = async (name, input, words) => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await action(name, input);
      if (words) say(typeof words === 'function' ? words(r) : words);
      await refresh(['microsite', id], ['microsites'], ['site']);
      return r;
    } catch (e) {
      setProblem(e.message);
      return null;
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };
  const restore = () => run('site.microsite.restore', { id }, (r) => `${r.microsite.name} is back, as a draft`);
  const remove = async () => {
    const ok = await run('site.microsite.delete', { id });
    if (ok) say(`Deleted ${m.name}`, { undo: restore });
  };
  const rename = async (e) => {
    e.preventDefault();
    const ok = await run('site.microsite.save', { id, name: renaming.trim() }, 'Renamed');
    if (ok) setRenaming(null);
  };

  let primary = null;
  if (d && deleted && manager) {
    primary = <button type="button" className="btn btn-primary ops-tap" disabled={!online || busy} onClick={restore}>Bring it back</button>;
  } else if (d && !deleted && m.status === 'live') {
    primary = (
      <a className="btn btn-primary ops-tap" href={viewUrl(d)} target="_blank" rel="noopener">
        View site<span aria-hidden="true"> ↗</span><span className="ws-sr"> (opens a new tab)</span>
      </a>
    );
  } else if (d && !deleted && manager) {
    primary = (
      <button type="button" className="btn btn-primary ops-tap" disabled={!online || busy}
        onClick={() => run('site.microsite.live', { id, live: true }, `${m.name} is live`)}>
        {busy ? 'Working…' : 'Go live'}
      </button>
    );
  }

  return (
    <div className="wb-page ms-page">
      <SiteBack to="list" />
      <div className="ops-head">
        <h1 className="ms-title">{m ? <>{m.name} <SiteChip m={{ ...m, deleted_at: deleted ? m.deleted_at : null }} /></> : 'Website'}</h1>
        {primary}
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && (q.error?.status === 404 ? <p className="error" role="alert">{q.error.message}</p> : <Unavailable q={q} />)}
      <p className="ms-problem" role="alert" aria-live="assertive">{problem || ''}</p>

      {d && renaming !== null && (
        <form className="card ms-rename" onSubmit={rename} aria-label="Rename">
          <div className="field">
            <label htmlFor="ms-rename">Name</label>
            <input id="ms-rename" className="input" autoFocus maxLength={60} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
          </div>
          <div className="ops-actions">
            <button type="submit" className="btn ops-tap" disabled={busy || !renaming.trim()}>Save the name</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setRenaming(null)}>Cancel</button>
          </div>
        </form>
      )}

      {d && deleted && (
        <section className="card ms-card">
          <p>This website is deleted.{closedHosts.length > 0 && ` ${closedHosts[0]} says “This website has closed” until a manager releases it.`}</p>
        </section>
      )}

      {d && !deleted && m.status !== 'live' && (
        <section className="card ms-card" aria-labelledby="ms-check-h">
          <h2 id="ms-check-h" className="wb-card-h">Before it goes live</h2>
          <ul className="ms-checks">
            {d.checklist.map((c) => {
              const [label, to] = CHECK[c.key] || [c.key, () => '#'];
              return (
                <li key={c.key} className="ms-check" data-done={c.done ? '' : undefined}>
                  <span className="ms-check__mark" aria-hidden="true">{c.done ? '✓' : '○'}</span>
                  {c.done ? <span>{label}<span className="ws-sr">: done</span></span> : <Link to={to(d)}>{label}<span className="ws-sr">: not yet — fix it</span></Link>}
                </li>
              );
            })}
            <li className="ms-check" data-done={m.domains.length ? '' : undefined}>
              <span className="ms-check__mark" aria-hidden="true">{m.domains.length ? '✓' : '○'}</span>
              {m.domains.length ? <span>Web address: {m.domains[0]}</span> : <Link to={`/website/sites/${id}/domain`}>Web address (optional)</Link>}
            </li>
          </ul>
          {!manager && <p className="wb-field__hint">A manager takes it live.</p>}
        </section>
      )}

      {d && (
        <section className="card ms-card" aria-labelledby="ms-su-h">
          <div className="ms-su__head">
            <h2 id="ms-su-h" className="wb-card-h">Sign-ups</h2>
            <div className="ops-seg ms-seg" role="group" aria-label="How far back">
              {[7, 30].map((x) => (
                <button key={x} type="button" aria-pressed={days === x} onClick={() => setDays(x)}>{x} days</button>
              ))}
            </div>
          </div>
          <p className="ms-su__n" aria-live="polite">{n(days === 7 ? d.signups_7 : d.signups_30)}<span className="ws-sr"> in the last {days} days</span></p>
          <h3 className="ms-su__h3">Where they came from <span className="muted">(30 days)</span></h3>
          {d.sources.length ? (
            <ul className="ms-sources">
              {d.sources.map((s) => (
                <li key={s.source}><span className="ms-sources__name">{s.source}</span><span className="ms-sources__n">{n(s.n)}</span></li>
              ))}
            </ul>
          ) : <p className="muted">No sign-ups yet.</p>}
          <Link className="ms-link" to={`/people?web=site:${id}`}>See everyone from this site</Link>
        </section>
      )}

      {d && !deleted && (
        <nav className="ms-links" aria-label={`${m.name}: its parts`}>
          <Link className="btn btn-quiet ops-tap" to={`/website/sites/${id}/pages`}>Pages</Link>
          <Link className="btn btn-quiet ops-tap" to={`/website/sites/${id}/look`}>Look</Link>
          <Link className="btn btn-quiet ops-tap" to={`/website/sites/${id}/domain`}>Domain</Link>
          {manager && (
            <MoreMenu label={`More for ${m.name}`} className="ms-more" items={[
              { label: 'Rename', onClick: () => setRenaming(m.name), disabled: !online || busy },
              m.status === 'live' && { label: 'Take offline', onClick: () => setAsking('offline'), disabled: !online || busy },
              closedHosts.length > 0 && { label: 'Release old address', onClick: () => setAsking('release'), disabled: !online || busy },
              { label: 'Delete', onClick: () => setAsking('delete'), danger: true, disabled: !online || busy },
            ]} />
          )}
        </nav>
      )}
      {d && deleted && manager && closedHosts.length > 0 && (
        <div className="ms-links">
          <MoreMenu label={`More for ${m.name}`} className="ms-more" items={[
            { label: 'Release old address', onClick: () => setAsking('release'), disabled: !online || busy },
          ]} />
        </div>
      )}

      {asking === 'offline' && (
        <Ask words={`Take ${where} offline?`} busy={busy} onNo={() => setAsking(null)}
          onYes={() => run('site.microsite.live', { id, live: false }, `${where} says “Coming soon”`)} />
      )}
      {asking === 'delete' && <Ask words="Delete this website?" busy={busy} onNo={() => setAsking(null)} onYes={remove} />}
      {asking === 'release' && (
        <>
          <p className="wb-field__hint">Remove it from Render first — once released, the address reaches base.win’s sign-in page.</p>
          <Ask words={`Release ${closedHosts.join(' and ')}?`} busy={busy} onNo={() => setAsking(null)}
            onYes={() => run('site.microsite.release', { id }, (r) => `Released ${r.released.join(' and ')}`)} />
        </>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}

function CopyLine({ text, label }) {
  const [said, setSaid] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setSaid('Copied'); } catch { setSaid('Select it and copy'); }
    setTimeout(() => setSaid(''), 3000);
  };
  return (
    <span className="ms-copy">
      <code>{text}</code>
      <button type="button" className="btn btn-quiet ops-tap" onClick={copy}>Copy<span className="ws-sr"> {label}</span></button>
      <span className="ms-copy__said" aria-live="polite">{said}</span>
    </span>
  );
}

export function WebsiteSiteDomain() {
  const { siteId: id } = useParams();
  const { me } = useOutletContext() || {};
  const manager = me?.role === 'manager';
  const online = useOnline();
  const q = useMicrosite(id);
  const refresh = useSiteRefresh();
  const { toast, say, clear } = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [asking, setAsking] = useState(false);
  const check = useHostCheck(typed, id);
  const d = q.data;
  const m = d?.microsite;
  const host = m?.domains?.find((h) => !h.startsWith('www.')) || m?.domains?.[0] || '';

  const save = async (domains, words) => {
    setBusy(true);
    setProblem(null);
    try {
      await action('site.microsite.domains', { id, domains });
      say(words);
      setTyped('');
      setAsking(false);
      await refresh(['microsite', id], ['microsites']);
    } catch (e) {
      setProblem(e.message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    if (!check.host || check.why || check.checking) return;
    save(bothHosts(check.host), `Saved — ${check.host} is its address`);
  };

  return (
    <div className="wb-page ms-page">
      <SiteBack d={d} id={id} />
      <div className="ops-head"><h1>Domain</h1></div>
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <Unavailable q={q} />}
      {d && (
        <>
          <p className="wb-help">Your Render plan must allow another custom domain.</p>
          <section className="card ms-card" aria-labelledby="ms-dom-h">
            <h2 id="ms-dom-h" className="wb-card-h">{host ? `Its address: ${host}` : 'No domain yet'}</h2>
            {host && <p className="wb-field__hint">Also www.{host}. Until it points here, the site is at <a href={d.urls.site} target="_blank" rel="noopener">base.win’s own address for it<span className="ws-sr"> (opens a new tab)</span></a>.</p>}
            {manager ? (
              <form onSubmit={submit} className="ms-dom-form">
                <div className="field">
                  <label htmlFor="ms-dom">{host ? 'Change it to' : 'Web address'}</label>
                  <input id="ms-dom" className="input" maxLength={300} autoComplete="off" spellCheck={false} inputMode="url"
                    placeholder="yourcampaign.ca" value={typed} aria-invalid={check.why ? 'true' : undefined}
                    aria-describedby="ms-dom-say" onChange={(e) => setTyped(e.target.value)} />
                  <p className={check.why ? 'wb-field__err' : 'wb-field__hint'} id="ms-dom-say" aria-live="polite">
                    {check.why || (host && check.host ? 'The old address will show ‘This website has closed’ until you release it.' : 'The domain alone; the www. is added.')}
                  </p>
                </div>
                <div className="ops-actions">
                  <button type="submit" className="btn btn-primary ops-tap" disabled={!online || busy || !check.host || Boolean(check.why) || check.checking}>
                    {busy ? 'Saving…' : 'Save the address'}
                  </button>
                  {host && !asking && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(true)}>Remove the address</button>}
                </div>
                {asking && (
                  <>
                    <p className="wb-field__hint">The old address will show ‘This website has closed’ until you release it.</p>
                    <Ask words={`Remove ${host}?`} busy={busy} onNo={() => setAsking(false)} onYes={() => save([], `${host} removed`)} />
                  </>
                )}
              </form>
            ) : <p className="wb-field__hint">A manager sets the address.</p>}
            <p className="ms-problem" role="alert">{problem || ''}</p>
          </section>

          {host && (
            <section className="card ms-card" aria-labelledby="ms-steps-h">
              <h2 id="ms-steps-h" className="wb-card-h">Then, in this order</h2>
              <ol className="ms-steps">
                <li>
                  <p>Buy the domain at any registrar (you keep the account).</p>
                  <CopyLine text={host} label="the domain" />
                </li>
                <li>
                  <p>In Render, open the base.win service → Settings → Custom Domains → Add <b>{host}</b>. Render adds www.{host} too.</p>
                  <CopyLine text={host} label="the domain for Render" />
                </li>
                <li>
                  <p>At your registrar, add the records Render shows: an A record for <b>@</b>, and a CNAME for <b>www</b> pointing to {d.render_host ? <b>{d.render_host}</b> : 'your Render address'}. Delete any AAAA record for the domain.</p>
                  {d.render_host && <CopyLine text={d.render_host} label="the Render address" />}
                </li>
              </ol>
              <a className="ms-link" href={`https://${host}`} target="_blank" rel="noopener">Open https://{host}<span className="ws-sr"> (opens a new tab)</span></a>
            </section>
          )}
        </>
      )}
      <Toast toast={toast} onClear={clear} />
    </div>
  );
}

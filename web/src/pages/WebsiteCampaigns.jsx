// Website → Petitions and pledges (/website/petitions, /website/petitions/:id).
//   The list: each one's title, petition or pledge, open or closed, how many
//   have signed — with a bar to its goal — and "See who signed" (People,
//   filtered to the tag a signature puts on the person: "Signed: <title>").
//   One yellow "New petition or pledge".
//   One petition or pledge: which kind (fixed once someone has signed), its
//   title, what people sign (the statement), a short excerpt, more about it
//   (Markdown), a goal, its address (/act/<address>). "Save" is the yellow
//   button; Close (no more signatures) or Open again beside it; ⋯ → View
//   on the site, Delete (Undo brings it back). A section on a page shows
//   one of these (Pages → a page → Add a section → Petition or pledge).
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { MarkdownField } from '../components/MarkdownField.jsx';
import { MoreMenu, Toast, WebsiteTabs, useToast } from '../components/site/Bits.jsx';
import { TextField, uploadSitePicture } from '../components/site/Fields.jsx';
import { useSite, useSiteCampaign, useSiteCampaigns, useSiteRefresh } from '../components/site/useSite.js';
import { slugInput, slugify } from '../components/site/builder.js';
import './shifts.css';
import '../editor.css';
import './website.css';

const blank = { kind: 'petition', title: '', slug: '', excerpt: '', statement: '', body: '', goal: '' };
const formOf = (c) => ({
  kind: c.kind, title: c.title || '', slug: c.slug || '', excerpt: c.excerpt || '', statement: c.statement || '',
  body: c.body || '', goal: c.goal == null ? '' : String(c.goal),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const n = (x) => Number(x || 0).toLocaleString('en-CA');
const KIND = { petition: 'Petition', pledge: 'Pledge' };
// People, filtered to who signed (the tag the form put on them). A tag with
// a comma would read as two in the filter: then the count only.
export const signersHref = (c) => (c.signers_tag && !c.signers_tag.includes(',') ? `/people?tag=${encodeURIComponent(c.signers_tag)}` : null);

export function Goal({ c }) {
  if (!c.goal) return <span className="wb-goal__n">{n(c.signatures)} signed</span>;
  const pct = Math.min(100, Math.round((c.signatures / c.goal) * 100));
  return (
    <span className="wb-goal">
      <span className="wb-goal__n">{n(c.signatures)} of {n(c.goal)} signed</span>
      <span className="wb-goal__bar" role="img" aria-label={`${pct}% of the goal`} data-full={pct >= 100 ? '' : undefined}>
        <span style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function CampaignList({ say }) {
  const q = useSiteCampaigns();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const list = q.data?.campaigns || [];
  // ?new=1 (from a page's petition section): straight to a new one.
  useEffect(() => { if (params.get('new') === '1') navigate('/website/petitions/new', { replace: true }); }, [params, navigate]);
  const deleted = location.state?.deleted;
  useEffect(() => {
    if (!deleted) return;
    navigate('.', { replace: true, state: null });
    say(`Deleted “${deleted.title}”`, {
      undo: async () => {
        try {
          const back = await action('site.campaign.restore', { id: deleted.id });
          await refresh(['site-campaigns'], ['site']);
          say(back.campaign.slug === deleted.slug ? `“${deleted.title}” is back` : `“${deleted.title}” is back, at /act/${back.campaign.slug}`);
        } catch (e) { say(e.message); }
      },
    });
  }, [deleted, navigate, refresh, say]);
  return (
    <div className="wb-page">
      <div className="ops-head">
        <h1>Petitions and pledges</h1>
        {online && <button type="button" className="btn btn-primary ops-tap" onClick={() => navigate('/website/petitions/new')}>New petition or pledge</button>}
      </div>
      <WebsiteTabs />
      {noSignal(q) && <NoSignal />}
      {q.isPending && !noSignal(q) && <p className="muted">Loading…</p>}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && list.length === 0 && <p className="ops-empty">None yet. Each one has its own page (/act/…) and can be a section on any page.</p>}
      {list.length > 0 && (
        <ul className="wb-rows">
          {list.map((c) => {
            const who = signersHref(c);
            return (
              <li key={c.id} className="wb-row wb-row--camp">
                <div className="wb-row__main">
                  <Link className="wb-row__name" to={`/website/petitions/${c.id}`}>{c.title}</Link>
                  <span className="wb-row__sub">
                    <span className="chip">{KIND[c.kind]}</span>
                    {c.status === 'open' ? <span className="chip chip-ok">Open</span> : <span className="chip ops-chip-muted">Closed</span>}
                    <span className="wb-row__addr">/act/{c.slug}</span>
                  </span>
                  <Goal c={c} />
                </div>
                {who && c.signatures > 0 && (
                  <Link className="btn btn-quiet wb-tap wb-row__who" to={who}>See who signed<span className="ws-sr">: {c.title}</span></Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CampaignEditor({ id, say }) {
  const isNew = id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refresh = useSiteRefresh();
  const online = useOnline();
  const q = useSiteCampaign(isNew ? null : id);
  const siteQ = useSite();
  const [form, setForm] = useState(isNew ? blank : null);
  const [camp, setCamp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    const c = q.data?.campaign;
    if (!c || q.isFetching || camp?.id === c.id) return;
    setCamp(c);
    setForm(formOf(c));
  }, [q.data, q.isFetching, camp?.id]);
  useEffect(() => () => { if (!isNew) qc.invalidateQueries({ queryKey: ['site-campaign', id] }); }, [qc, id, isNew]);
  const dirty = useMemo(() => (form && (isNew ? Boolean(form.title.trim()) : camp && !same(form, formOf(camp)))), [form, camp, isNew]);
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const signed = camp?.signatures || 0;
  const siteRoot = (siteQ.data?.urls?.site || '/site/').replace(/\/$/, '');

  const done = (c, words) => {
    setCamp(c);
    setForm(formOf(c));
    qc.setQueryData(['site-campaign', c.id], { campaign: c });
    refresh(['site-campaigns'], ['site']);
    if (words) say(words);
    if (isNew) navigate(`/website/petitions/${c.id}`, { replace: true });
  };
  const save = async () => {
    if (!form.title.trim()) { setError('Give it a title'); return; }
    const goal = form.goal === '' ? null : Math.round(Number(form.goal));
    if (goal !== null && !(goal >= 1)) { setError('The goal: a whole number, 1 or more — or leave it empty'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await action('site.campaign.save', {
        ...(isNew ? {} : { id }), kind: form.kind, title: form.title.trim(), slug: form.slug.trim() || undefined,
        excerpt: form.excerpt, statement: form.statement, body: form.body, goal,
      });
      done(res.campaign, isNew ? `Made — it’s open to sign at /act/${res.campaign.slug}` : 'Saved — the site has the change');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const openClose = async (open) => {
    setBusy(true);
    setError(null);
    try {
      const res = await action('site.campaign.close', { id, open });
      done(res.campaign, open ? 'Open again — people can sign it' : 'Closed — no more signatures; its page says so');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await action('site.campaign.delete', { id });
      await refresh(['site-campaigns'], ['site']);
      navigate('/website/petitions', { replace: true, state: { deleted: { id, title: camp?.title || form.title, slug: camp?.slug } } });
    } catch (e) { setError(e.message); setBusy(false); }
  };

  if (!isNew && noSignal(q)) return <div className="wb-page"><NoSignal /></div>;
  if (!isNew && q.isError) {
    return (
      <div className="wb-page">
        <Link className="ops-back" to="/website/petitions">← Petitions and pledges</Link>
        <p className="error" role="alert">{q.error.status === 404 ? 'That one is gone — it may have been deleted.' : q.error.message}</p>
      </div>
    );
  }
  if (!form) return <div className="wb-page"><p className="muted">Loading…</p></div>;
  const who = camp ? signersHref(camp) : null;

  return (
    <div className="wb-page">
      <Link className="ops-back" to="/website/petitions">← Petitions and pledges</Link>
      <div className="wb-build__head">
        <div className="wb-build__title">
          <h1>{isNew ? `New ${form.kind}` : form.title || 'Untitled'}</h1>
          {camp && (
            <span className="wb-build__meta">
              <span className="chip">{KIND[camp.kind]}</span>
              {camp.status === 'open' ? <span className="chip chip-ok">Open</span> : <span className="chip ops-chip-muted">Closed</span>}
              <Goal c={camp} />
              {who && signed > 0 && <Link to={who}>See who signed</Link>}
              {dirty && <span className="wb-saved" data-state="blocked">Not saved yet</span>}
            </span>
          )}
        </div>
        <div className="wb-build__actions">
          {camp && (
            <button type="button" className="btn ops-tap" disabled={busy || !online} onClick={() => openClose(camp.status !== 'open')}>
              {camp.status === 'open' ? 'Close it' : 'Open it again'}
            </button>
          )}
          <button type="button" className="btn btn-primary ops-tap" disabled={busy || !online || !dirty} onClick={save}>
            {busy ? 'Saving…' : isNew ? 'Make it' : 'Save'}
          </button>
          {camp && (
            <MoreMenu label="More for this one" items={[
              { label: 'View on the site', href: `${siteRoot}/act/${camp.slug}`, external: true },
              { label: 'Delete it', onClick: remove, danger: true },
            ]} />
          )}
        </div>
      </div>
      {error && <p className="wb-alert" role="alert">{error}</p>}
      <div className="card wb-editor">
        <fieldset className="wb-group">
          <legend>A petition or a pledge?</legend>
          {signed > 0 ? (
            <p className="wb-fixed">A {camp.kind} — people have signed it, so it stays one.</p>
          ) : (
            <div className="ops-seg wb-kind" role="group" aria-label="A petition or a pledge?">
              {['petition', 'pledge'].map((k) => (
                <button key={k} type="button" aria-pressed={form.kind === k} onClick={() => set('kind', k)}>{KIND[k]}</button>
              ))}
            </div>
          )}
          <p className="wb-field__hint">A petition asks for something; a pledge is a promise people make (to vote, to volunteer).</p>
        </fieldset>
        <TextField id="wb-c-title" label="Title" max={160} value={form.title} onChange={(v) => set('title', v)} />
        <TextField id="wb-c-statement" label="What people sign (the statement)" max={1000} multiline rows={4} value={form.statement} onChange={(v) => set('statement', v)} />
        <TextField id="wb-c-excerpt" label="Short excerpt (in lists and shares)" max={400} multiline value={form.excerpt} onChange={(v) => set('excerpt', v)} />
        <div className="wb-md">
          <MarkdownField id="wb-c-body" label="More about it" value={form.body} rows={10} onChange={(v) => set('body', v)} upload={uploadSitePicture} />
        </div>
        <div className="form-row">
          <div className="field wb-field wb-field--narrow">
            <label htmlFor="wb-c-goal">Goal (signatures)</label>
            <input id="wb-c-goal" className="input" type="number" inputMode="numeric" min={1} step={1} value={form.goal}
              placeholder="5000" onChange={(e) => set('goal', e.target.value)} />
          </div>
          <div className="field wb-field">
            <label htmlFor="wb-c-slug">Address</label>
            <div className="wb-slug">
              <span className="wb-slug__root" aria-hidden="true">/act/</span>
              <input id="wb-c-slug" className="input" maxLength={60} autoComplete="off" spellCheck={false} value={form.slug}
                placeholder={slugify(form.title) || 'made-from-the-title'} onChange={(e) => set('slug', slugInput(e.target.value))} />
            </div>
          </div>
        </div>
        {who && signed > 0 && (
          <p className="wb-field__hint">Each person who signs gets the tag “{camp.signers_tag}” in People. A new title changes the tag new signatures get.</p>
        )}
      </div>
    </div>
  );
}

export default function WebsiteCampaigns() {
  const { id } = useParams();
  const { toast, say, clear } = useToast();
  return (
    <>
      {id ? <CampaignEditor key={id} id={id} say={say} /> : <CampaignList say={say} />}
      <Toast toast={toast} onClear={clear} />
    </>
  );
}

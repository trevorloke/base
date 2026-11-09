// Two-step sign-in, for the person signed in (server: ext/twostep,
// lib/twostep.js). One card, four states:
//   off        one line and "Turn on two-step sign-in"
//   setting up scan the QR code (or type the key), then the app's code
//   codes      the ten recovery codes, shown once: copy, download, "I've
//              saved them"
//   on         since when, recovery codes left; under More: new recovery
//              codes, turn it off (each with a code)
// Used by Your profile (pages/Profile.jsx) and, when the campaign requires
// it and it isn't on yet, by the screen that stands before everything else
// (TwoStepRequired, below — App.jsx).
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet, apiPost } from '../api.js';
import { NeedsSignalLine, useOnline } from './NoSignal.jsx';
import './two-step.css';

const day = (ts) => (ts ? new Date(ts).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
// The server's words, as a sentence.
const said = (m) => { const t = String(m || ''); return t.charAt(0).toUpperCase() + t.slice(1); };

// A code box: 6 digits from the app, or (where allowed) a recovery code.
export function CodeField({ id, label, value, onChange, recovery = false, autoFocus = false, describedBy, invalid }) {
  return (
    <div className="field ts-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input ts-code" value={value} onChange={(e) => onChange(e.target.value)}
        autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} autoCapitalize="none" spellCheck={false}
        maxLength={recovery ? 40 : 9} autoFocus={autoFocus} required aria-describedby={describedBy} aria-invalid={invalid || undefined} />
    </div>
  );
}

function CopyButton({ text, label = 'Copy', done = 'Copied' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button type="button" className="btn ts-btn" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2400);
      } catch { setCopied(false); }
    }}>
      <span aria-live="polite">{copied ? `✓ ${done}` : label}</span>
    </button>
  );
}

// The ten codes, shown once. Copy, a text file, and "I've saved them".
export function RecoveryCodes({ codes, me, heading, onDone, doneLabel = 'I’ve saved them' }) {
  const headRef = useRef(null);
  useEffect(() => { headRef.current?.focus(); }, []);
  const file = () => {
    const text = `base.win recovery codes — ${me?.workspace?.name || ''} — ${me?.user?.email || ''}\nEach works once, if you lose your phone.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'base-win-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="ts-codes">
      {/* Focus lands here, so the change is said without reading every code aloud. */}
      <h2 className="ts-h" tabIndex={-1} ref={headRef}>{heading}</h2>
      <p className="ts-line">Keep these somewhere safe. Each signs you in once if you lose your phone.</p>
      <p className="ts-line ts-strong">Shown only now.</p>
      <ul className="ts-codelist" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div className="ts-row">
        <CopyButton text={codes.join('\n')} label="Copy the codes" />
        <button type="button" className="btn ts-btn" onClick={file}>Download</button>
      </div>
      <button type="button" className="btn btn-primary ts-main" onClick={onDone}>{doneLabel}</button>
    </div>
  );
}

// Scan or type the key, then the first code.
function SetUp({ setup, onConfirm, onRestart, busy, error, online }) {
  const [code, setCode] = useState('');
  const errId = useId();
  return (
    <div className="ts-setup">
      <ol className="ts-steps">
        <li>
          <span>Scan this with an authenticator app on your phone.</span>
          {/* Setting it up on the phone itself: the app opens with the key in it. */}
          <a className="btn ts-btn ts-onphone" href={setup.uri}>Add it to an app on this phone</a>
          {setup.qr ? (
            <svg className="ts-qr" role="img" aria-label="QR code for your authenticator app" viewBox={`0 0 ${setup.qr.size} ${setup.qr.size}`}
              width="200" height="200" shapeRendering="crispEdges">
              <rect width={setup.qr.size} height={setup.qr.size} fill="#fff" />
              <path d={setup.qr.d} fill="#000" />
            </svg>
          ) : null}
        </li>
        <li>
          <span>Or type this key into the app:</span>
          <code className="ts-key" data-key={setup.key}>{setup.grouped}</code>
          <CopyButton text={setup.key} label="Copy key" />
        </li>
        <li><span>Type the 6-digit code the app shows.</span></li>
      </ol>
      <form className="ts-form" onSubmit={(e) => { e.preventDefault(); if (code.trim()) onConfirm(code.trim()); }}>
        <CodeField id="ts-confirm" label="Code from your app" value={code} onChange={setCode} describedBy={error ? errId : undefined} invalid={Boolean(error)} />
        {error && <p className="error" id={errId} role="alert">{said(error)}</p>}
        <button type="submit" className="btn btn-primary ts-main" disabled={busy || !online || !code.trim()}>
          {busy ? 'Checking…' : 'Turn on'}
        </button>
      </form>
      <button type="button" className="btn btn-quiet ts-quiet" disabled={busy || !online} onClick={onRestart}>Start over with a new key</button>
    </div>
  );
}

// A code, then a thing done: new recovery codes, or turning it off.
function WithCode({ id, label, button, recovery, onSubmit, danger }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const errId = useId();
  const online = useOnline();
  const submit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true); setError(null);
    try { await onSubmit(code.trim()); setCode(''); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <form className="ts-form ts-more-form" onSubmit={submit}>
      <CodeField id={id} label={label} value={code} onChange={setCode} recovery={recovery} describedBy={error ? errId : undefined} invalid={Boolean(error)} />
      {error && <p className="error" id={errId} role="alert">{said(error)}</p>}
      <button type="submit" className={`btn ts-btn${danger ? ' ts-danger' : ''}`} disabled={busy || !online || !code.trim()}>{busy ? 'Checking…' : button}</button>
    </form>
  );
}

// The card. forced: the campaign requires it and it isn't on yet (no "off"
// state to linger in, and "I've saved them" opens the app). onCodes: the
// recovery codes are on screen (the set-up screen stays until they're saved).
export default function TwoStepCard({ me, forced = false, onOn, onCodes }) {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: ['two-step'], queryFn: () => apiGet('/two-step') });
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null); // { list, heading, after }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState(null);
  const moreId = useId();
  const st = q.data;
  const shownSetup = setup || st?.setup || null;

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['two-step'] });
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
  const start = async () => {
    setBusy(true); setError(null); setNote(null);
    try { setSetup((await action('twostep.start')).setup); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const confirm = async (code) => {
    setBusy(true); setError(null);
    try {
      const r = await action('twostep.confirm', { code });
      setSetup(null);
      onCodes?.();
      setCodes({ list: r.recovery_codes, heading: '✓ Two-step sign-in is on', elsewhere: r.signed_out_elsewhere });
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (codes) {
    return (
      <section className="ts-card" aria-label="Two-step sign-in">
        <RecoveryCodes codes={codes.list} me={me} heading={codes.heading}
          doneLabel={forced ? 'I’ve saved them — open base.win' : 'I’ve saved them'}
          onDone={async () => { setCodes(null); await refresh(); onOn?.(); }} />
        {codes.elsewhere > 0 && <p className="ts-line muted">Your other devices will ask you to sign in again.</p>}
      </section>
    );
  }
  if (!st) {
    return (
      <section className="ts-card" aria-label="Two-step sign-in">
        {q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  // On the screen that stands before everything else, its own headline says it.
  const title = forced ? null : (
    <div className="ts-head">
      <h2 className="ts-h">Two-step sign-in</h2>
      <span className={`chip ${st.on ? 'chip-ok' : ''} ts-state`}>{st.on ? 'On' : 'Off'}</span>
    </div>
  );

  if (st.on) {
    return (
      <section className="ts-card" aria-label="Two-step sign-in">
        {title}
        {st.unreadable && <p className="error" role="alert">Codes from your app can’t be checked here any more. Turn it off with a recovery code, then set it up again.</p>}
        <p className="ts-line">Since {day(st.since)} · <strong>{st.recovery_left}</strong> recovery {st.recovery_left === 1 ? 'code' : 'codes'} left</p>
        {note && <p className="ts-line ts-note" role="status">{note}</p>}
        <button type="button" className="disclose ts-disclose" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((v) => !v)}>More</button>
        <div id={moreId} hidden={!more} className="ts-more">
          <h3 className="ts-h3">New recovery codes</h3>
          <WithCode id="ts-newcodes" label="Code from your app" button="Make new codes"
            onSubmit={async (code) => {
              const r = await action('twostep.codes', { code });
              setCodes({ list: r.recovery_codes, heading: 'Your new recovery codes' });
              setMore(false);
            }} />
          <h3 className="ts-h3">Turn it off</h3>
          {st.required && <p className="ts-line muted">Your role needs it here: you’ll set it up again straight away.</p>}
          <WithCode id="ts-off" label="Code from your app, or a recovery code" button="Turn off" recovery danger
            onSubmit={async (code) => {
              await action('twostep.off', { code });
              setMore(false);
              setNote('Two-step sign-in is off.');
              await refresh();
            }} />
        </div>
        {!online && <NeedsSignalLine>Changes need signal</NeedsSignalLine>}
      </section>
    );
  }

  if (shownSetup) {
    return (
      <section className="ts-card" aria-label="Two-step sign-in">
        {title}
        <SetUp setup={shownSetup} onConfirm={confirm} onRestart={start} busy={busy} error={error} online={online} />
      </section>
    );
  }

  return (
    <section className="ts-card" aria-label="Two-step sign-in">
      {title}
      {!forced && <p className="ts-line">After your password, a code from an app on your phone.</p>}
      {note && <p className="ts-line ts-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{said(error)}</p>}
      <button type="button" className="btn btn-primary ts-main" disabled={busy || !online} onClick={start}>
        {busy ? 'Starting…' : forced ? 'Set it up' : 'Turn on two-step sign-in'}
      </button>
      {!online && <NeedsSignalLine>Setting it up needs signal</NeedsSignalLine>}
    </section>
  );
}

// Before anything else: the campaign requires two-step sign-in for this
// role and it isn't on yet (App.jsx, from /api/auth/me). Sign out stays a tap
// away. onHold(true): the recovery codes are showing — App.jsx keeps this
// screen up, whatever /auth/me now says, until "I've saved them".
export function TwoStepRequired({ me, onHold }) {
  const qc = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const signOut = async () => {
    setLeaving(true);
    try { await apiPost('/auth/logout'); } catch { /* signed out here either way */ }
    qc.clear();
    window.location.reload();
  };
  return (
    <div className="auth-page ts-gate">
      <span className="brand">base.win</span>
      <span className="brand-org">{me?.workspace?.name}</span>
      <h1>Set up two-step sign-in</h1>
      <p className="ts-line">{me?.workspace?.name || 'Your campaign'} asks everyone at the desk to use it.</p>
      <TwoStepCard me={me} forced onCodes={() => onHold?.(true)}
        onOn={() => { onHold?.(false); qc.invalidateQueries({ queryKey: ['me'] }); }} />
      <p className="ts-signout">
        <button type="button" className="btn-link" disabled={leaving} onClick={signOut}>{leaving ? 'Signing out…' : 'Sign out'}</button>
      </p>
    </div>
  );
}

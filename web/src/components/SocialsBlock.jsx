// A profile's Socials (desk): each handle opens the real profile; its
// followers are typed in from it; one box takes a pasted link or @handle
// (shared/socials.js reads it) and, for a bare @name, asks which network
// with one row of chips. Writes: person.social.set / .remove and
// person.followers.set (ext/socials) — they need signal.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAction } from '../pages/People.jsx';
import {
  CHIP_ORDER, PLATFORMS, countFull, countWord, parseCount, parseSocial, platformWord, profileUrl, shownHandle,
} from '@starbase/shared/socials';
import '../pages/socials.css';

// Only the networks base.win knows, with something in them (an old stray
// key on file is not drawn).
export const socialsOf = (person) => PLATFORMS
  .filter((p) => typeof person?.socials?.[p] === 'string' && person.socials[p].trim())
  .map((p) => [p, person.socials[p].trim()]);
const reachOf = (person) => (person?.social_reach && typeof person.social_reach === 'object' ? person.social_reach : {});
// "2026-11-03" → "3 Nov"
const dayWord = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
};

function Followers({ person, platform, entry, act, onSaved }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(entry ? String(entry.n) : '');
  const [bad, setBad] = useState(null);
  const id = `so-n-${platform}`;
  const save = async (e) => {
    e.preventDefault();
    const n = text.trim() ? parseCount(text) : null;
    if (text.trim() && (n == null || n > 100_000_000)) { setBad('Type a number, like 1200 or 12k'); return; }
    setBad(null);
    const res = await act.run('person.followers.set', { id: person.id, platform, followers: n });
    if (res) { setOpen(false); onSaved('Saved'); }
  };
  if (!open) {
    return (
      <button type="button" className="so-count" onClick={() => setOpen(true)}
        aria-label={entry ? `${countFull(entry.n)} followers on ${platformWord(platform)} — change` : `How many followers on ${platformWord(platform)}?`}>
        {entry ? `${countFull(entry.n)} followers` : 'Followers?'}
      </button>
    );
  }
  return (
    <form className="so-count-form" onSubmit={save}>
      <label htmlFor={id}>How many followers?</label>
      <input id={id} className="input" inputMode="decimal" autoFocus maxLength={20} value={text}
        onChange={(e) => setText(e.target.value)} placeholder="12k" />
      <button type="submit" className="btn pp-btn" disabled={act.busy}>Save</button>
      <button type="button" className="btn btn-quiet pp-btn" onClick={() => setOpen(false)}>Cancel</button>
      {bad && <span className="error" role="alert">{bad}</span>}
    </form>
  );
}

export default function SocialsBlock({ person, refresh }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [ask, setAsk] = useState(null);
  const [said, setSaid] = useState(null);
  const [also, setAlso] = useState(null);
  const [removing, setRemoving] = useState(null);
  const act = useAction(refresh, { needsSignal: true });
  const entries = socialsOf(person);
  const reach = reachOf(person);
  const top = Number.isInteger(person.followers) ? person.followers : null;

  const say = (s) => { setSaid(s); act.clearError(); };
  const save = async (platform) => {
    const res = await act.run('person.social.set', { id: person.id, value: value.trim(), ...(platform ? { platform } : {}) });
    if (!res) return;
    setValue(''); setAsk(null); setAdding(false); setAlso(res.also || null);
    say('Saved');
  };
  const add = (e) => {
    e.preventDefault();
    setSaid(null); setAlso(null);
    const r = parseSocial(value);
    if (r.ask) { setAsk(r.error); return; }
    setAsk(null);
    if (r.error) { setSaid(r.error); return; }
    save();
  };
  const remove = async (p) => {
    const res = await act.run('person.social.remove', { id: person.id, platform: p });
    setRemoving(null);
    if (res) say('Removed');
  };

  return (
    <div className="so">
      <div className="card-head pf-sub">
        <span className="eyebrow">Socials</span>
        {top != null && <span className="chip so-top">{countWord(top)} followers</span>}
        <button type="button" className="btn btn-quiet pp-btn" aria-expanded={adding}
          onClick={() => { setAdding((v) => !v); setAsk(null); setSaid(null); }}>
          {adding ? 'Close' : '+ Add'}
        </button>
      </div>
      {entries.length > 0 && (
        <ul className="contact-lines so-lines">
          {entries.map(([p, h]) => {
            const href = profileUrl(p, h);
            const shown = shownHandle(p, h);
            return (
              <li key={p}>
                <span className="k so-k">{platformWord(p)}</span>
                <span className="v so-v">
                  {href ? <a href={href} target="_blank" rel="noopener noreferrer">{shown}</a> : shown}
                  <Followers key={`${p}:${reach[p]?.n ?? ''}`} person={person} platform={p} entry={reach[p]} act={act} onSaved={say} />
                </span>
                {removing !== p && (
                  <span className="act">
                    <button type="button" className="chip-x so-x" aria-label={`Remove ${platformWord(p)}`} disabled={act.busy}
                      onClick={() => setRemoving(p)}>×</button>
                  </span>
                )}
                {removing === p && (
                  <span className="so-confirm">
                    <span>Remove {shown.startsWith('@') ? shown : `the ${platformWord(p)} link`}?</span>
                    <button type="button" className="btn pp-btn" disabled={act.busy} onClick={() => remove(p)}>Yes</button>
                    <button type="button" className="btn btn-quiet pp-btn" autoFocus onClick={() => setRemoving(null)}>No</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!entries.length && !adding && <p className="pf-empty">No socials.</p>}
      {adding && (
        <form className="so-add" onSubmit={add}>
          <label htmlFor="so-value">Paste a link or @handle</label>
          <div className="so-add-row">
            <input id="so-value" className="input" autoFocus maxLength={300} value={value}
              onChange={(e) => { setValue(e.target.value); setAsk(null); }} placeholder="instagram.com/name or @name" />
            <button type="submit" className="btn pp-btn" disabled={act.busy || !value.trim()}>Save</button>
          </div>
          {ask && (
            <div className="so-ask" role="group" aria-label={ask}>
              <p className="so-ask-q">{ask}</p>
              <div className="so-chips">
                {CHIP_ORDER.map((p) => (
                  <button key={p} type="button" className="chip so-chip" disabled={act.busy} onClick={() => save(p)}>{platformWord(p)}</button>
                ))}
              </div>
            </div>
          )}
        </form>
      )}
      <p className={act.error || (said && said !== 'Saved' && said !== 'Removed') ? 'error so-status' : 'status-line so-status'} role="status" aria-live="polite">
        {act.error || said || ''}
      </p>
      {also && (
        <p className="so-also">Also on <Link to={`/people/${also.id}`}>{also.name}’s profile</Link></p>
      )}
    </div>
  );
}

// Under More details: when each count was typed, and the one line on what
// may be kept.
export function SocialsTyped({ person }) {
  const entries = socialsOf(person);
  if (!entries.length) return null;
  const reach = reachOf(person);
  const typed = entries.filter(([p]) => reach[p]?.at);
  return (
    <div className="so-typed">
      {typed.length > 0 && (
        <ul className="list-plain">
          {typed.map(([p]) => <li key={p}>{platformWord(p)} followers · Typed {dayWord(reach[p].at)}</li>)}
        </ul>
      )}
      <p className="so-note">Only what’s public on their profile. Remove on request.</p>
    </div>
  );
}

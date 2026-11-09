// A follow-up, opened on Today: what the person did (their roles and when
// they're free, their message, the event, where they were met), their
// number, one tap to call or text them — through the campaign's number when
// it's connected, else the phone's own (TextingCallButton, as on Calls and
// My people) — and how it went: a rating (they talked), Talked, Left a
// message, No answer. Logging it is a contact (contact.log, through the
// phone's outbox: it works with no signal and sends once), and the server
// closes the follow-up with it. Loaded on the first tap, so Today stays light.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import RatingButtons, { ratingText, useScale } from './RatingButtons.jsx';
import { TextingCallButton, noTexts } from './TextingCard.jsx';
import { queuedText } from './queued.js';
import { Icon, firstName, invalidatePersonData, isDnc, smsHref, telHref, textBody, useAction } from '../pages/People.jsx';
import '../pages/people.css';
import '../pages/relationships.css';

const WAYS = { phone: 'Call', text: 'Text', in_person: 'In person' };
const LOGGED = { phone: 'Call', text: 'Text', in_person: 'In person' };
const fmtWhen = (ts) => new Date(ts).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// One thing they did, in full: the line (unless the row already says it),
// then what they said.
function Did({ d, said: saidOnRow }) {
  const bits = [
    d.roles?.length ? d.roles.join(', ') : null,
    d.availability ? `Free: ${d.availability}` : null,
    d.shift?.starts_at ? fmtWhen(d.shift.starts_at) : null,
  ].filter(Boolean);
  const said = d.message || d.note;
  if (saidOnRow && !bits.length && !said) return null;
  return (
    <li className="fu-did">
      {!saidOnRow && <span className="fu-did__what">{d.words}</span>}
      {bits.length > 0 && <span className="fu-did__bits">{bits.join(' · ')}</span>}
      {said && <q className="fu-did__said">{said}</q>}
    </li>
  );
}

export default function FollowupReach({ f, me, onLogged }) {
  const p = f.person;
  const first = firstName(p.name) || p.name;
  const scale = useScale();
  const queryClient = useQueryClient();
  const act = useAction(() => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['followups'] }),
    queryClient.invalidateQueries({ queryKey: ['ladders'] }),
    invalidatePersonData(queryClient),
  ]));
  const ways = [p.phone && 'phone', p.phone && !noTexts(p) && 'text', 'in_person'].filter(Boolean);
  const [way, setWay] = useState(ways[0]);
  const howId = useId();
  const wentId = useId();

  const log = async (outcome, rating) => {
    const res = await act.run('contact.log', {
      person_id: p.id, channel: way, outcome, rating: rating || undefined,
    }, { who: p.name });
    if (!res) return;
    const did = rating ? `Rated ${ratingText(scale, rating)}`
      : outcome === 'contacted' ? 'Talked'
        : outcome === 'left_message' ? 'Left a message'
          : way === 'text' ? 'No reply' : 'No answer';
    onLogged(res.queued
      ? `${p.name} · ${LOGGED[way]} · ${did} · ${queuedText(res)}`
      : `✓ ${p.name} · ${LOGGED[way]} · ${did} — followed up`);
  };

  return (
    <div className="fu-body rel-reach">
      {f.did?.length > 0 && (
        <ul className="fu-dids">
          {/* One thing: the row says what it was, here only what they said. */}
          {f.did.map((d, i) => <Did key={i} d={d} said={f.did.length === 1 && d.words === f.text} />)}
        </ul>
      )}
      {isDnc(p) ? (
        <p><span className="chip chip-danger">Do not contact</span></p>
      ) : (
        <>
          {p.phone && <p className="fu-phone mono">{p.phone}</p>}
          {ways.length > 1 && (
            <div className="rel-how">
              <span className="rel-label" id={howId}>How you reach them</span>
              <div className="cl-toggle" role="group" aria-labelledby={howId}>
                {ways.map((w) => (
                  <button key={w} type="button" aria-pressed={way === w} onClick={() => setWay(w)}>{WAYS[w]}</button>
                ))}
              </div>
            </div>
          )}
          {way !== 'in_person' && (
            <TextingCallButton person={p} me={me} channel={way === 'text' ? 'text' : 'phone'} onSent={() => {}}>
              {way === 'text' ? (
                <a className="btn cl-call" href={smsHref(p.phone, textBody(p, me))}><Icon name="text" size={22} /> Text {first}</a>
              ) : (
                <a className="btn cl-call" href={telHref(p.phone)}><Icon name="phone" size={22} /> Call {first}</a>
              )}
            </TextingCallButton>
          )}
          <div className="fu-went" role="group" aria-labelledby={wentId} aria-describedby={`${wentId}-hint`}>
            <span className="rel-label" id={wentId}>How it went</span>
            <span className="fu-hint" id={`${wentId}-hint`}>Logging it closes the follow-up.</span>
            <RatingButtons onPick={(code) => log('contacted', code)} disabled={act.busy} />
            <div className="cl-outcomes fu-outcomes">
              <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('contacted')}>Talked</button>
              {way === 'phone' && <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('left_message')}>Left a message</button>}
              {way !== 'in_person' && (
                <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('no_answer')}>{way === 'text' ? 'No reply' : 'No answer'}</button>
              )}
            </div>
          </div>
          {act.error && <p className="error" role="alert">{act.error}</p>}
        </>
      )}
      <div className="fu-foot">
        <Link className="btn btn-quiet fu-tap" to={`/people/${p.id}`} state={{ from: { to: '/', label: 'Today' } }}>Profile</Link>
      </div>
    </div>
  );
}

// "Authorized by …" on the desk: one answer for every screen
// (GET /api/site/authorized, server/ext/site/authorized-api.js; the rule
// is shared/site/authorized.js), so no screen has its own check.
//   useAuthorized()        the answer, read once and shared
//   authLine(a)            the words a message gains ('' while it isn't filled in)
//   needsAsk(a)            after its "needed from" date with no line at all:
//                          a send asks first ("Send without it")
//   <AuthorizedBanner a>   the send screens' red line after the date
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api.js';

export const AUTHORIZED_KEY = ['site-authorized'];
export const useAuthorized = (enabled = true) => useQuery({
  queryKey: AUTHORIZED_KEY, queryFn: () => apiGet('/site/authorized'), enabled, staleTime: 60_000,
});

// "2026-10-17" → "Oct 17, 2026" (a date as typed: no time zone to move it).
export const dayWords = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return String(d || '');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};
// The words a text or a share post gains, on their own line(s).
export const authLine = (a, lang = null) => (a?.en ? [a.en, lang && a.byLang?.[lang]].filter(Boolean).join('\n') : '');
export const needsAsk = (a) => Boolean(a?.warn && a.warn.level === 'due' && a.warn.gap === 'missing');
// A refusal from the server that asks the same (409 { needsAuthorized }).
export const askedFor = (err) => Boolean(err?.body?.needsAuthorized);

export function AuthorizedBanner({ a, mayFix = true }) {
  if (!a?.warn || a.warn.level !== 'due') return null;
  const fix = mayFix ? <> <Link to="/website/settings#wb-s-agent">Add it</Link></> : ' Ask a manager to add it in Website → Settings.';
  return (
    <p className="banner auth-banner" role="alert" data-auth={a.warn.gap}>
      <span>
        {a.warn.gap === 'missing'
          ? <>This goes out without the Authorized by line, which you said is needed from {dayWords(a.warn.from)}.</>
          : <>The Authorized by line has no way to reach your financial agent yet. You said it is needed from {dayWords(a.warn.from)}.</>}
        {fix}
      </span>
    </p>
  );
}

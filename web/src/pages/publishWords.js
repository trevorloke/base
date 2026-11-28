// What the desk says after a page is published (WebsitePage.jsx): pure, so
// a test reads it (server/test/authorized.test.js T18). "No Authorized by
// line yet" only when nothing at all is filled in (shared/site/authorized.js
// authorizedSet) — never because the old free line is empty while a
// financial agent is named.
import { authorizedSet } from '@base-win/shared/site/authorized';

export const publishedWords = ({ langs = [], org = {}, older = 0 } = {}) => {
  const words = [...new Set(langs.map((c) => (c === 'pa' ? 'ਪੰਜਾਬੀ' : '中文')))];
  const noAuth = authorizedSet(org) === 'empty';
  const text = `Published.${words.length ? ` ${words.join(' and ')} update in about a minute.` : ''}${older ? ` ${older === 1 ? '1 older picture has' : `${older} older pictures have`} no description.` : ''}${noAuth ? ' Your site has no ‘Authorized by’ line yet.' : ''}`;
  return { text, noAuth };
};

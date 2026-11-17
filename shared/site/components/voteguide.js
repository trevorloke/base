// The voter guide on a website page (VG): the module "Voter guide", the
// banner on every page while voting is near or on, and the guide alone for
// another website's frame (the embed). The data is rc.data.guide — the
// published guide (a draft only in a preview), with the server's moments
// and its clock at drawing (server/ext/voteguide read.js publicGuide).
// Until a guide is published every place it appears says "Voting
// information isn't out yet" and offers a sign-up: nothing the campaign
// didn't enter is ever drawn, and the product ships no facts of its own.
import { html } from './h.js';
import { Island } from './islands.js';
import { formProps, makeF } from './modules.js';
import { guideState, dayWords, timeWords } from '../../voteguide.js';
import { arr, obj, str } from './util.js';

const guideOf = (rc) => {
  const g = rc.data.guide;
  return g && typeof g === 'object' ? g : null;
};
const titleId = (m) => `m-${m.id}-title`;
const Heading = ({ level, id, children }) => {
  const H = `h${Math.min(6, Math.max(1, level))}`;
  return str(children).trim() ? html`<${H} id=${id} className="display">${children}<//>` : null;
};
const away = (rc, href, label) => html`<a href=${href} target=${rc.embed ? '_top' : '_blank'} rel="noopener noreferrer">${label}<span aria-hidden="true"> ↗</span></a>`;

// Not out yet (or a draft outside a preview): these words, a sign-up, the
// office's link — no day, no place, no name.
function NotOut({ m, p, rc, level, g }) {
  const F = makeF(rc);
  const office = str(g?.official_label).trim() || rc.w('vg.theOffice');
  return html`<div className="container stack vg vg--not-out">
    <${Heading} level=${level} id=${titleId(m)}>${p.title}<//>
    <p className="vg-status">${rc.w('vg.notOut')}</p>
    <p>${rc.w('vg.notOutWhen', { office })}</p>
    <${Island} name="form" props=${formProps(rc, m, 'newsletter', {
      layout: 'inline',
      fields: [F.first({ required: false, optional: true, msg: undefined }), F.email()],
      impliedConsent: 'consent_email',
      submit: rc.w('vg.remind'),
      submitClass: 'btn--brand',
      small: rc.site.consent.newsletter,
      ...(rc.lang !== 'en' && rc.site.consentLang?.newsletter === 'en' ? { smallLang: 'en' } : {}),
      thanks: { title: rc.w('form.newsletterThanks'), body: rc.w('form.newsletterThanksBody') },
      hidden: { source: 'voter-guide' },
    })} />
    ${g?.official_url ? (() => {
      // The words around the link are the <p>'s own children (no list, no keys).
      const [before, after] = rc.w('vg.official', { label: '\u0000' }).split('\u0000');
      return html`<p className="small">${before}${away(rc, g.official_url, g.official_label || g.official_url)}${after || ''}</p>`;
    })() : null}
  </div>`;
}

// The island's props: the guide as published, its words in the page's
// language — the rules, the ballot's note and a closed place's note only
// once a person checked them; names, addresses and areas never translated.
export function guideProps(rc, m, p, level) {
  const g = guideOf(rc);
  // Over: nothing to carry but the words (no place, no name).
  const over = guideState(obj(g.times), g.now).state === 'over';
  const check = { check: true };
  const rules = Object.fromEntries(Object.entries(obj(g.rules)).filter(([, t]) => str(t).trim()).map(([k, t]) => [k, rc.markdown(t, check)]));
  const cta = p.cta && rc.link(obj(p.cta).href) && str(obj(p.cta).label).trim() ? { href: rc.link(p.cta.href), label: p.cta.label } : null;
  return {
    uid: `${m.id}-vg`,
    headingId: titleId(m),
    title: p.title,
    intro: p.intro,
    level,
    lang: rc.lang,
    now: g.now,
    embed: Boolean(rc.embed),
    showBallot: p.showBallot !== false,
    cta,
    clockUrl: `${rc.loc.root}api/guide/clock`,
    findUrl: `${rc.loc.root}api/guide/find`,
    where: obj(g.where),
    filter: obj(rc.vgFilter),
    rules,
    ballotNote: str(g.ballot_note).trim() ? rc.tt(g.ballot_note, check) : '',
    guide: {
      times: g.times,
      areas: over ? [] : arr(g.areas),
      places: (over ? [] : arr(g.places)).map((x) => ({
        ...x,
        note: x.note ? rc.tt(x.note) : '',
        closed_note: x.closed_note ? rc.tt(x.closed_note, check) : '',
      })),
      contests: (over ? [] : arr(g.contests)).map((c) => ({ ...c, office: rc.tt(c.office, check), names: arr(c.names).map((n) => ({ ...n, name: rc.names(n.name) })) })),
      vote_anywhere: g.vote_anywhere ?? null,
      official_url: g.official_url || '',
      official_label: g.official_label || '',
      mail: obj(g.mail),
      ride_phone: g.ride_phone || '',
      wait_url: g.wait_url || '',
      checkedOn: g.checkedOn || null,
    },
    ...rc.islandWords('voteguide'),
  };
}

export function VoterGuide({ m, p, rc, level }) {
  const g = guideOf(rc);
  const out = !g || g.status !== 'published';
  return html`<section data-module="voterguide" id=${`m-${m.id}`} className="section tone-paper vg-section" aria-labelledby=${titleId(m)}>
    ${out
      ? html`<${NotOut} m=${m} p=${p} rc=${rc} level=${level} g=${g} />`
      : html`<div className="container"><${Island} name="voteguide" props=${guideProps(rc, m, p, level)} /></div>`}
  </section>`;
}

// ── The banner on every page (decision 18) ──
// From midnight a week before the first voting day until the last close,
// on every page but the guide's own, the embed and the plain pages.
export function VoteBanner({ rc }) {
  const g = guideOf(rc);
  if (!g || g.status !== 'published' || !g.banner || !g.page || rc.embed) return null;
  if (rc.kind === 'page' && rc.modules.some((x) => x && !x.hidden && x.kind === 'voterguide')) return null;
  const times = obj(g.times);
  const st = guideState(times, g.now, g.places);
  if (st.state === 'over' || st.state === 'not_out') return null;
  if (st.state === 'before' && !(g.now >= times.bannerFrom)) return null;
  const lang = rc.lang;
  let words;
  if (st.state === 'before') words = rc.w('vg.bannerBefore', { day: dayWords(st.next?.day, lang) });
  else if (st.state === 'open') words = rc.w('vg.bannerOpen', { time: timeWords(st.next?.closes, lang) });
  else if (st.next?.day === st.day) words = rc.w('vg.bannerToday', { time: timeWords(st.next?.opens, lang) });
  else words = rc.w('vg.bannerNext', { day: dayWords(st.next?.day, lang) });
  // "until 8 p.m.." → one full stop.
  words = words.replace(/\.\.$/, '.');
  const href = rc.link(g.page);
  return html`<div className="vote-banner" role="region" aria-label=${rc.w('vg.banner')}>
    <div className="vote-banner-inner">
      <p>${words} ${href ? html`<a href=${href}>${rc.w('vg.bannerLink')}</a>` : null}</p>
    </div>
  </div>`;
}

// ── The embed (decision 21): the guide alone, for another website's frame ──
// Its own authorization line, since the framing site's footer may not carry it.
export function EmbedView({ rc, page, Module }) {
  const m = arr(obj(page).modules).find((x) => x && x.kind === 'voterguide');
  const org = rc.site.org;
  return html`<main id="main" tabIndex="-1" className="vg-embed">
    ${m ? html`<${Module} m=${m} rc=${rc} level=${1} />` : null}
    <div className="container vg-embed-foot small">
      ${org.authorization ? html`<p className="footer-authorization">${org.authorization}</p>` : null}
      ${org.name ? html`<p>${rc.w('vg.by', { org: org.name })}</p>` : null}
    </div>
  </main>`;
}

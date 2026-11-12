// Social media handles: one reader for what people paste, shared by the
// server (person.social.set, the import), the profile and Website settings.
//
//   parseSocial(text, hint?)  → { platform, handle } | { error, ask? }
//       A profile link (any of the forms people copy from an app or a
//       browser) or an @handle, put right. hint is the network the screen or
//       the import column says; a link's own host wins over it. A link to a
//       post, a short link, or a name with no network is refused in plain
//       words (ask: true — the screen offers the networks as chips).
//       The handle is kept without "@", in the case typed (Bluesky
//       lowercased); a profile with no plain handle is kept as its https://
//       link.
//   sameHandle(a, b)          two stored values name the same account
//   profileUrl(platform, v)   the address that opens the profile (or null)
//   shownHandle(platform, v)  "@h", "Profile link", or an old value as typed
//   parseCount("12k") → 12000 · countWord(12400) → "12.4k" · countFull → "12,400"
import { SOCIAL_PLATFORMS } from './canvass.js';

export const PLATFORMS = SOCIAL_PLATFORMS;
export const PLATFORM_WORD = {
  facebook: 'Facebook', instagram: 'Instagram', x: 'X', tiktok: 'TikTok', reddit: 'Reddit',
  youtube: 'YouTube', linkedin: 'LinkedIn', bluesky: 'Bluesky', threads: 'Threads', other: 'Other',
};
// The order the profile offers networks when a bare @name needs one.
export const CHIP_ORDER = ['instagram', 'x', 'tiktok', 'facebook', 'linkedin', 'youtube', 'bluesky', 'threads', 'reddit', 'other'];
export const platformWord = (p) => PLATFORM_WORD[p] || String(p || '');

export const SAY = {
  short: 'That’s a short link — open it and copy the profile address instead',
  post: 'That’s a link to a post, not a profile',
  shape: (p) => `That doesn’t look like ${['instagram', 'x', 'other'].includes(p) ? 'an' : 'a'} ${platformWord(p)} handle`,
  which: (name) => `Which network is @${name} on?`,
  other: 'For Other, paste a link that starts with https://',
  empty: 'Paste a link or @handle',
};

// Never a handle, on any network: the words a link has where a name would be.
const RESERVED = new Set(['people', 'pages', 'groups', 'watch', 'events', 'login', 'home', 'share', 'hashtag', 'intent',
  'explore', 'search', 'settings', 'profile', 'reel', 'reels', 'stories', 'marketplace', 'help', 'about', 'privacy', 'policies']);

const SHAPE = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  threads: /^[A-Za-z0-9._]{1,30}$/,
  x: /^[A-Za-z0-9_]{1,15}$/,
  tiktok: /^[A-Za-z0-9._]{2,24}$/,
  youtube: /^[A-Za-z0-9._-]{3,30}$/,
  reddit: /^[A-Za-z0-9_-]{3,20}$/,
  linkedin: /^[A-Za-z0-9-]{3,100}$/,
  facebook: /^[A-Za-z0-9.]{5,50}$/,
};
const bskyOk = (h) => h.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h);

// Hosts (after www./m./mobile.) → network; 'short' cannot be read without opening it.
const HOSTS = {
  'instagram.com': 'instagram', 'x.com': 'x', 'twitter.com': 'x', 'tiktok.com': 'tiktok',
  'threads.net': 'threads', 'threads.com': 'threads', 'bsky.app': 'bluesky', 'youtube.com': 'youtube',
  'linkedin.com': 'linkedin', 'reddit.com': 'reddit', 'old.reddit.com': 'reddit', 'new.reddit.com': 'reddit',
  'facebook.com': 'facebook', 'fb.com': 'facebook', 'web.facebook.com': 'facebook',
  'youtu.be': 'post', 'vm.tiktok.com': 'short', 'vt.tiktok.com': 'short', 'lnkd.in': 'short', 't.co': 'short',
};
const hostOf = (h) => {
  let host = h.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '').replace(/^(www\.|m\.)/, '');
  // ca.linkedin.com and the other country copies of LinkedIn.
  if (/^[a-z]{2}\.linkedin\.com$/.test(host)) host = 'linkedin.com';
  return HOSTS[host] || null;
};

const isLink = (v) => /^https:\/\//i.test(String(v || '').trim());
const handleOf = (platform, h) => {
  let name = String(h || '').trim().replace(/^@/, '');
  if (platform === 'reddit') name = name.replace(/^\/?u\//i, '');
  if (platform === 'bluesky') {
    name = name.toLowerCase();
    if (name && !name.includes('.')) name += '.bsky.social';
    return bskyOk(name) ? { platform, handle: name } : { error: SAY.shape(platform) };
  }
  if (RESERVED.has(name.toLowerCase())) return { error: SAY.post };
  return SHAPE[platform]?.test(name) ? { platform, handle: name } : { error: SAY.shape(platform) };
};
const kept = (platform, url) => ({ platform, handle: url });

// A link on a known host: its path says whose profile it is, or that it isn't one.
const fromLink = (platform, segs, query) => {
  const [a = '', b = '', c = ''] = segs;
  const la = a.toLowerCase();
  const post = { error: SAY.post };
  const named = (h) => (RESERVED.has(String(h).replace(/^@/, '').toLowerCase()) ? post : handleOf(platform, h));
  switch (platform) {
    case 'instagram':
      if (['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(la) || !a) return post;
      return named(a);
    case 'x':
      if (['i', 'home', 'search', 'hashtag', 'intent'].includes(la) || b.toLowerCase() === 'status' || !a) return post;
      return named(a);
    case 'tiktok':
      if (segs.some((s) => ['video', 'photo'].includes(s.toLowerCase()))) return post;
      if (la === 't') return { error: SAY.short };
      return a.startsWith('@') ? named(a) : post;
    case 'threads':
      if (!a.startsWith('@') || b.toLowerCase() === 'post') return post;
      return named(a);
    case 'bluesky':
      if (la !== 'profile' || !b || c.toLowerCase() === 'post') return post;
      if (/^did:(plc|web):[A-Za-z0-9._:-]+$/.test(b)) return kept(platform, `https://bsky.app/profile/${b}`);
      return named(b);
    case 'youtube':
      if (['watch', 'shorts', 'live', 'playlist'].includes(la) || !a) return post;
      if (a.startsWith('@')) return named(a);
      if (['channel', 'c', 'user'].includes(la) && /^[A-Za-z0-9._-]{1,100}$/.test(b)) return kept(platform, `https://www.youtube.com/${la}/${b}`);
      return post;
    case 'linkedin':
      if (la === 'in' && b) return named(b);
      if (la === 'company' && /^[A-Za-z0-9._-]{1,100}$/.test(b)) return kept(platform, `https://www.linkedin.com/company/${b}`);
      if (la === 'pub' && b && segs.every((s) => /^[A-Za-z0-9._-]{1,100}$/.test(s))) return kept(platform, `https://www.linkedin.com/${segs.join('/')}`);
      return post;
    case 'reddit':
      if ((la === 'user' || la === 'u') && b) return named(b);
      return post;
    case 'facebook': {
      if (la === 'profile.php') {
        const id = query.get('id');
        return /^\d{1,30}$/.test(id || '') ? kept(platform, `https://www.facebook.com/profile.php?id=${id}`) : post;
      }
      if ((la === 'people' || la === 'pages') && b && /^\d{1,30}$/.test(c) && segs.length === 3
        && /^[^/?#\s]{1,100}$/.test(b)) return kept(platform, `https://www.facebook.com/${la}/${b}/${c}`);
      if (!a || segs.length > 1) return post;
      if (['photo', 'photo.php', 'story.php', 'permalink.php', 'home.php'].includes(la)) return post;
      return named(a);
    }
    default:
      return post;
  }
};

export const parseSocial = (text, hint) => {
  const s = String(text ?? '').trim();
  const want = PLATFORMS.includes(hint) ? hint : null;
  if (!s) return { error: SAY.empty };
  // A link: a scheme, or a known host at the start (instagram.com/lin).
  const m = /^(?:https?:\/\/)?([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?(\/[^\s]*)?$/i.exec(s);
  const schemed = /^https?:\/\//i.test(s);
  const network = m ? hostOf(m[1]) : null;
  if (m && network) {
    if (network === 'short') return { error: SAY.short };
    if (network === 'post') return { error: SAY.post };
    const rest = (m[2] || '').replace(/#.*$/, '');
    const [path, qs = ''] = rest.split('?');
    let segs;
    try { segs = path.split('/').filter(Boolean).map((x) => decodeURIComponent(x)); } catch { return { error: SAY.shape(network) }; }
    return fromLink(network, segs, new URLSearchParams(qs));
  }
  if (schemed) {
    // Somewhere that isn't a network base.win knows: kept as a link under Other.
    if (want && want !== 'other') return { error: SAY.shape(want) };
    if (!m || /[\s<>"\\]/.test(s)) return { error: SAY.other };
    return kept('other', s.replace(/^http:\/\//i, 'https://'));
  }
  if (want === 'other') return { error: SAY.other };
  const name = s.replace(/^@/, '');
  if (/\.bsky\.social$/i.test(name)) return handleOf('bluesky', name);
  if (!want) {
    if (!/^(\/?u\/)?[A-Za-z0-9._-]{1,100}$/.test(name)) return { error: SAY.empty };
    return { error: SAY.which(name), ask: true };
  }
  return handleOf(want, name);
};

const norm = (v) => {
  const t = String(v ?? '').trim();
  return (isLink(t) ? t.replace(/\/+$/, '') : t.replace(/^@/, '').replace(/^\/?u\//i, '')).toLowerCase();
};
export const sameHandle = (a, b) => {
  const x = norm(a);
  return x !== '' && x === norm(b);
};

const BASE = {
  instagram: (h) => `https://www.instagram.com/${h}`,
  x: (h) => `https://x.com/${h}`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  threads: (h) => `https://www.threads.com/@${h}`,
  bluesky: (h) => `https://bsky.app/profile/${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
  linkedin: (h) => `https://www.linkedin.com/in/${h}`,
  reddit: (h) => `https://www.reddit.com/user/${h}`,
  facebook: (h) => `https://www.facebook.com/${h}`,
};
// Old values (saved before the parser) are read as well as they can be:
// one that parses opens its profile; a link opens as it was; anything else
// is guessed from the network, as the profile always did.
export const profileUrl = (platform, value) => {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (isLink(v)) return v;
  const r = parseSocial(v, platform);
  if (r.handle) return isLink(r.handle) ? r.handle : BASE[r.platform]?.(encodeURIComponent(r.handle)) ?? null;
  if (/^http:\/\//i.test(v)) return v;
  const h = v.replace(/^@/, '').replace(/^\/?u\//i, '');
  return BASE[platform] && /^[^\s/?#]+$/.test(h) ? BASE[platform](encodeURIComponent(h)) : null;
};
export const shownHandle = (platform, value) => {
  const v = String(value ?? '').trim();
  const r = parseSocial(v, platform);
  if (r.handle) return isLink(r.handle) ? 'Profile link' : `@${r.handle}`;
  return v;
};

// "12k", "12,400", "1.2m", "900", "12 400 followers" → an integer; anything else null.
export const parseCount = (text) => {
  let s = String(text ?? '').trim().toLowerCase().replace(/\s*followers?$/, '').replace(/[\s\u00a0]/g, '');
  if (!s) return null;
  if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1));
  return Number.isSafeInteger(n) ? n : null;
};
// 900 · 12.4k · 1.2m — cut, not rounded up (999,950 is 999.9k, not "1000k").
export const countWord = (n) => {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const one = (x) => String(Math.floor(x * 10) / 10);
  if (v < 1000) return String(v);
  if (v < 1e6) return `${one(v / 1e3)}k`;
  return `${one(v / 1e6)}m`;
};
export const countFull = (n) => Math.floor(Number(n) || 0).toLocaleString('en-CA');

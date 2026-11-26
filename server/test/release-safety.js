// Release safety: what a release may run against a client's database when it
// starts, and how render.yaml may set a service's settings. A release
// replaces the app only; it never erases a client's data or changes its
// settings in Render (GOING-LIVE.md section 0). Used by
// server/test/release-safety.test.js, server/test/release-settings.test.js
// and apps/platform/test/release-safety.test.mjs.

// ---------------------------------------------------------------------------
// Start-up SQL
// ---------------------------------------------------------------------------

// Statements that may run at start-up although they remove or rewrite
// something, each looked at and agreed. Keep this list short: every entry is
// a statement that runs against every client's database at every start.
// `statement` is the statement as normalize() gives it (lower case, one
// space between words, no comments, no closing semicolon).
export const ALLOWED_AT_START = [
  {
    source: 'apps/platform/db.sql',
    statement: "delete from checks where via = 'door'",
    why: 'The control centre\'s own health-check log, not a client\'s data: removes the checks of the old "door" address (replaced on 24 Nov 2026, b26bb90). It runs only while the old rule is still on the table, so once per database.',
  },
  {
    source: 'apps/platform/db.sql',
    statement: 'alter table checks drop column if exists door_key',
    why: 'The control centre\'s own health-check log, not a client\'s data: door_key said whether the old door\'s key was set. Nothing has read or written it since b26bb90.',
  },
];

// SQL with its comments taken out, in lower case, one space between words.
// Quoted text is kept as it is written (a statement run through EXECUTE is
// quoted text, and is looked at too).
export const normalize = (sql) => {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      const stop = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i += 1;
    }
  }
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
};

// The parts of an ALTER TABLE after the table's name, split at the commas
// between them (not the ones inside brackets or quotes).
const actionsOf = (rest) => {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of rest) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && depth === 0 && ch === ',') { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
};

const IDENT = String.raw`(?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?`;
const ALTER_TABLE = new RegExp(String.raw`\balter table (?:if exists )?(?:only )?${IDENT}\*? `, 'g');

// What an ALTER TABLE's part does that a release must not, or null.
const alterKind = (action) => {
  if (/^drop (?!constraint\b)/.test(action)) return 'DROP COLUMN';
  if (/^alter (?:column )?(?:"[^"]+"|[\w$]+) (?:set data )?type\b/.test(action)) return 'ALTER COLUMN ... TYPE';
  if (/^rename to\b/.test(action)) return 'RENAME TABLE';
  if (/^rename (?!constraint\b)/.test(action)) return 'RENAME COLUMN';
  return null;
};

// Every statement in `sql` that would remove or rewrite data or the shape
// it is kept in: [{ kind, statement }].
export const destructive = (sql) => {
  const found = [];
  for (const piece of normalize(sql).split(';').map((s) => s.trim()).filter(Boolean)) {
    const at = (re, kind) => {
      for (const m of piece.matchAll(re)) found.push({ kind, statement: piece.slice(m.index).trim() });
    };
    at(/\bdrop table\b/g, 'DROP TABLE');
    at(/\bdrop schema\b/g, 'DROP SCHEMA');
    at(/\bdrop database\b/g, 'DROP DATABASE');
    at(/\btruncate\b/g, 'TRUNCATE');
    for (const m of piece.matchAll(/\bdelete from\b/g)) {
      const statement = piece.slice(m.index).trim();
      found.push({ kind: /\bwhere\b/.test(statement) ? 'DELETE' : 'DELETE without WHERE', statement });
    }
    for (const m of piece.matchAll(ALTER_TABLE)) {
      const statement = piece.slice(m.index).trim();
      for (const action of actionsOf(piece.slice(m.index + m[0].length))) {
        const kind = alterKind(action);
        if (kind) found.push({ kind, statement });
      }
    }
  }
  return found;
};

// [{ source, sql }] → the destructive statements not on ALLOWED_AT_START.
export const problemsIn = (sources, allowed = ALLOWED_AT_START) => {
  const ok = new Set(allowed.map((a) => `${a.source}\n${a.statement}`));
  return sources.flatMap(({ source, sql }) => destructive(sql)
    .filter((f) => !ok.has(`${source}\n${f.statement}`))
    .map((f) => ({ source, ...f })));
};

// The allowed statements no longer in their source (the list must stay true).
export const staleAllowed = (sources, allowed = ALLOWED_AT_START) => allowed.filter((a) => !sources
  .some(({ source, sql }) => source === a.source && destructive(sql).some((f) => f.statement === a.statement)));

export const explainProblems = (problems) => problems.map((p) => [
  `${p.source} runs this at start-up (${p.kind}):`,
  `  ${p.statement}`,
].join('\n')).join('\n') + `

A release replaces the app only. It must never remove or rewrite data
already kept (GOING-LIVE.md section 0), and this runs on the live database
(every client's, or the control centre's) the moment the release starts.
What to do instead: add a new column or table and leave the old one where
it is; stop reading the old one in the code.
If it truly has to run: get the owner's OK first, then add the exact
statement above to ALLOWED_AT_START in server/test/release-safety.js with a
one-line reason.`;

// ---------------------------------------------------------------------------
// render.yaml
// ---------------------------------------------------------------------------

// A small reader for the part of YAML render.yaml uses: maps, lists of maps,
// plain, quoted and numeric values, and comments. Anything else (a value
// over several lines, [ ] or { } lists, anchors) is an error, never a guess.
export const parseYaml = (text) => {
  const lines = [];
  text.split('\n').forEach((raw, i) => {
    let line = '';
    let q = null;
    for (const ch of raw) {
      if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '#' && (!line || /\s$/.test(line))) break;
      line += ch;
    }
    line = line.replace(/\s+$/, '');
    if (!line.trim()) return;
    if (/\t/.test(line.match(/^\s*/)[0])) throw new Error(`render.yaml line ${i + 1}: a tab in the indent`);
    lines.push({ n: i + 1, indent: line.search(/\S/), text: line.trim() });
  });
  const scalar = (v, n) => {
    if (v === '') return null;
    if (/^"/.test(v)) return JSON.parse(v);
    if (/^'/.test(v)) { if (!/'$/.test(v)) throw new Error(`render.yaml line ${n}: unclosed quote`); return v.slice(1, -1).replace(/''/g, "'"); }
    if (/^[[{&*!|>]/.test(v)) throw new Error(`render.yaml line ${n}: "${v}" is more YAML than this reader knows`);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  };
  let i = 0;
  const block = (indent) => {
    if (i >= lines.length || lines[i].indent < indent) return null;
    const ind = lines[i].indent;
    if (lines[i].text.startsWith('- ') || lines[i].text === '-') {
      const list = [];
      while (i < lines.length && lines[i].indent === ind && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
        const { n, text } = lines[i];
        const rest = text.slice(1).trim();
        if (!rest) { i += 1; list.push(block(ind + 1)); continue; }
        if (!/^[\w.-]+:(\s|$)/.test(rest)) { list.push(scalar(rest, n)); i += 1; continue; }
        // "- key: value": a map whose keys line up two past the dash.
        lines[i] = { n, indent: ind + 2, text: rest };
        list.push(map(ind + 2));
      }
      return list;
    }
    return map(ind);
  };
  const map = (ind) => {
    const out = {};
    while (i < lines.length && lines[i].indent === ind && !lines[i].text.startsWith('- ')) {
      const { n, text } = lines[i];
      const m = /^([\w.-]+):(?:\s+(.*))?$/.exec(text);
      if (!m) throw new Error(`render.yaml line ${n}: expected "name: value", found "${text}"`);
      if (Object.hasOwn(out, m[1])) throw new Error(`render.yaml line ${n}: ${m[1]} twice`);
      i += 1;
      if (m[2] !== undefined && m[2] !== '') out[m[1]] = scalar(m[2], n);
      else out[m[1]] = (i < lines.length && (lines[i].indent > ind || (lines[i].indent === ind && lines[i].text.startsWith('- ')))) ? block(lines[i].indent) : null;
    }
    if (i < lines.length && lines[i].indent > ind) throw new Error(`render.yaml line ${lines[i].n}: indented more than the line before`);
    return out;
  };
  const doc = block(0);
  if (i < lines.length) throw new Error(`render.yaml line ${lines[i].n}: not read`);
  return doc;
};

// Settings render.yaml may give a fixed value, per service: values that are
// the same on every deployment of that service. A Blueprint sync writes a
// fixed value over whatever the service has in Render, so a client's own
// setting (its name, addresses, brand, map area, rules, keys) is never one:
// it is `sync: false`, set once in Render and kept there.
export const FIXED_OK = {
  // Every client's campaign server (base-win, and any base-win-<name>).
  production: {
    NODE_ENV: 'Always production on Render: the server\'s own mode, not the campaign\'s.',
    STARBASE_ENV: 'Always production on a client\'s service: it is what makes it production (the badge, /api/health).',
  },
  // Staging is base.win's own sample campaign and public demo, not a
  // client's: render.yaml is where its values live, so a sync resetting them
  // is what we want.
  staging: {
    NODE_ENV: 'Always production on Render: the server\'s own mode.',
    STARBASE_ENV: 'Always staging on the staging service.',
    STARBASE_BRAND: 'base.win\'s own look on the demo, never a client\'s.',
    STARBASE_ORG_NAME: 'The made-up sample campaign\'s name.',
    STARBASE_JURISDICTION: 'The sample runs under the rules a B.C. municipal client does, so staging tests what production does.',
    STARBASE_TZ: 'The sample campaign\'s time zone.',
    STARBASE_CITY: 'The sample campaign\'s city.',
    STARBASE_GEO_BOUNDS: 'The sample campaign\'s map area.',
    STARBASE_SLATES: 'The sample campaign\'s slates.',
    STARBASE_FRAME_HOSTS: 'base.win\'s own website, which frames the demo.',
    STARBASE_DEMO_EMAIL: 'The demo account, the sample campaign\'s manager, on base.win\'s domain.',
    STARBASE_SAMPLE: 'Makes the sample campaign on an empty staging database.',
    STARBASE_CANDIDATES: 'The sample\'s made-up opponents.',
  },
  // The control centre: there is one, at ops.base.win.
  platform: {
    NODE_VERSION: 'The Node version Render runs it on: the same 22 as CI and the Dockerfile.',
    NODE_ENV: 'Always production on Render.',
    OPS_HOST: 'There is one control centre, and this is its address.',
  },
};

// Which list a service in render.yaml goes by, or null for one this check
// does not know (a new kind of service must be added here first).
export const kindOf = (service) => {
  if (service.name === 'base-platform') return 'platform';
  if (service.name === 'base-win-staging') return 'staging';
  if (service.name === 'base-win' || /^base-win-[a-z0-9-]+$/.test(service.name)) return 'production';
  return null;
};

// How an envVar gets its value: 'sync' | 'generated' | 'linked' | 'fixed' | null.
export const howSet = (v) => {
  if (v.sync === false) return 'sync';
  if (v.generateValue === true) return 'generated';
  if (v.fromDatabase || v.fromService || v.fromGroup) return 'linked';
  if (Object.hasOwn(v, 'value')) return 'fixed';
  return null;
};

// The envVars render.yaml would let a sync overwrite on a service where it
// should not: [{ service, key, problem }].
export const settingProblems = (doc) => {
  const out = [];
  for (const s of doc.services || []) {
    const kind = kindOf(s);
    if (!kind) { out.push({ service: s.name, key: '', problem: 'a service this check does not know: add it to kindOf() in server/test/release-safety.js' }); continue; }
    const seen = new Set();
    for (const v of s.envVars || []) {
      if (seen.has(v.key)) out.push({ service: s.name, key: v.key, problem: 'listed twice' });
      seen.add(v.key);
      const how = howSet(v);
      if (!how) out.push({ service: s.name, key: v.key, problem: 'no value, no sync: false, nothing generated or linked' });
      else if (how === 'fixed' && !FIXED_OK[kind][v.key]) out.push({ service: s.name, key: v.key, problem: `a fixed value (${JSON.stringify(v.value)}) that a Blueprint sync would write over this service's own` });
    }
  }
  return out;
};

export const explainSettings = (problems) => problems.map((p) => `${p.service} ${p.key}: ${p.problem}`).join('\n') + `

A Blueprint sync writes every fixed value in render.yaml over what the
service has in Render. A client's own setting (its name, addresses, brand,
map area, rules or keys) set this way would be lost at the next sync.
What to do: write it as "sync: false" and set it once in Render, on that
service. If it truly is the same on every deployment of that service, add
it to FIXED_OK in server/test/release-safety.js with a one-line reason.`;

// What a campaign's database still holds of Imagine Surrey's lists.
//
// A campaign set up today on any other server starts with the product's own
// ten fields and general lists. One set up before that was so was given
// Imagine Surrey's: its 27 fields, its Language, Faith, Campus and Interests
// lists, and perhaps its sample people. Nothing removes those on its own —
// they are the campaign's rows now, and it may be using them. This lists
// them, campaign by campaign, so a manager can take off what they don't
// want: a field under People → More → Profile fields, the sample with
// Today → Clear sample data.
//
// It only reads. Run it where the server runs (it lives under server/
// because that is what the image holds), with the server's own DATABASE_URL:
//
//   node server/neutral-report.mjs
//
// For each campaign:
//   fields   fields named as one of Imagine Surrey's standard fields that
//            the product's own set does not have (Home phone, Campus, …),
//            with how many people have each filled in
//   lists    a field whose whole list of choices is one of Imagine Surrey's
//            (Language, Faith, Campus, Interests), or that still has some of
//            its Campus or Interests choices
//   sample   how many sample people are loaded, or nothing
import { fileURLToPath } from 'node:url';
import { presetFor } from './lib/preset.js';
import { NEUTRAL_FIELDS } from './ext/fields/people.js';
import { choicesOf, nameKey } from './ext/fields/kinds.js';

const KIND = { text: 'Text', note: 'Long text', yesno: 'Yes/No', choice: 'Pick one', choices: 'Pick several', number: 'Number', date: 'Date' };
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const parse = (v) => { if (typeof v !== 'string') return v || {}; try { return JSON.parse(v) || {}; } catch { return {}; } };

// db: anything with query(sql, params) → { rows }.
// → [{ id, name, fields: [{ name, kind, off, filled }], lists: [{ field, whole, choices }], sample }]
export const neutralReport = async (db) => {
  const theirs = presetFor('imagine-surrey').fields;
  const general = new Set(NEUTRAL_FIELDS.map((f) => nameKey(f.name)));
  const onlyTheirs = new Map(theirs.standard.filter((f) => !general.has(nameKey(f.name))).map((f, i) => [nameKey(f.name), i]));
  const wholeLists = [theirs.languages, theirs.faiths, theirs.campuses, theirs.interests];
  const ownChoices = new Set([...theirs.campuses, ...theirs.interests]);

  const workspaces = (await db.query('select id, name, settings from workspaces order by created_at, id')).rows;
  const fields = (await db.query(
    `select f.id, f.workspace_id, f.name, f.kind, f.choices, f.position, f.retired_at,
            (select count(*)::int from person_field_values v where v.workspace_id = f.workspace_id and v.field_id = f.id) as filled
       from person_fields f order by (f.retired_at is not null), f.position, f.created_at`,
  )).rows;
  return workspaces.map((w) => {
    const mine = fields.filter((f) => f.workspace_id === w.id);
    const named = mine.filter((f) => onlyTheirs.has(nameKey(f.name)))
      .sort((a, b) => onlyTheirs.get(nameKey(a.name)) - onlyTheirs.get(nameKey(b.name)))
      .map((f) => ({ name: f.name, kind: f.kind, off: Boolean(f.retired_at), filled: f.filled }));
    const lists = mine.map((f) => {
      const choices = choicesOf(f);
      if (!choices.length) return null;
      if (wholeLists.some((l) => same(l, choices))) return { field: f.name, whole: true, choices };
      const found = choices.filter((c) => ownChoices.has(c));
      return found.length ? { field: f.name, whole: false, choices: found } : null;
    }).filter(Boolean);
    const sample = parse(w.settings).sample;
    return { id: w.id, name: w.name, fields: named, lists, sample: sample ? (sample.ids?.persons?.length ?? 0) : null };
  });
};

// The report in words, a line at a time.
export const reportLines = (report) => {
  const out = [];
  for (const w of report) {
    out.push(`${w.name} (${w.id})`);
    if (!w.fields.length && !w.lists.length && w.sample === null) { out.push('  Nothing here matches Imagine Surrey’s lists.'); continue; }
    if (w.fields.length) {
      out.push(`  Fields named as in Imagine Surrey’s set (${w.fields.length}):`);
      for (const f of w.fields) out.push(`    ${f.name} (${KIND[f.kind] || f.kind}, ${people(f.filled)})${f.off ? ' — taken off' : ''}`);
    }
    for (const l of w.lists) {
      out.push(l.whole
        ? `  ${l.field}: the whole list is Imagine Surrey’s (${l.choices.length} choices)`
        : `  ${l.field}: ${l.choices.length} of its choices ${l.choices.length === 1 ? 'is' : 'are'} Imagine Surrey’s — ${l.choices.join('; ')}`);
    }
    if (w.sample !== null) out.push(`  Sample data is loaded (${people(w.sample)}).`);
  }
  if (report.some((w) => w.fields.length || w.lists.length || w.sample !== null)) {
    out.push('');
    out.push('Nothing was changed. To take a field off or change a list: People → More → Profile fields.');
    out.push('To remove the sample: Today → Clear sample data. A field people have filled in keeps what they said.');
  }
  return out;
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('Set DATABASE_URL to the campaign’s database (the same value its server has), then run this again.');
    process.exit(2);
  }
  const { default: pg } = await import('pg');
  const ssl = /sslmode=(require|verify)/.test(url) || process.env.PGSSL === '1' ? { rejectUnauthorized: process.env.PGSSL_STRICT === '1' } : undefined;
  const client = new pg.Client({ connectionString: url, ssl });
  await client.connect();
  try {
    // Read only, whatever happens: the database refuses a write in here.
    await client.query('begin transaction read only');
    const report = await neutralReport({ query: async (text, params = []) => ({ rows: (await client.query(text, params)).rows }) });
    for (const line of reportLines(report)) console.log(line);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

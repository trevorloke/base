// Where profile fields meet the rest of the people tools (lib/hooks.js):
//
//   personsWhere   GET /persons?field=<field id>:<value> — People (and the
//                  Call / Text lists it opens) narrowed to one field's value,
//                  ":*" for "filled in". Text matches in any case; the value
//                  is read like any other (yes · no, a choice in any case).
//                  A volunteer's list never matches on a field volunteers
//                  can't see — the result itself would tell them who has it.
//   importRows     POST /data/import: a row's `fields` ({ "<field name or
//                  id>": "<cell>" }, names in any case) are checked like a
//                  profile save — a cell that doesn't fit refuses the row,
//                  with its row number, like a bad email. A person on file
//                  gets only the fields still blank (an import never
//                  overwrites); a new person gets them all. A cell for a
//                  field taken off is passed over (nothing to fill).
//   sampleLoaded   the sample's own fields and a few values (a campaign whose
//                  server has a sample: lib/preset.js)
//   sampleCleared  removes exactly those; a sample field you filled in for
//                  your own people stays (no longer sample), and says so.
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { preset } from '../../lib/preset.js';
import { FAITHS, DWELLING_TYPES, LANGUAGES, groupMembers } from '@starbase/shared/fieldlists';
import { FIELDS_MAX, choicesOf, nameKey, parseValue, valueError } from './kinds.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const personsWhere = async (db, ctx, query, w) => {
  const raw = String(query?.field ?? '').trim();
  if (!raw) return;
  const at = raw.indexOf(':');
  const id = at < 0 ? raw : raw.slice(0, at);
  const want = at < 0 ? '*' : raw.slice(at + 1);
  const none = () => { w.where += ' and false'; };
  if (!UUID_RE.test(id)) return none();
  const f = (await db.query(
    'select * from person_fields where id = $1 and workspace_id = $2 and retired_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!f || (ctx.role === 'volunteer' && !f.volunteers)) return none();
  // A Private field never picks people for anyone outside the office
  // (ctx.forOthers — ext/lists audience.js): refused where a person hands
  // the list on, nobody where it is read again later for someone else.
  if (f.sensitive && ctx.forOthers === 'refuse') throw httpError(409, handOnRefusal(f.name));
  if (f.sensitive && ctx.forOthers) return none();
  // "Christian – *": any choice in that group (shared/fieldlists.js).
  const group = f.kind === 'choice' ? groupMembers(choicesOf(f), want) : null;
  // Every param pushed must be used: check the value before pushing any.
  const p = want === '*' || group ? null : parseValue(f, want);
  if (p && (p.error || p.empty)) return none();
  if (group && !group.length) return none();
  w.params.push(f.id);
  const fid = `$${w.params.length}`;
  let match = '';
  if (group) {
    w.params.push(JSON.stringify(group));
    match = ` and v.value in (select jsonb_array_elements($${w.params.length}::jsonb))`;
  } else if (p) {
    if (f.kind === 'text') {
      w.params.push(String(p.value).toLowerCase());
      match = ` and lower(v.value #>> '{}') = $${w.params.length}`;
    } else if (f.kind === 'note') {
      // Long text: the words anywhere in it.
      w.params.push(`%${String(p.value).toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      match = ` and lower(v.value #>> '{}') like $${w.params.length}`;
    } else if (f.kind === 'choices') {
      // Pick several: everyone with that choice among theirs.
      w.params.push(JSON.stringify(p.value));
      match = ` and v.value @> $${w.params.length}::jsonb`;
    } else {
      w.params.push(JSON.stringify(p.value));
      match = ` and v.value = $${w.params.length}::jsonb`;
    }
  }
  w.where += ` and exists (select 1 from person_field_values v
    where v.workspace_id = p.workspace_id and v.person_id = p.id and v.field_id = ${fid}${match})`;
  return undefined;
};

export const handOnRefusal = (name) => `This list picks people by ${name}, which is private — it can’t be walked, called, sent to CallHub, emailed, texted or copied.`;
// A field being turned into a list (actions.js field.list.start) takes no
// new words until it is done.
export const convertingRefusal = (name) => `“${name}” is being turned into a list — try again later`;

export const importRows = async (db, ctx, extras) => {
  const ws = ctx.workspaceId;
  const all = (await db.query('select * from person_fields where workspace_id = $1', [ws])).rows;
  const fields = all.filter((f) => !f.retired_at);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [nameKey(f.name), f]));
  // A field taken off (perhaps while this import was being set up) has
  // nothing to fill: its cells are passed over, the row still comes in.
  const offIds = new Set(all.filter((f) => f.retired_at).map((f) => f.id));
  const offNames = new Set(all.filter((f) => f.retired_at).map((f) => nameKey(f.name)));
  // Blanks only: what is already filled in, person|field — read a person at a
  // time, when a row first brings them a value (never the whole workspace).
  const filled = new Set();
  const read = new Set();
  const queued = []; // [id, field_id, person_id, value] for new people (finish)
  const readFilled = async (tx, personId) => {
    if (read.has(personId)) return;
    read.add(personId);
    for (const r of (await tx.query(
      'select field_id from person_field_values where workspace_id = $1 and person_id = $2', [ws, personId],
    )).rows) filled.add(`${personId}|${r.field_id}`);
  };
  extras.push({
    // → { value: [{ f, value }] } | { error } (the row is refused).
    check(raw) {
      const given = raw?.fields;
      if (given === undefined || given === null) return { value: [] };
      if (typeof given !== 'object' || Array.isArray(given)) return { error: 'fields: not readable' };
      const out = [];
      for (const [key, cell] of Object.entries(given)) {
        const f = byId.get(key) || byName.get(nameKey(key));
        if (!f && (offIds.has(key) || offNames.has(nameKey(key)))) continue;
        // Never an id on screen: one that names no field here is a field since removed.
        if (!f && UUID_RE.test(key)) return { error: 'a profile field in this import was removed — set its column to Don’t import' };
        if (!f) return { error: `there’s no field called “${String(key).slice(0, 60)}”` };
        if (out.some((o) => o.f.id === f.id)) return { error: `“${f.name}” is in two columns` };
        if (f.converting) return { error: convertingRefusal(f.name) };
        const p = parseValue(f, typeof cell === 'number' || typeof cell === 'boolean' || cell === null ? cell : String(cell ?? ''));
        if (p.error) return { error: valueError(f, p.error) };
        if (!p.empty) out.push({ f, value: p.value });
      }
      return { value: out };
    },
    // → the names of the fields it filled (or would, in the dry run).
    // fresh: a person this import just added — nothing of theirs is filled
    // yet, so nothing is read, and the values are written in batches when
    // the chunk is done (finish), not one round trip each.
    async apply(tx, personId, values, { write, fresh = false }, emit) {
      const names = [];
      if (values?.length && !fresh) await readFilled(tx, personId);
      for (const { f, value } of values || []) {
        const key = `${personId}|${f.id}`;
        if (filled.has(key)) continue;
        filled.add(key);
        if (write && fresh) {
          const id = newId();
          queued.push([id, f.id, personId, JSON.stringify(value)]);
          emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: personId, value, source: 'import' });
        } else if (write) {
          const id = newId();
          const row = (await tx.query(
            `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
             values ($1, $2, $3, $4, $5, $6) on conflict (field_id, person_id) do nothing returning id`,
            [id, ws, f.id, personId, JSON.stringify(value), ctx.user?.id || null],
          )).rows[0];
          if (!row) continue; // filled in meanwhile: theirs stays
          emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: personId, value, source: 'import' });
        }
        names.push(f.name);
      }
      return names;
    },
    // The new people’s values, 250 to a statement (kept small: an embedded database has a modest wire buffer).
    async finish(tx) {
      for (let i = 0; i < queued.length; i += 250) {
        const part = queued.slice(i, i + 250);
        await tx.query(
          `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
           select v.id, $1, v.field_id, v.person_id, v.value::jsonb, $2
             from unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::text[]) as v(id, field_id, person_id, value)`,
          [ws, ctx.user?.id || null, part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2]), part.map((r) => r[3])],
        );
      }
      queued.length = 0;
    },
  });
};

// ── The sample campaign ──
// The fields a sample brings, with who has what (its made-up people, by
// name): the sample's own, so only a campaign whose server has one.
const sampleFields = () => preset().sample?.fields ?? [];

// The fields that describe a door, not the person: a move takes them off
// (they describe the old door) and Undo puts them back (ext/moves). By name,
// lower case, as the standard fields name them.
export const DOOR_FIELDS = ['house notes', 'building notes', 'access type', 'dwelling type'];
// The same as SQL over person_fields alias f ($n: DOOR_FIELDS): one of them,
// or the "<name> as written" field that keeps a door field's words since it
// became a list ("Dwelling type as written" describes the old door too).
export const doorFieldSql = (f, n) => `(lower(${f}.name) = any(${n}::text[]) or ${f}.as_written_of in (
  select d.id from person_fields d where d.workspace_id = ${f}.workspace_id and lower(d.name) = any(${n}::text[])))`;

// The standard fields every campaign starts with: the ten the product
// itself looks for by name — the door's four (a move clears them), the two
// opt-ins (a website form sets them), Language (the voter guide's
// language), Notes, Faith (private) and the candidate report's tick. Made
// when the campaign is set up (workspaceCreated) and by field.standard
// (Profile fields → Add the standard fields) for a campaign set up before
// they existed; a field of the same name already there is left as it is.
export const NEUTRAL_FIELDS = Object.freeze([
  { name: 'House notes', kind: 'text', volunteers: true },
  { name: 'Building notes', kind: 'text', volunteers: true },
  { name: 'Access type', kind: 'text', volunteers: true },
  { name: 'Dwelling type', kind: 'choice', choices: DWELLING_TYPES, display: 'list', volunteers: true },
  { name: 'Email opt-in', kind: 'yesno', volunteers: false },
  { name: 'SMS opt-in', kind: 'yesno', volunteers: false },
  { name: 'Language', kind: 'choices', choices: LANGUAGES, volunteers: true },
  { name: 'Notes', kind: 'note', volunteers: false },
  // Private: the office only, and only what the person says (README).
  { name: 'Faith', kind: 'choice', choices: FAITHS, sensitive: true, volunteers: false },
  { name: 'Interested in being a candidate', kind: 'yesno', volunteers: false },
]);
// A campaign with a set-up of its own (lib/preset.js) has its own set
// instead, with its own lists. Asked each time: the brand is a setting.
export const standardFields = () => preset().fields.standard ?? NEUTRAL_FIELDS;

// → the fields added ({ id, name, kind }); none when every one is there.
// auto (the membership form, on every entry): only a field this campaign
// has never had — none live or taken off by that name, and not one it was
// given before (fields_seeded) — so a rename or a take-off is never undone.
// Otherwise (a new campaign, a manager's "Add the standard fields"):
// anything missing by name on the profile.
export const addStandardFields = async (tx, ctx, emit, { auto = false } = {}) => {
  const ws = ctx.workspaceId;
  const all = (await tx.query('select * from person_fields where workspace_id = $1', [ws])).rows;
  const live = all.filter((f) => !f.retired_at);
  const seeded = auto ? new Set((await tx.query('select name from fields_seeded where workspace_id = $1', [ws])).rows.map((r) => nameKey(r.name))) : new Set();
  const had = auto ? all : live;
  let top = live.reduce((m, f) => Math.max(m, f.position), -1);
  let count = live.length;
  const added = [];
  for (const s of standardFields()) {
    if (had.some((x) => nameKey(x.name) === nameKey(s.name)) || seeded.has(nameKey(s.name))) continue;
    if (count >= FIELDS_MAX) break;
    top += 1; count += 1;
    const f = {
      id: newId(), name: s.name, kind: s.kind, choices: s.choices || [], volunteers: s.volunteers, position: top,
      display: s.display || 'buttons', sensitive: !!s.sensitive,
    };
    await tx.query(
      `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, display, sensitive, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [f.id, ws, f.name, f.kind, JSON.stringify(f.choices), f.volunteers, f.position, f.display, f.sensitive, ctx.user?.id || null],
    );
    emit('person_field', f.id, 'create', { ...f, standard: true });
    added.push({ id: f.id, name: f.name, kind: f.kind });
  }
  return added;
};
// The seeds a campaign set up today already has: the standard fields it
// was given, and the marker of every field or list a start-up could give a
// campaign from before (sql.js) — whether or not this campaign was given
// that field. So no later start-up, job or change of brand ever adds one.
export const LIST_SEEDS = { Faith: 'Faith', 'Dwelling type': 'Dwelling type list', Campus: 'Campus list' };
// The names sql.js looks for before it adds a field (its two marker inserts).
export const BOOT_SEEDS = [
  'Voter eligibility', 'Language', 'Notes',
  'Gender', 'Birth date', 'Citizenship', 'Union member', 'Union local', 'Campus', 'Other language', 'Interests', 'Interested in being a candidate',
];
const seed = (tx, ws, names) => tx.query(
  'insert into fields_seeded (workspace_id, name) select $1, unnest($2::text[]) on conflict do nothing', [ws, names],
);
export const workspaceCreated = async (tx, ctx, { emit }) => {
  const added = await addStandardFields(tx, ctx, emit);
  await seed(tx, ctx.workspaceId, [...new Set([...added.map((f) => f.name), ...BOOT_SEEDS, ...Object.values(LIST_SEEDS)])]);
  return added;
};

// The profile fields a download carries as columns, in order: every live
// one, leaving out Private ones unless privateToo (a manager who asked).
export const fieldColumns = async (db, ws, { privateToo = false } = {}) => (await db.query(
  `select id, name, kind from person_fields where workspace_id = $1 and retired_at is null
     ${privateToo ? '' : 'and not sensitive'} order by position, created_at`, [ws],
)).rows;
// The ids of the Private fields (taken off too), with the "as written"
// fields kept for them: what a non-manager's backup and event log leave out.
export const privateFieldIds = async (db, ws) => (await db.query(
  `select id, name from person_fields where workspace_id = $1 and (sensitive or as_written_of in (
     select id from person_fields where workspace_id = $1 and sensitive))`, [ws],
)).rows;

// The fields Turn into a list upgrades a campaign from before (index.js
// fields.lists): Faith added, an empty Text Dwelling type and Campus made
// lists. Each step once (fields_seeded), all through the event log.
// Only on a server whose own set-up gives campaigns from before their
// fields (lib/preset.js fields.bootBackfill), with that set-up's lists; on
// any other server it does nothing.
export const upgradeLists = async (tx, ctx, emit) => {
  const own = preset().fields;
  if (!own.bootBackfill) return [];
  const ws = ctx.workspaceId;
  const seeded = new Set((await tx.query('select name from fields_seeded where workspace_id = $1', [ws])).rows.map((r) => r.name));
  const all = (await tx.query('select * from person_fields where workspace_id = $1 for update', [ws])).rows;
  const live = all.filter((f) => !f.retired_at);
  const done = [];
  if (!seeded.has('Faith')) {
    const s = standardFields().find((x) => x.name === 'Faith');
    if (!all.some((f) => nameKey(f.name) === 'faith') && live.length < FIELDS_MAX - 2) {
      const top = live.reduce((m, f) => Math.max(m, f.position), -1) + 1;
      const f = { id: newId(), name: s.name, kind: s.kind, choices: s.choices, volunteers: false, position: top, display: 'buttons', sensitive: true };
      await tx.query(
        `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, display, sensitive)
         values ($1, $2, $3, $4, $5, false, $6, 'buttons', true)`,
        [f.id, ws, f.name, f.kind, JSON.stringify(f.choices), f.position],
      );
      emit('person_field', f.id, 'create', { ...f, standard: true });
      done.push('Faith');
    } else if (all.some((f) => nameKey(f.name) === 'faith')) done.push('Faith');
  }
  for (const [name, choices, display] of [['Dwelling type', DWELLING_TYPES, 'list'], ['Campus', own.campuses, 'buttons']]) {
    if (seeded.has(LIST_SEEDS[name])) continue;
    const f = live.find((x) => nameKey(x.name) === nameKey(name) && x.kind === 'text' && !x.converting);
    if (!f) continue;
    const used = (await tx.query('select 1 from person_field_values where workspace_id = $1 and field_id = $2 limit 1', [ws, f.id])).rows[0];
    if (used) continue; // Words on file: a manager turns it into a list (actions.js field.list.start).
    await tx.query(
      `update person_fields set kind = 'choice', choices = $3, display = $4, updated_at = now() where id = $1 and workspace_id = $2`,
      [f.id, ws, JSON.stringify(choices), display],
    );
    emit('person_field', f.id, 'update', { kind: 'choice', was: 'text', choices, display, standard: true });
    done.push(LIST_SEEDS[name]);
  }
  if (done.length) await seed(tx, ws, done);
  return done;
};

export const sampleLoaded = async (tx, ctx, { people, emit }) => {
  const ws = ctx.workspaceId;
  const live = (await tx.query(
    'select * from person_fields where workspace_id = $1 and retired_at is null', [ws],
  )).rows;
  let top = live.reduce((m, f) => Math.max(m, f.position), -1);
  let count = live.length;
  for (const s of sampleFields()) {
    // A field of yours with the same name: the sample's values go on it when
    // it is the same kind (and has the choice); otherwise it is left alone.
    let f = live.find((x) => nameKey(x.name) === nameKey(s.name));
    if (f && f.kind !== s.kind) continue;
    if (!f) {
      if (count >= FIELDS_MAX) continue;
      top += 1;
      count += 1;
      f = { id: newId(), name: s.name, kind: s.kind, choices: s.choices || [], volunteers: s.volunteers, position: top };
      await tx.query(
        `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, sample, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
        [f.id, ws, f.name, f.kind, JSON.stringify(f.choices), f.volunteers, f.position, ctx.user?.id || null],
      );
      emit('person_field', f.id, 'create', { ...f, sample: true });
    }
    for (const [who, raw] of Object.entries(s.values)) {
      const personId = people[who];
      const p = parseValue(f, raw);
      if (!personId || p.error || p.empty) continue;
      const id = newId();
      const row = (await tx.query(
        `insert into person_field_values (id, workspace_id, field_id, person_id, value, sample, updated_by)
         values ($1, $2, $3, $4, $5, true, $6) on conflict (field_id, person_id) do nothing returning id`,
        [id, ws, f.id, personId, JSON.stringify(p.value), ctx.user?.id || null],
      )).rows[0];
      if (row) emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: personId, value: p.value, sample: true });
    }
  }
};

// Just before the sample's people go (routes/data.js): every value the
// sample made goes, each with a void event — on the people who stay and on
// those about to be removed alike, so none vanishes by cascade off the books.
// A value you set on a sample person is yours (sample = false) and keeps
// that person (clearSample counts it as one of your records), so what is
// left is yours, on people who stay. Then the sample's fields
// with nothing left go; one you filled in stays, and the message says so.
export const sampleCleared = async (tx, ctx, { emit, said }) => {
  const ws = ctx.workspaceId;
  const vals = (await tx.query(
    'delete from person_field_values where workspace_id = $1 and sample returning id, field_id, person_id', [ws],
  )).rows;
  for (const v of vals) emit('person_field_value', v.id, 'void', { field_id: v.field_id, person_id: v.person_id, sample: true });
  const fields = (await tx.query(
    `select f.id, f.name, (select count(*)::int from person_field_values v where v.field_id = f.id) as n
     from person_fields f where f.workspace_id = $1 and f.sample order by f.position`, [ws],
  )).rows;
  for (const f of fields) {
    if (f.n === 0) {
      await tx.query('delete from person_fields where id = $1 and workspace_id = $2', [f.id, ws]);
      emit('person_field', f.id, 'void', { name: f.name, sample: true });
    } else {
      await tx.query('update person_fields set sample = false, updated_at = now() where id = $1 and workspace_id = $2', [f.id, ws]);
      emit('person_field', f.id, 'update', { sample: false, kept: f.n });
      said.push(`Kept the field “${f.name}”: you filled it in for ${plural(f.n, 'person', 'people')}.`);
    }
  }
};

// Mailouts — letters, postcards and labels to the campaign's people, printed
// here and put in the mail. Outreach → Mail (the Outreach area).
//
//   mailouts            a draft: its name, what it is (a letter, a postcard,
//                       labels only), the words (Markdown, with fill-ins:
//                       {{first_name}} {{last_name}} {{name}} {{campaign}},
//                       and for thank-yous {{amount}} {{gift_date}}), who it
//                       goes to (a list, or the donors not yet thanked), the
//                       return address; then printed, then mailed
//   mailout_recipients  the people it went to, as their addresses stood when
//                       the list was made ready — what was printed is what
//                       the record says (and, for thank-yous, which gift)
//
//   mailout.save     { id?, name, kind, body?, audience, return_address? }
//   mailout.ready    { id }   the recipients, fixed: a street address, not
//                             do-not-mail or do-not-contact (the rest are
//                             counted as left out); again: made anew
//   mailout.mailed   { id }   in the mail; a thank-you marks each of its
//                             gifts thanked by letter (ext/stewardship)
//   mailout.delete   { id }   a draft, or one never mailed
//
//   GET /mailouts            the list, newest first
//   GET /mailouts/:id        one, with its recipients (and left out: how many)
//   GET /mailouts/:id/print?what=letters|envelopes|postcards|labels-5160|
//                       labels-5163|return-5167[&sample=1]
//                            a page to print (letter size, a #10 envelope, a
//                            6×4 postcard, Avery labels), addressed the
//                            Canada Post way: NAME / UNIT-NUMBER STREET /
//                            CITY PROVINCE  POSTAL
import { Hono } from 'hono';
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';
import { renderMarkdown, escapeHtml as esc } from '@starbase/shared/markdown';
import { loadList, peopleOf } from '../lists/audience.js';
import { province as defaultProvince } from '../../lib/org.js';
import { thankGift } from '../stewardship/index.js';

export const sql = `
create table if not exists mailouts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('letter', 'postcard', 'labels')),
  body text not null default '',
  audience jsonb not null default '{}',
  return_address text,
  status text not null default 'draft' check (status in ('draft', 'ready', 'mailed')),
  left_out int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  mailed_at timestamptz,
  deleted_at timestamptz
);
create index if not exists mailouts_ws_idx on mailouts (workspace_id, created_at) where deleted_at is null;
create table if not exists mailout_recipients (
  mailout_id uuid not null references mailouts(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  gift_id uuid,
  position int not null,
  name text not null,
  first_name text,
  last_name text,
  line1 text not null,
  city text,
  province text,
  postal text,
  amount_cents bigint,
  gift_date date,
  primary key (mailout_id, position)
);
create index if not exists mailout_recipients_person_idx on mailout_recipients (workspace_id, person_id);
`;

const DESK = ['manager', 'treasurer', 'staff'];
const KINDS = ['letter', 'postcard', 'labels'];
const audienceInput = z.union([
  z.object({ list_id: z.uuid() }),
  z.object({ thanks: z.literal(true) }),
]);
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

const mailoutOf = async (q, ws, id) => {
  const m = (await q.query('select * from mailouts where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!m) throw httpError(404, 'mailout not found');
  return { ...m, audience: parseJ(m.audience, {}) };
};

// The Canada Post way: the unit before the civic number with a hyphen.
const streetLine = (address, unit) => {
  const a = String(address || '').trim().replace(/\s+/g, ' ');
  const u = String(unit || '').trim();
  return u ? `${u}-${a}` : a;
};

// Who a mailout goes to, as they are now: [{ person_id, gift_id?, … }] and how many were left out.
const resolve = async (db, ctx, m) => {
  const ws = ctx.workspaceId;
  const provinceField = (await db.query(
    "select id from person_fields where workspace_id = $1 and lower(name) = 'province' and retired_at is null limit 1", [ws],
  )).rows[0]?.id || null;
  const provinceOf = async (ids) => {
    if (!provinceField || !ids.length) return new Map();
    return new Map((await db.query(
      'select person_id, value from person_field_values where field_id = $1 and person_id = any($2::uuid[])', [provinceField, ids],
    )).rows.map((r) => [r.person_id, String(parseJ(r.value, r.value) || '').trim().toUpperCase().slice(0, 2)]));
  };
  let people = [];
  let leftOut = 0;
  if (m.audience.thanks) {
    // The donors whose gifts no one has thanked yet: one letter per gift.
    const rows = (await db.query(
      `select g.id as gift_id, g.amount_cents, g.date as gift_date, p.id, p.name, p.first_name, p.last_name, p.address, p.unit, p.city, p.postal, p.tags
         from gifts g join persons p on p.id = g.person_id and p.deleted_at is null
        where g.workspace_id = $1 and g.deleted_at is null
          and not exists (select 1 from gift_thanks t where t.workspace_id = g.workspace_id and t.gift_id = g.id)
        order by g.date, g.created_at`,
      [ws],
    )).rows;
    for (const r of rows) {
      const tags = parseJ(r.tags, []);
      if (!String(r.address || '').trim() || tags.includes('do-not-mail') || tags.includes('do-not-contact')) { leftOut += 1; continue; }
      people.push(r);
    }
  } else if (m.audience.list_id) {
    const list = await loadList(db, ws, m.audience.list_id);
    if (!list) throw httpError(404, 'that list is gone');
    const all = await peopleOf(db, ctx, { list });
    const ok = await peopleOf(db, ctx, { list, reach: 'mail' });
    leftOut = all.total - ok.total;
    const names = new Map((await db.query(
      'select id, first_name, last_name from persons where id = any($1::uuid[])', [ok.people.map((p) => p.id)],
    )).rows.map((r) => [r.id, r]));
    people = ok.people.map((p) => ({ ...p, ...names.get(p.id) }));
  } else {
    throw httpError(400, 'who it goes to: a list, or the donors to thank');
  }
  const prov = await provinceOf(people.map((p) => p.id));
  return {
    leftOut,
    recipients: people.map((p) => ({
      person_id: p.id, gift_id: p.gift_id || null, name: p.name, first_name: p.first_name || null, last_name: p.last_name || null,
      line1: streetLine(p.address, p.unit), city: p.city || null, province: prov.get(p.id) || defaultProvince(),
      postal: String(p.postal || '').toUpperCase().replace(/^([A-Z]\d[A-Z])\s*(\d[A-Z]\d)$/, '$1 $2') || null,
      amount_cents: p.amount_cents != null ? Number(p.amount_cents) : null, gift_date: day(p.gift_date),
    })),
  };
};

export const actions = {
  'mailout.save': {
    roles: DESK,
    input: z.object({
      id: z.uuid().optional(),
      name: z.string().trim().min(1, 'a name').max(160),
      kind: z.enum(KINDS),
      body: z.string().max(20_000).nullish(),
      audience: audienceInput,
      return_address: z.string().trim().max(400).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      if (input.audience.list_id && !(await loadList(tx, ws, input.audience.list_id))) throw httpError(404, 'that list is gone');
      const row = { name: input.name, kind: input.kind, body: input.body || '', audience: input.audience, return_address: input.return_address || null };
      if (input.id) {
        const cur = await mailoutOf(tx, ws, input.id);
        if (cur.status === 'mailed') throw httpError(409, 'it’s in the mail already — make a new one');
        // A change after the list was made ready: make it ready again.
        await tx.query(
          `update mailouts set name = $3, kind = $4, body = $5, audience = $6, return_address = $7, updated_at = now(),
             status = case when audience::text = $6::jsonb::text then status else 'draft' end
           where id = $1 and workspace_id = $2`,
          [cur.id, ws, row.name, row.kind, row.body, JSON.stringify(row.audience), row.return_address],
        );
        emit('mailout', cur.id, 'update', { ...row, body: undefined });
        return { mailout: { id: cur.id, ...row } };
      }
      const id = newId();
      await tx.query(
        `insert into mailouts (id, workspace_id, name, kind, body, audience, return_address, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ws, row.name, row.kind, row.body, JSON.stringify(row.audience), row.return_address, ctx.user.id],
      );
      // The return address is remembered for the next mailout.
      if (row.return_address) {
        const s = parseJ((await tx.query('select settings from workspaces where id = $1', [ws])).rows[0].settings, {});
        if (s.mailFrom !== row.return_address) await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...s, mailFrom: row.return_address })]);
      }
      emit('mailout', id, 'create', { ...row, body: undefined });
      return { mailout: { id, ...row, status: 'draft' } };
    },
  },
  'mailout.ready': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const m = await mailoutOf(tx, ctx.workspaceId, input.id);
      if (m.status === 'mailed') throw httpError(409, 'it’s in the mail already');
      const { recipients, leftOut } = await resolve(tx, ctx, m);
      await tx.query('delete from mailout_recipients where mailout_id = $1', [m.id]);
      let i = 0;
      for (const r of recipients) {
        i += 1;
        await tx.query(
          `insert into mailout_recipients (mailout_id, workspace_id, person_id, gift_id, position, name, first_name, last_name, line1, city, province, postal, amount_cents, gift_date)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [m.id, ctx.workspaceId, r.person_id, r.gift_id, i, r.name, r.first_name, r.last_name, r.line1, r.city, r.province, r.postal, r.amount_cents, r.gift_date],
        );
      }
      await tx.query("update mailouts set status = 'ready', left_out = $2, ready_at = now(), updated_at = now() where id = $1", [m.id, leftOut]);
      emit('mailout', m.id, 'update', { status: 'ready', recipients: recipients.length, left_out: leftOut });
      return { id: m.id, recipients: recipients.length, left_out: leftOut };
    },
  },
  'mailout.mailed': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const m = await mailoutOf(tx, ctx.workspaceId, input.id);
      if (m.status !== 'ready') throw httpError(409, m.status === 'mailed' ? 'it’s in the mail already' : 'make the list ready and print it first');
      await tx.query("update mailouts set status = 'mailed', mailed_at = now(), updated_at = now() where id = $1", [m.id]);
      emit('mailout', m.id, 'update', { status: 'mailed' });
      let thanked = 0;
      if (m.audience.thanks) {
        const gifts = (await tx.query('select gift_id from mailout_recipients where mailout_id = $1 and gift_id is not null', [m.id])).rows;
        for (const g of gifts) {
          try { await thankGift(tx, ctx, { giftId: g.gift_id, how: 'letter', mailoutId: m.id }, emit); thanked += 1; } catch { /* a gift voided since */ }
        }
      }
      return { id: m.id, status: 'mailed', thanked };
    },
  },
  'mailout.delete': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const m = await mailoutOf(tx, ctx.workspaceId, input.id);
      if (m.status === 'mailed') throw httpError(409, 'it’s in the mail — it stays on the record');
      await tx.query('update mailouts set deleted_at = now() where id = $1', [m.id]);
      emit('mailout', m.id, 'void', {});
      return { id: m.id };
    },
  },
};

// ── Reading ──
export const api = new Hono();
const deskOnly = (c) => (DESK.includes(c.get('ctx').role) ? null : c.json({ error: 'for the desk' }, 403));
const out = (m) => ({
  id: m.id, name: m.name, kind: m.kind, body: m.body, audience: parseJ(m.audience, {}), return_address: m.return_address,
  status: m.status, left_out: m.left_out, created_at: m.created_at, ready_at: m.ready_at, mailed_at: m.mailed_at,
  recipients: m.recipients != null ? Number(m.recipients) : undefined,
});

api.get('/mailouts', async (c) => {
  const no = deskOnly(c); if (no) return no;
  const ctx = c.get('ctx');
  const rows = (await c.get('db').query(
    `select m.*, (select count(*) from mailout_recipients r where r.mailout_id = m.id) as recipients
       from mailouts m where m.workspace_id = $1 and m.deleted_at is null order by m.created_at desc limit 200`,
    [ctx.workspaceId],
  )).rows;
  const s = ctx.workspace?.settings || {};
  return c.json({ mailouts: rows.map(out), mail_from: s.mailFrom || '' });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
api.get('/mailouts/:id', async (c) => {
  const no = deskOnly(c); if (no) return no;
  if (!UUID.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx'); const db = c.get('db');
  let m;
  try { m = await mailoutOf(db, ctx.workspaceId, c.req.param('id')); } catch (e) { return c.json({ error: e.message }, e.status || 500); }
  const recipients = (await db.query('select * from mailout_recipients where mailout_id = $1 order by position', [m.id])).rows
    .map((r) => ({ ...r, amount_cents: r.amount_cents != null ? Number(r.amount_cents) : null, gift_date: day(r.gift_date) }));
  // Before it's ready: who it would go to now (a count, and a few names).
  let preview = null;
  if (m.status === 'draft') {
    try {
      const { recipients: now, leftOut } = await resolve(db, ctx, m);
      preview = { recipients: now.length, left_out: leftOut, first: now.slice(0, 5).map((r) => r.name) };
    } catch (e) { preview = { error: e.message }; }
  }
  return c.json({ mailout: out(m), recipients, preview });
});

// ── Printing ──
const money = (cents) => (cents == null ? '' : `$${(Number(cents) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const longDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
const fill = (text, r, campaign) => String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k) => ({
  first_name: r.first_name || r.name.split(' ')[0], last_name: r.last_name || '', name: r.name, campaign,
  amount: money(r.amount_cents), gift_date: longDay(day(r.gift_date)),
}[k] ?? all));
const lastLine = (r) => [String(r.city || '').toUpperCase(), r.province || '', '', r.postal || ''].join(' ').replace(/\s{3,}/, '  ').trim();
// Two spaces before the postal code (Canada Post), kept on the page.
const addressHtml = (r) => `<div class="addr"><div>${esc(r.name)}</div><div>${esc(String(r.line1 || '').toUpperCase())}</div><div>${esc(lastLine(r)).replace(/ {2}/g, '&nbsp; ')}</div></div>`;
const fromHtml = (text) => `<div class="from">${String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;

// Avery sheets on US Letter: label size, grid, page margins, pitch (inches).
const SHEETS = {
  'labels-5160': { w: 2.625, h: 1, cols: 3, rows: 10, top: 0.5, left: 0.1875, gapX: 0.125, font: 10, label: 'Avery 5160 · 30 address labels' },
  'labels-5163': { w: 4, h: 2, cols: 2, rows: 5, top: 0.5, left: 0.15625, gapX: 0.1875, font: 13, label: 'Avery 5163 · 10 shipping labels' },
  'return-5167': { w: 1.75, h: 0.5, cols: 4, rows: 20, top: 0.5, left: 0.28125, gapX: 0.3125, font: 6.5, label: 'Avery 5167 · 80 return-address labels' },
};

const page = (title, css, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box}body{margin:0;font-family:Georgia,"Times New Roman",serif;color:#111}
.bar{font:14px system-ui,sans-serif;padding:12px 16px;background:#f3f4f6;border-bottom:1px solid #ddd;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.bar button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #333;background:#fff;cursor:pointer}
@media print{.bar{display:none}}
${css}
</style></head><body><div class="bar"><strong>${esc(title)}</strong><span>Print at 100% (no “fit to page”), no headers or footers.</span><button onclick="window.print()">Print</button></div>${body}</body></html>`;

api.get('/mailouts/:id/print', async (c) => {
  const no = deskOnly(c); if (no) return no;
  if (!UUID.test(c.req.param('id'))) return c.text('not found', 404);
  const ctx = c.get('ctx'); const db = c.get('db');
  let m;
  try { m = await mailoutOf(db, ctx.workspaceId, c.req.param('id')); } catch { return c.text('not found', 404); }
  const what = String(c.req.query('what') || 'letters');
  const campaign = ctx.workspace?.name || '';
  let rows = (await db.query('select * from mailout_recipients where mailout_id = $1 order by position', [m.id])).rows;
  if (!rows.length) {
    if (c.req.query('sample') === '1') {
      rows = [{ name: 'Sam Sample', first_name: 'Sam', last_name: 'Sample', line1: '204-16068 83 AVE', city: 'Surrey', province: defaultProvince(), postal: 'V4N 0N2', amount_cents: 5000, gift_date: day(new Date()) }];
    } else if (what !== 'return-5167') {
      return c.html(page('Nothing to print yet', '', '<p style="padding:24px;font-family:system-ui">Make the list ready first (Outreach → Mail → this mailout → Get the list ready).</p>'), 409);
    }
  }
  const from = m.return_address || ctx.workspace?.settings?.mailFrom || campaign;
  const today = longDay(day(new Date()));
  const title = `${m.name} · ${what}`;

  if (what === 'letters') {
    const css = `@page{size:8.5in 11in;margin:0}.sheet{width:8.5in;height:11in;padding:0.9in 1in;page-break-after:always;font-size:12pt;line-height:1.45;position:relative}
      .from{font-size:10pt;line-height:1.35;margin-bottom:0.5in}.date{margin-bottom:0.35in}.addr{margin-bottom:0.45in;line-height:1.35}
      .body p{margin:0 0 0.8em}.body h1,.body h2,.body h3{margin:0 0 0.5em}@media screen{.sheet{margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.15);background:#fff}body{background:#e5e7eb}}`;
    const body = rows.map((r) => `<section class="sheet">${fromHtml(from)}<div class="date">${esc(today)}</div>${addressHtml(r)}<div class="body">${renderMarkdown(fill(m.body, r, campaign))}</div></section>`).join('');
    return c.html(page(title, css, body));
  }
  if (what === 'envelopes') {
    // A #10 envelope (9½ × 4⅛ in), fed as the printer's envelope tray takes it.
    const css = `@page{size:9.5in 4.125in;margin:0}.env{width:9.5in;height:4.125in;position:relative;page-break-after:always;font-family:Arial,Helvetica,sans-serif}
      .from{position:absolute;left:0.4in;top:0.35in;font-size:9.5pt;line-height:1.3}.addr{position:absolute;left:4.1in;top:1.9in;font-size:12pt;line-height:1.35}
      @media screen{.env{margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.15);background:#fff}body{background:#e5e7eb}}`;
    return c.html(page(title, css, rows.map((r) => `<section class="env">${fromHtml(from)}${addressHtml(r)}</section>`).join('')));
  }
  if (what === 'postcards') {
    // 6 × 4 in, two sides per card: the message, then the address side —
    // print double-sided (flip on the short edge).
    const css = `@page{size:6in 4in;margin:0}.card{width:6in;height:4in;position:relative;page-break-after:always;font-family:Arial,Helvetica,sans-serif}
      .msg{padding:0.35in 0.4in;font-size:11pt;line-height:1.4}.msg p{margin:0 0 0.6em}
      .from{position:absolute;left:0.3in;top:0.3in;font-size:8pt;line-height:1.25;max-width:2.6in}.addr{position:absolute;left:3.1in;top:1.6in;font-size:10.5pt;line-height:1.3}
      .stamp{position:absolute;right:0.3in;top:0.3in;width:0.85in;height:1in;border:1px dashed #999;font-size:7pt;color:#777;display:flex;align-items:center;justify-content:center;text-align:center}
      .rule{position:absolute;left:3in;top:0.3in;bottom:0.3in;border-left:1px solid #ccc}
      @media screen{.card{margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.15);background:#fff}body{background:#e5e7eb}}`;
    const body = rows.map((r) => `<section class="card"><div class="msg">${renderMarkdown(fill(m.body, r, campaign))}</div></section>`
      + `<section class="card">${fromHtml(from)}<div class="rule"></div><div class="stamp">Postage</div>${addressHtml(r)}</section>`).join('');
    return c.html(page(title, css, body));
  }
  const sheet = SHEETS[what];
  if (!sheet) return c.text('print what? letters, envelopes, postcards, labels-5160, labels-5163, return-5167', 400);
  const per = sheet.cols * sheet.rows;
  const cells = what === 'return-5167' ? Array.from({ length: per }, () => fromHtml(from)) : rows.map(addressHtml);
  const sheets = [];
  for (let i = 0; i < cells.length; i += per) sheets.push(cells.slice(i, i + per));
  const css = `@page{size:8.5in 11in;margin:0}.sheet{width:8.5in;height:11in;padding:${sheet.top}in 0 0 ${sheet.left}in;page-break-after:always;
      display:grid;grid-template-columns:repeat(${sheet.cols},${sheet.w}in);grid-auto-rows:${sheet.h}in;column-gap:${sheet.gapX}in;align-content:start}
    .lab{overflow:hidden;display:flex;align-items:center;padding:0 0.12in;font:${sheet.font}pt/1.25 Arial,Helvetica,sans-serif}
    .lab .addr div,.lab .from div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    @media screen{.sheet{margin:16px auto;box-shadow:0 2px 12px rgba(0,0,0,.15);background:#fff}.lab{outline:1px dashed #ddd}body{background:#e5e7eb}}`;
  const body = sheets.map((s) => `<section class="sheet">${s.map((x) => `<div class="lab">${x}</div>`).join('')}</section>`).join('');
  return c.html(page(`${title} — ${sheet.label}`, css, body));
});

export const deskOnlyReads = [/^\/api\/mailouts(\/|$)/];
export const exportTables = ['mailouts', 'mailout_recipients'];

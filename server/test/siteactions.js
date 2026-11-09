// Website actions as the site server records them (SITE.md "Public forms →
// people and actions"): a site_actions row and its site_action event
// { kind, person_id, campaign_id, page_id, module_id, source, referrer_id },
// in one runAction('site.form.<kind>') — with the person made in the same
// write when they're new. The site server (server/ext/site) is built
// alongside; until its tables are in this branch, ensureSiteTables makes
// them in the contract's shape (create … if not exists: the real ones,
// made at boot, win). Every column SITE.md lists gets a value, so the rows
// also fit the real tables.
import { newId, runAction } from '../lib/events.js';

export const ensureSiteTables = (db) => db.exec(`
create table if not exists site_campaigns (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  kind text not null,
  title text not null,
  excerpt text, body text, statement text, goal int,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists site_actions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete cascade,
  kind text not null,
  campaign_id uuid,
  page_id uuid,
  module_id text,
  payload jsonb not null default '{}',
  source text,
  referrer_id uuid,
  client_key text,
  created_at timestamptz not null default now()
);
create table if not exists consent_events (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete cascade,
  channel text not null,
  granted boolean not null,
  source text,
  wording text,
  created_at timestamptz not null default now()
);
`);

// A petition or pledge on the website: { id, title }.
export const siteCampaign = async (db, ws, { kind = 'petition', title }) => {
  const id = newId();
  await db.query(
    `insert into site_campaigns (id, workspace_id, slug, kind, title, excerpt, body, statement, goal, status)
     values ($1, $2, $3, $4, $5, '', '', '', 100, 'open')`,
    [id, ws, `c-${id.slice(0, 8)}`, kind, title],
  );
  return { id, kind, title };
};

// One form sent: person (an existing id, or { name, email?, phone?, lat?,
// lng? } to make them new), the form's own fields in payload, and anything
// else the same write does (extra(tx, emit, personId) — an RSVP's booking).
export const siteAction = async (db, ws, {
  kind, personId = null, person = null, campaignId = null, payload = {}, referrerId = null, source = 'site', extra = null,
  consentSms = null,
}) => {
  const id = newId();
  const { result } = await runAction(db, { workspaceId: ws, actorId: null, action: `site.form.${kind}` }, async (tx, emit) => {
    let pid = personId;
    if (!pid) {
      pid = newId();
      await tx.query(
        `insert into persons (id, workspace_id, kind, name, email, phone, lat, lng, tags)
         values ($1, $2, 'person', $3, $4, $5, $6, $7, $8)`,
        [pid, ws, person.name, person.email || null, person.phone || null, person.lat ?? null, person.lng ?? null,
         JSON.stringify([`Website: ${kind}`])],
      );
      emit('person', pid, 'create', { id: pid, kind: 'person', name: person.name, email: person.email || null, phone: person.phone || null, tags: [`Website: ${kind}`], source: 'website' });
    }
    await tx.query(
      `insert into site_actions (id, workspace_id, person_id, kind, campaign_id, page_id, module_id, payload, source, referrer_id, client_key)
       values ($1, $2, $3, $4, $5, null, null, $6, $7, $8, $9)`,
      [id, ws, pid, kind, campaignId, JSON.stringify(payload), source, referrerId, `ck-${id}`],
    );
    if (consentSms != null) {
      const cid = newId();
      await tx.query(
        `insert into consent_events (id, workspace_id, person_id, channel, granted, source, wording) values ($1, $2, $3, 'sms', $4, 'website', 'Text me')`,
        [cid, ws, pid, consentSms],
      );
      emit('consent_event', cid, 'create', { person_id: pid, channel: 'sms', granted: consentSms });
    }
    if (extra) await extra(tx, emit, pid);
    emit('site_action', id, 'create', {
      kind, person_id: pid, campaign_id: campaignId, page_id: null, module_id: null, source, referrer_id: referrerId,
    });
    return { personId: pid };
  });
  return { id, personId: result.personId };
};

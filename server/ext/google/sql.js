// Google sign-in and connections (lib/google/). Sign-in secrets and tokens:
// none of these tables is in the export or on the event log.
//   google_flows   a trip to Google and back, ten minutes at most, used once:
//                  the state's hash (the raw state is the mv2_google
//                  cookie), the nonce and the PKCE verifier (useless without
//                  Google's one-time code)
//   google_logins  a person's linked Google account for signing in, by
//                  Google's sub — never matched by email
//   google_grants  a person's one connection, server-wide, holding every
//                  purpose they connected; the refresh token sealed with
//                  GOOGLE_TOKEN_KEY; said: plain words only
export const sql = `
create table if not exists google_flows (
  state_hash text primary key,
  kind text not null check (kind in ('signin','link','connect')),
  app text not null,
  nonce text not null,
  verifier text not null,
  purpose text,
  back text,
  user_id uuid,
  workspace_id uuid,
  session_hash text,
  expires_at timestamptz not null
);

create table if not exists google_logins (
  user_id uuid primary key references users(id) on delete cascade,
  sub text not null unique,
  email text not null,
  hd text,
  linked_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists google_grants (
  id uuid primary key,
  user_id uuid not null unique references users(id) on delete cascade,
  sub text not null,
  email text not null,
  hd text,
  scopes text[] not null default '{}',
  purposes text[] not null default '{}',
  refresh_sealed text not null,
  state text not null default 'ok' check (state in ('ok','reconnect')),
  said text,
  paused_until timestamptz,
  last_ok_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Not unique: two people may connect one shared Google account.
create index if not exists google_grants_sub on google_grants (sub);
`;

// Path to win — the one table: the campaign's own numbers, one row.
//   election_day  the day the pace counts down to when GOTV & voting days
//                 has none (ext/voted's election day always wins)
//   races         per race (a slate's code, shared/canvass.js SLATES):
//                 { how: 'direct', votes, vote_rate? }
//                 { how: 'worked', eligible, turnout, share, vote_rate? }
//                 percents as typed (32.5 is 32.5%); see rules.js
// Nothing here is a rule of any jurisdiction: every number is the
// campaign's, typed in by a manager (Path to win → Change the numbers).
export const sql = `
create table if not exists path_to_win (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  election_day date,
  races jsonb not null default '{}',
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
`;

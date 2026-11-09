// pathtowin.save — managers (a manager-only action is the Admin area's,
// lib/perms.js mayRun). The campaign's own numbers for the path to win:
//
//   { election_day?: 'YYYY-MM-DD' | null,
//     races?: { [slate code]: race | null } }
//   race: { how: 'direct', votes, vote_rate? }
//       | { how: 'worked', eligible, turnout, share, vote_rate? }
//
// votes and eligible are whole numbers; turnout, share and vote_rate are
// percents (0.1 to 100, one decimal at most). A race left out stays as it
// was; null clears it. election_day left out stays; null clears it (it is
// used only while GOTV & voting days has no election day). Answers
// { settings } — what's saved now. One event, entity path_to_win (the
// campaign's id), with what changed.
import { z } from 'zod';
import { SLATE_CODES } from '@starbase/shared/canvass';
import { httpError } from '../../actions/util.js';
import { isDay, tenths } from './rules.js';

const MANAGER_ONLY = ['manager'];
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

// What's saved: { election_day, races, updated_at } (races: {} when none).
export const readSettings = async (q, ws) => {
  const r = (await q.query('select election_day, races, updated_at from path_to_win where workspace_id = $1', [ws])).rows[0];
  const races = parseJ(r?.races, {});
  return {
    election_day: dateOnly(r?.election_day),
    races: races && typeof races === 'object' && !Array.isArray(races) ? races : {},
    updated_at: r?.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
};

const pct = () => z.number().refine((v) => tenths(v) != null, 'a percent from 0.1 to 100 (one decimal at most)');
const race = z.object({
  how: z.enum(['direct', 'worked']),
  votes: z.number().int().min(1).max(10_000_000).nullish(),
  eligible: z.number().int().min(1).max(50_000_000).nullish(),
  turnout: pct().nullish(),
  share: pct().nullish(),
  vote_rate: pct().nullish(),
}).superRefine((r, cx) => {
  if (r.how === 'direct' && r.votes == null) cx.addIssue({ code: 'custom', path: ['votes'], message: 'the votes needed to win' });
  if (r.how === 'worked') {
    for (const [k, words] of [['eligible', 'how many can vote'], ['turnout', 'the turnout you expect'], ['share', 'the share needed to win']]) {
      if (r[k] == null) cx.addIssue({ code: 'custom', path: [k], message: words });
    }
  }
});

// Only what the race's way of working it out uses is kept.
const tidy = (r) => (r.how === 'direct'
  ? { how: 'direct', votes: r.votes, ...(r.vote_rate != null ? { vote_rate: r.vote_rate } : {}) }
  : { how: 'worked', eligible: r.eligible, turnout: r.turnout, share: r.share, ...(r.vote_rate != null ? { vote_rate: r.vote_rate } : {}) });

export const actions = {
  'pathtowin.save': {
    roles: MANAGER_ONLY,
    input: z.object({
      election_day: z.string().refine(isDay, 'a date like 2030-10-19').nullish(),
      races: z.record(z.string(), race.nullable()).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const unknown = Object.keys(input.races || {}).filter((k) => !SLATE_CODES.includes(k));
      if (unknown.length) throw httpError(400, `no race called ${unknown[0]} — the races are ${SLATE_CODES.join(', ')}`);
      if (input.election_day && (input.election_day < '2000-01-01' || input.election_day > '2100-12-31')) {
        throw httpError(400, 'election day: a date from 2000 to 2100');
      }
      const cur = await readSettings(tx, ws);
      const races = { ...cur.races };
      const changed = {};
      for (const [code, r] of Object.entries(input.races || {})) {
        if (r === null) delete races[code];
        else races[code] = tidy(r);
        changed[code] = r === null ? null : races[code];
      }
      const day = input.election_day === undefined ? cur.election_day : (input.election_day || null);
      await tx.query(
        `insert into path_to_win (workspace_id, election_day, races, updated_by, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (workspace_id) do update set election_day = excluded.election_day, races = excluded.races,
           updated_by = excluded.updated_by, updated_at = now()`,
        [ws, day, JSON.stringify(races), ctx.user.id],
      );
      emit('path_to_win', ws, 'update', {
        ...(input.election_day !== undefined ? { election_day: day } : {}),
        ...(input.races ? { races: changed } : {}),
      });
      return { settings: await readSettings(tx, ws) };
    },
  },
};

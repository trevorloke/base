// Donor tiers, from real gifts only.
// The named tiers are a campaign's own (lib/preset.js: preset().donorTiers,
// the highest first — each a sum given this calendar year, or a live
// monthly gift of at least so much). A campaign with none has no named
// tier: a donor is 'monthly' or 'one-time'.
// "Live recurring" = the largest monthly-cadence gift in the last 62 days.
// A named tier is sent with its label and its rank (0 the highest), so the
// profile draws it without knowing any tier by name.
import { donorTier } from '@base-win/shared/canvass';
import { preset } from './preset.js';

export const tierFor = async (tx, workspaceId, personId) => {
  const r = (await tx.query(
    `select
       coalesce(sum(amount_cents) filter (where date >= date_trunc('year', current_date)), 0)::bigint as year_cents,
       coalesce(max(amount_cents) filter (where cadence = 'monthly' and date >= current_date - 62), 0)::bigint as monthly_cents
     from gifts
     where workspace_id = $1 and person_id = $2 and deleted_at is null`,
    [workspaceId, personId],
  )).rows[0];
  const yearCents = Number(r.year_cents);
  const monthlyCents = Number(r.monthly_cents);
  const tiers = preset().donorTiers;
  const tier = donorTier({ yearCents, monthlyCents }, tiers);
  const rank = tiers.findIndex((t) => t.key === tier);
  return { tier, yearCents, monthlyCents, ...(rank >= 0 ? { label: tiers[rank].label, rank } : {}) };
};

// Brand — the campaign's look (Settings → Brand, managers): a preset, the
// name and logo in the top bar, six colours, a font and a corner style.
// shared/brand.js turns it into the app's design tokens; lib/brand.js
// writes them into every page the server sends and holds the
// pre-configuration settings (BASE_BRAND_*).
//
//   brand.save  { preset, name?, logo?, primary, accent, surface, ink,
//                 onPrimary, onAccent, font, corners, confirmLowContrast? }
//               → { brand, source: 'saved', checks }
//               managers only. A colour pair under its contrast line
//               (shared/brand.js checks) is refused (409) unless
//               confirmLowContrast is true — the Brand page asks first.
//               A logo is an upload of this campaign's ('/media/<id>',
//               from blast.picture) or an https:// address.
//   brand.clear {} → back to the pre-configured brand (settings), or the
//               Ground preset. Managers only.
//   GET /api/brand  { brand, source: 'saved'|'settings'|'default', name,
//                     checks } for anyone signed in (the app applies it);
//                   managers also get updatedAt, updatedBy and
//                   preconfigured (the brand the settings make, or null).
//
// Both writes are on the event log as a workspace update ({ brand }), like
// every other setting.
import { z } from 'zod';
import { Hono } from 'hono';
import { httpError } from '../../actions/util.js';
import { brandOf, checks, failing, validBrandInput, COLOR_KEYS, PRESET_KEYS, FONT_KEYS, CORNER_KEYS, NAME_MAX, LOGO_MAX } from '@base-ground/shared/brand';
import { ratioText } from '@base-ground/shared/contrast';
import { effectiveBrand, forgetBrandCache, loadBrand, settingsBrand } from '../../lib/brand.js';

export const sql = `
alter table workspaces add column if not exists brand jsonb;
alter table workspaces add column if not exists brand_updated_at timestamptz;
alter table workspaces add column if not exists brand_updated_by uuid references users(id) on delete set null;
`;

const MANAGER = ['manager'];
// Managers only — not someone given the Admin area: the brand is the
// campaign's face, as the Settings screen is the managers'.
const managerOnly = (ctx) => {
  if (ctx.role !== 'manager') throw httpError(403, 'only a manager may change the brand');
};

const hex = () => z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #1f4d2e');
const MEDIA = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const input = z.object({
  preset: z.enum(PRESET_KEYS),
  name: z.string().trim().max(NAME_MAX).nullish(),
  logo: z.string().trim().max(LOGO_MAX).nullish(),
  ...Object.fromEntries(COLOR_KEYS.map((k) => [k, hex()])),
  font: z.enum(FONT_KEYS),
  corners: z.enum(CORNER_KEYS),
  confirmLowContrast: z.boolean().optional(),
});

const stored = (b) => ({
  preset: b.preset, name: b.name, logo: b.logo,
  ...Object.fromEntries(COLOR_KEYS.map((k) => [k, b[k]])),
  font: b.font, corners: b.corners,
});

const after = async (db, ctx, result) => {
  forgetBrandCache();
  return { result };
};

export const actions = {
  'brand.save': {
    roles: MANAGER,
    input,
    handler: async (tx, ctx, raw, emit) => {
      managerOnly(ctx);
      const { confirmLowContrast, ...fields } = raw;
      const logo = fields.logo || null;
      const why = validBrandInput({ ...fields, logo });
      if (why) throw httpError(400, why);
      if (logo && MEDIA.test(logo)) {
        const id = logo.match(MEDIA)[1];
        const ok = (await tx.query('select 1 from media where id = $1 and workspace_id = $2', [id, ctx.workspaceId])).rows[0];
        if (!ok) throw httpError(400, 'logo: that picture isn’t one of this campaign’s uploads');
      }
      const brand = brandOf({ ...fields, logo });
      const low = failing(brand);
      if (low.length && !confirmLowContrast) {
        throw httpError(409, `low contrast: ${low.map((c) => `${c.label} ${ratioText(c.ratio)} (needs ${c.min}:1)`).join('; ')} — confirm to save anyway`);
      }
      const ws = ctx.workspaceId;
      const value = stored(brand);
      await tx.query(
        'update workspaces set brand = $2, brand_updated_at = now(), brand_updated_by = $3 where id = $1',
        [ws, JSON.stringify(value), ctx.user?.id || null],
      );
      emit('workspace', ws, 'update', { brand: value, ...(low.length ? { lowContrast: low.map((c) => c.key) } : {}) });
      return { brand, source: 'saved', checks: checks(brand) };
    },
    after,
  },
  'brand.clear': {
    roles: MANAGER,
    input: z.object({}).passthrough(),
    handler: async (tx, ctx, _input, emit) => {
      managerOnly(ctx);
      const ws = ctx.workspaceId;
      await tx.query('update workspaces set brand = null, brand_updated_at = now(), brand_updated_by = $2 where id = $1', [ws, ctx.user?.id || null]);
      emit('workspace', ws, 'update', { brand: null });
      const brand = effectiveBrand(null);
      return { brand, source: settingsBrand() ? 'settings' : 'default', checks: checks(brand) };
    },
    after,
  },
};

export const api = new Hono();
api.get('/brand', async (c) => {
  const ctx = c.get('ctx');
  const b = await loadBrand(c.get('db'), ctx.workspaceId);
  if (!b) return c.json({ error: 'not found' }, 404);
  const out = { brand: b.brand, source: b.source, name: b.name, checks: checks(b.brand) };
  if (ctx.role === 'manager') {
    Object.assign(out, {
      updatedAt: b.updatedAt, updatedBy: b.updatedBy,
      preconfigured: settingsBrand() ? effectiveBrand(null) : null,
    });
  }
  return c.json(out);
});

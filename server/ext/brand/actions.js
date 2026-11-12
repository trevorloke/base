// Settings → Brand (managers): the campaign's own look. A manager picks one
// colour (and maybe a second) and a few choices; every shade on screen is
// worked out from them (shared/brand-look.js), so nothing a manager could
// reasonably pick is refused — a pale yellow gets dark text on its buttons
// and darker yellow words, by rule.
//
//   brand.picture { kind, data (base64 or a data: URL), name? }
//                 → { picture: { id, kind, type, width, height, bytes, url } }
//                 kind: logo | logoDark | mark | icon192 | icon512 | maskable | touch
//                 (limits in pictures.js; the bytes are kept, never in the event)
//   brand.save    { color, second?, sidebar?, corners?, heading?, learn?,
//                   short_name?, email_header?, logo?, logo_dark?, mark?, icons? }
//                 → { brand } — pictures by id ({ id }; icons: { i192, i512,
//                 maskable, touch }), each this campaign's and within its
//                 limits, read again from its bytes. Stored whole as
//                 workspaces.settings.brand; the event carries it — ids,
//                 never bytes.
//   brand.reset   {} → back to the look the campaign started in (the
//                 preset STARBASE_BRAND names)
// After a save or a reset every page wears it at once: the brand the server
// keeps for a minute is dropped (lib/brand.js), and so are the website's
// kept pages (it may follow the brand).
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { readUpload } from '../abtests/media.js';
import { SIDEBARS, CORNERS, HEADINGS, deriveLook } from '@starbase/shared/brand-look';
import { APP_NAME, BRANDS } from '@starbase/shared/brand';
import { brandKey, forgetBrand, plainWords } from '../../lib/brand.js';
import { cacheClear } from '../site/cache.js';
import { BRAND_PICTURES, BRAND_PICTURE_KINDS, EXT, imageSize, pictureProblem } from './pictures.js';

const MANAGER = ['manager'];
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #003979').transform((s) => s.toLowerCase());
// Words people read under the icon and in the menu: one line of them.
const words = (max) => z.string().max(max * 4).transform((s) => plainWords(s, max)).refine((s) => s.length > 0, 'some words, not blanks');
const picture = () => z.object({ id: z.uuid() }).nullish();

// The campaign's settings, locked for this write.
const settingsFor = async (tx, ws) => parseJ((await tx.query('select settings from workspaces where id = $1 for update', [ws])).rows[0]?.settings, {});

// A picture this campaign uploaded, fit to be this kind of brand picture —
// checked again from its bytes (it may have come from the website's or
// Outreach's uploads, which allow bigger files).
const pictureOf = async (tx, ws, kind, id) => {
  const m = (await tx.query('select id, content_type, data from media where id = $1 and workspace_id = $2', [id, ws])).rows[0];
  if (!m) throw httpError(400, `that ${BRAND_PICTURES[kind].word} isn’t here any more — upload it again`);
  const buf = Buffer.from(m.data);
  const why = pictureProblem(kind, buf);
  if (why) throw httpError(400, why);
  const { w, h } = imageSize(buf);
  return { id: m.id, type: EXT[m.content_type], w, h };
};

// Dropped after a save: every page wears the new brand at once.
const forget = async (db, ctx, result) => {
  forgetBrand();
  cacheClear(ctx.workspaceId);
  return { result };
};

export const actions = {
  'brand.picture': {
    roles: MANAGER,
    input: z.object({
      kind: z.enum(BRAND_PICTURE_KINDS),
      data: z.string().min(1).max(3_000_000),
      name: z.string().trim().max(200).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const up = readUpload(input.data);
      if (up.error) throw httpError(400, up.error);
      const why = pictureProblem(input.kind, up.buf);
      if (why) throw httpError(400, why);
      const { w, h } = imageSize(up.buf);
      const id = newId();
      await tx.query(
        `insert into media (id, workspace_id, content_type, bytes, width, height, name, data, created_by, brand_kind)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, ctx.workspaceId, up.type, up.buf.length, w, h, input.name || null, up.buf, ctx.user?.id || null, input.kind],
      );
      const picture = { id, kind: input.kind, content_type: up.type, bytes: up.buf.length, width: w, height: h, name: input.name || null };
      emit('media', id, 'create', { ...picture, for: 'brand' });
      return { picture: { ...picture, type: EXT[up.type], url: `/brand/${id}.${EXT[up.type]}` } };
    },
  },

  'brand.save': {
    roles: MANAGER,
    input: z.object({
      color: hex,
      second: hex.nullish(),
      sidebar: z.enum(SIDEBARS).default('light'),
      corners: z.enum(Object.keys(CORNERS)).default('soft'),
      heading: z.enum(HEADINGS).default('inter'),
      learn: words(40).optional(),
      short_name: words(30).optional(),
      email_header: z.boolean().default(false),
      logo: picture(),
      logo_dark: picture(),
      mark: picture(),
      icons: z.object({ i192: z.uuid(), i512: z.uuid(), maskable: z.uuid(), touch: z.uuid() }).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const settings = await settingsFor(tx, ws);
      const pic = (kind, id) => (id ? pictureOf(tx, ws, kind, id) : null);
      const icons = input.icons ? {
        i192: (await pic('icon192', input.icons.i192)).id,
        i512: (await pic('icon512', input.icons.i512)).id,
        maskable: (await pic('maskable', input.icons.maskable)).id,
        touch: (await pic('touch', input.icons.touch)).id,
      } : null;
      const brand = {
        v: 1,
        color: input.color,
        second: input.second || null,
        sidebar: input.sidebar,
        corners: input.corners,
        heading: input.heading,
        // Unsaid: what the campaign's look called it until now.
        learn: input.learn || BRANDS[brandKey()].learn,
        shortName: input.short_name || APP_NAME,
        emailHeader: input.email_header,
        logo: await pic('logo', input.logo?.id),
        logoDark: await pic('logoDark', input.logo_dark?.id),
        mark: await pic('mark', input.mark?.id),
        icons,
      };
      // The checks every screen's shades pass (shared/brand-look.js). By the
      // rule they always do; one that ever didn't is refused, never shown.
      for (const scheme of ['light', 'dark']) {
        const bad = deriveLook(brand, scheme).checks.find((c) => !c.ok);
        if (bad) throw httpError(400, `${bad.what} would be ${bad.ratio.toFixed(1)}:1 — too hard to read. Pick another colour.`);
      }
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify({ ...settings, brand })]);
      emit('workspace', ws, 'update', { brand });
      return { brand };
    },
    after: forget,
  },

  'brand.reset': {
    roles: MANAGER,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const { brand, ...settings } = await settingsFor(tx, ws);
      if (!brand) return { reset: false };
      await tx.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify(settings)]);
      emit('workspace', ws, 'update', { brand: null });
      return { reset: true };
    },
    after: forget,
  },
};

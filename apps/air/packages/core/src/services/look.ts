import { asc, eq } from "drizzle-orm";
import { workspaceBrand, workspaces } from "@base-air/db";
import { brandChanges, brandFromSettings, lowContrast, parseBrand, type Brand, type ContrastPair } from "@base-air/look";
import type { CoreContext, Principal } from "../context.ts";
import { CoreError } from "../errors.ts";
import type { WorkspaceService } from "./workspaces.ts";

export interface BrandView {
  /** What the workspace shows now: its saved brand, else the deployment's default, named after the workspace. */
  brand: Brand;
  /** Whether the workspace has saved one (false: the default applies). */
  saved: boolean;
  /** The deployment's default (what "no brand saved" looks like). */
  defaults: Brand;
  updatedAt: string | null;
}

/**
 * The look a workspace shows (SUITE.md, "Look and brand"). Owners set it on the Brand page; until then the
 * deployment's default applies (BASE_AIR_BRAND_* settings, else Air). Every save is in the ledger as brand.updated.
 */
export class LookService {
  readonly defaults: Brand;

  constructor(
    private readonly ctx: CoreContext,
    private readonly workspaces: WorkspaceService,
    defaults?: Brand,
  ) {
    if (defaults) this.defaults = defaults;
    else {
      const fromEnv = brandFromSettings(process.env);
      for (const p of fromEnv.problems) console.warn(`[brand] ${p.field}: ${p.message}; ignored`);
      this.defaults = fromEnv.brand;
    }
  }

  async view(workspaceId: string): Promise<BrandView> {
    const [row] = await this.ctx.db.select().from(workspaceBrand).where(eq(workspaceBrand.workspaceId, workspaceId)).limit(1);
    const ws = await this.workspaces.get(workspaceId);
    const named = (b: Brand): Brand => ({ ...b, name: b.name || ws.name });
    if (!row) return { brand: named(this.defaults), saved: false, defaults: named(this.defaults), updatedAt: null };
    // Stored brands were validated on the way in; parsing again keeps a hand-edited row from reaching the CSS.
    const brand = parseBrand({ ...row.settings, preset: row.preset }, this.defaults).brand;
    return { brand: named(brand), saved: true, defaults: named(this.defaults), updatedAt: row.updatedAt.toISOString() };
  }

  /** The deployment's first workspace: its look is the one shown before anyone signs in (one client per deployment). */
  async homeWorkspaceId(): Promise<string | null> {
    const [w] = await this.ctx.db.select({ id: workspaces.id }).from(workspaces).orderBy(asc(workspaces.createdAt)).limit(1);
    return w?.id ?? null;
  }

  /** The brand to paint with, without the view's extras. */
  async effective(workspaceId: string): Promise<Brand> {
    return (await this.view(workspaceId)).brand;
  }

  /**
   * Save a brand. Owners only, people only. Any text-and-background pair under 4.5:1 refuses the save unless the
   * person confirmed it (`confirmLowContrast`), and the answer lists the pairs with their ratios.
   */
  async save(p: Principal, input: unknown, opts: { confirmLowContrast?: boolean } = {}): Promise<BrandView & { lowContrast: ContrastPair[] }> {
    this.workspaces.requireRole(p, ["owner"]);
    const before = await this.view(p.workspaceId);
    const { brand, problems } = parseBrand(input, before.brand);
    if (problems.length) throw new CoreError("invalid", problems.map((x) => x.message).join("; "), { problems });
    const low = lowContrast(brand);
    if (low.length && !opts.confirmLowContrast) {
      throw new CoreError("conflict", `${low.length} colour pair(s) are under 4.5:1; confirm to save anyway`, { lowContrast: low });
    }
    const ws = await this.workspaces.get(p.workspaceId);
    // A name equal to the workspace's is stored empty, so renaming the workspace renames the brand too.
    const { preset, ...rest } = { ...brand, name: brand.name === ws.name ? "" : brand.name };
    const now = this.ctx.now();
    await this.ctx.db
      .insert(workspaceBrand)
      .values({ workspaceId: p.workspaceId, preset, settings: rest, updatedBy: p.actor, updatedAt: now })
      .onConflictDoUpdate({ target: workspaceBrand.workspaceId, set: { preset, settings: rest, updatedBy: p.actor, updatedAt: now } });
    const after = await this.view(p.workspaceId);
    await this.ctx.events.append({
      workspaceId: p.workspaceId,
      type: "brand.updated",
      subjectType: "workspace",
      subjectId: p.workspaceId,
      actor: p.actor,
      data: { preset: after.brand.preset, changed: brandChanges(before.brand, after.brand), lowContrastConfirmed: low.map((x) => ({ pair: x.id, ratio: x.ratio })) },
    });
    return { ...after, lowContrast: low };
  }
}

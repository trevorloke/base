import { eq } from "drizzle-orm";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { getDb } from "@/lib/db";
import { adminUsers, siteBrand } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { requireAdmin } from "@/lib/server/admin-auth";
import { defaultBrand, parseStoredBrand } from "@/lib/server/brand";
import { getSettings } from "@/lib/server/settings";
import { BrandEditor } from "./BrandEditor";

export const metadata = { title: "Brand" };

export default async function BrandPage() {
  await requireAdmin("settings");
  const db = getDb();
  const [row] = await db
    .select({ value: siteBrand.value, updatedAt: siteBrand.updatedAt, by: adminUsers.name })
    .from(siteBrand)
    .leftJoin(adminUsers, eq(adminUsers.id, siteBrand.updatedById))
    .limit(1);
  const saved = row ? parseStoredBrand(row.value) : null;
  const fallback = defaultBrand();
  const { org } = await getSettings();
  const status = row
    ? `Last saved ${row.updatedAt.toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" })}${row.by ? ` by ${row.by}` : ""}.`
    : "Nothing saved yet: the site shows this deployment's starting look.";

  return (
    <AdminPage
      title="Brand"
      intro="The public site's look: a preset to start from, then the name, logo, colours, font and corners. The preview shows the site's key pieces as you go, and every text colour is checked against its background."
    >
      <p className="small" style={{ margin: "0 0 16px" }}>
        {status}
      </p>
      <BrandEditor initial={saved ?? fallback} orgName={org.name} limitCents={env.contributionLimitCents} />
    </AdminPage>
  );
}

import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { getDb } from "@/lib/db";
import { siteSettings } from "@/lib/db/schema";
import { normalizeModules } from "@/lib/home-modules";
import { requireAdmin } from "@/lib/server/admin-auth";
import { parseSection } from "@/lib/settings";
import { HomeModulesEditor } from "./HomeModulesEditor";

export const metadata: Metadata = { title: "Home page" };

export default async function HomePageAdmin() {
  await requireAdmin("settings");
  // Read the saved row directly (not the hour-long public cache) so the
  // editor always starts from what was last saved.
  const [row] = await getDb().select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, "homeModules"));
  const saved = parseSection("homeModules", row?.value ?? {});
  return (
    <AdminPage
      title="Home page"
      intro="Choose which modules the home page shows and in what order, and add your own text blocks. The words inside the built-in modules are edited under Site settings."
      actions={
        <a href="/" target="_blank" rel="noreferrer" className="btn btn--outline btn--sm">
          View the home page
        </a>
      }
    >
      <HomeModulesEditor initial={normalizeModules(saved.modules)} />
    </AdminPage>
  );
}

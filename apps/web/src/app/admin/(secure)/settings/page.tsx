import Link from "next/link";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { Badge } from "@/components/admin/content/Inputs";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { settingsOverrides } from "@/lib/server/content-admin";
import { SECTION_KEYS, sections } from "@/lib/settings";
import { PREVIEW_PATHS } from "./preview-paths";

function when(d: Date): string {
  return d.toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" });
}

export default async function SettingsIndex() {
  await requireAdmin("settings");
  const overrides = await settingsOverrides(getDb());
  return (
    <AdminPage title="Site settings" intro="Every piece of copy on the public pages, one section at a time. Sections showing the built-in defaults can be customized; customized ones can be reset.">
      <div className="cms-cards">
        {SECTION_KEYS.map((key) => {
          const section = sections[key];
          const override = overrides.get(key);
          // The module list has its own drag-free editor.
          const editHref = key === "homeModules" ? "/admin/home" : `/admin/settings/${key}`;
          return (
            <div key={key} className="cms-card">
              <h2>
                <Link href={editHref}>{section.label}</Link>
              </h2>
              <p>{section.description}</p>
              <p className="cms-card-meta">
                {override ? <Badge tone="live">Customized</Badge> : <Badge tone="draft">Default</Badge>}
                {override && (
                  <>
                    {" "}
                    · updated {when(override.updatedAt)}
                    {override.updatedBy ? ` by ${override.updatedBy}` : ""}
                  </>
                )}
              </p>
              <div className="btn-row" style={{ gap: 8, marginTop: 4 }}>
                <Link href={editHref} className="btn btn--primary btn--sm">
                  Edit<span className="visually-hidden"> {section.label}</span>
                </Link>
                <Link href={PREVIEW_PATHS[key]} className="btn btn--outline btn--sm" target="_blank" rel="noreferrer">
                  Preview<span className="visually-hidden"> {section.label} on the site</span>
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </AdminPage>
  );
}

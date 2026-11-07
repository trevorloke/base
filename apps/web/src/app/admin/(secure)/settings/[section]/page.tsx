import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminPage } from "@/components/admin/content/AdminPage";
import { describeSchema, toFormState } from "@/components/admin/content/schema-form";
import { SettingsForm } from "@/components/admin/content/SettingsForm";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/server/admin-auth";
import { settingsOverride } from "@/lib/server/content-admin";
import { parseSection, SECTION_KEYS, sections, type SectionKey } from "@/lib/settings";
import { PREVIEW_PATHS } from "../preview-paths";

export default async function SettingsSection({ params }: PageProps<"/admin/settings/[section]">) {
  await requireAdmin("settings");
  const { section } = await params;
  if (!SECTION_KEYS.includes(section as SectionKey)) notFound();
  const key = section as SectionKey;
  const def = sections[key];
  const override = await settingsOverride(getDb(), key);

  // Read the stored row directly rather than through the cache, so the form
  // always shows what was last saved. A row that no longer fits the schema is
  // shown as the defaults with a warning, the way the public site treats it.
  let value: unknown;
  let invalid = false;
  try {
    value = parseSection(key, override?.value ?? {});
  } catch {
    invalid = true;
    value = parseSection(key, {});
  }
  const spec = describeSchema(def.schema);

  return (
    <AdminPage
      title={def.label}
      eyebrow="Site settings"
      intro={def.description}
      crumbs={[{ href: "/admin/settings", label: "Site settings" }]}
      actions={
        <Link href={PREVIEW_PATHS[key]} className="btn btn--outline" target="_blank" rel="noreferrer">
          Preview on the site ↗
        </Link>
      }
    >
      {invalid && (
        <div role="alert" className="alert">
          <span aria-hidden="true" className="alert-icon">
            !
          </span>
          <span>The saved version of this section no longer matches what the site expects, so the defaults are shown. Saving replaces it.</span>
        </div>
      )}
      {override && !invalid && (
        <p className="small">
          Last saved {override.updatedAt.toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" })}
          {override.updatedBy ? ` by ${override.updatedBy}` : ""}.
        </p>
      )}
      <SettingsForm sectionKey={key} spec={spec} initial={toFormState(spec, value)} defaults={toFormState(spec, parseSection(key, {}))} customized={Boolean(override)} />
    </AdminPage>
  );
}

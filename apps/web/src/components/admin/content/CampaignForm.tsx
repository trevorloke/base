"use client";

import { saveCampaign } from "@/app/admin/(secure)/content/campaigns/actions";
import { fieldError, Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import { Checkbox, SelectField, TextField } from "@/components/forms/Field";
import { ImageField } from "./ImageField";
import { TextareaField } from "./Inputs";
import { MarkdownEditor } from "./MarkdownEditor";
import { TitleSlugFields } from "./TitleSlugFields";
import { useCmsForm } from "./useCmsForm";

export type CampaignFormValues = {
  id: string;
  slug: string;
  kind: "petition" | "pledge";
  title: string;
  body: string;
  statement: string;
  goal: number | null;
  question: string | null;
  shareText: string;
  targetEmails: string[];
  imageUrl: string | null;
  active: boolean;
  sortOrder: number;
};

/**
 * `slugLock` says why the address can't change: "fixed" for the campaigns
 * built into the home page, "signed" once a campaign has signatures (they are
 * stored against the address, so changing it would cut them loose).
 */
export function CampaignForm({ campaign, slugLock = null }: { campaign?: CampaignFormValues; slugLock?: "fixed" | "signed" | null }) {
  const slugLocked = slugLock !== null;
  const lockedNote =
    slugLock === "fixed" ? "This campaign is built into the home page, so its address stays fixed." : "This campaign has signatures, so its address stays fixed. Make a new campaign for a new address.";
  const form = useCmsForm(saveCampaign);
  const { state } = form;
  return (
    <form key={form.key} action={form.action} className="cms-form">
      {campaign && <input type="hidden" name="id" value={campaign.id} />}
      <SelectField id="kind" name="kind" label="Kind" defaultValue={form.text("kind", campaign?.kind ?? "petition")} error={fieldError(state, "kind")} style={{ maxWidth: 240 }}>
        <option value="petition">Petition (an ask of City Hall)</option>
        <option value="pledge">Pledge (a promise people make)</option>
      </SelectField>
      <TitleSlugFields
        defaultTitle={form.text("title", campaign?.title)}
        defaultSlug={slugLocked ? campaign?.slug : form.text("slug", campaign?.slug)}
        urlPrefix="/act/"
        titleError={fieldError(state, "title")}
        slugError={fieldError(state, "slug")}
        slugLocked={slugLocked}
        lockedNote={lockedNote}
      />
      <MarkdownEditor id="body" name="body" label="Introduction (shown above the form)" defaultValue={form.text("body", campaign?.body)} maxLength={10_000} rows={8} error={fieldError(state, "body")} />
      <TextareaField id="statement" name="statement" label="The statement people sign" hint="The pledge wording, or what the petition asks for." defaultValue={form.text("statement", campaign?.statement)} maxLength={1000} rows={3} error={fieldError(state, "statement")} />
      <div className="form-row">
        <TextField id="goal" name="goal" type="number" min={1} max={10_000_000} step={1} label="Signature goal (optional)" defaultValue={form.text("goal", campaign?.goal ?? "")} error={fieldError(state, "goal")} inputMode="numeric" />
        <TextField id="sortOrder" name="sortOrder" type="number" min={0} max={1000} step={1} label="Sort order (lowest first)" defaultValue={form.text("sortOrder", campaign?.sortOrder ?? 0)} error={fieldError(state, "sortOrder")} />
      </div>
      <TextField id="question" name="question" label="Optional question on the form" maxLength={200} defaultValue={form.text("question", campaign?.question ?? "")} placeholder='e.g. "Where should the line end?"' error={fieldError(state, "question")} />
      <TextareaField id="shareText" name="shareText" label="Share text" hint="What people post when they share it, before the link." defaultValue={form.text("shareText", campaign?.shareText)} maxLength={300} rows={2} error={fieldError(state, "shareText")} />
      <TextareaField
        id="targetEmails"
        name="targetEmails"
        label="Email council to"
        hint="One address per line. Leave empty to hide the email-council action."
        defaultValue={form.text("targetEmails", campaign?.targetEmails.join("\n"))}
        rows={3}
        error={fieldError(state, "targetEmails")}
      />
      <ImageField defaultUrl={form.text("imageUrl", campaign?.imageUrl)} showAlt={false} urlError={fieldError(state, "imageUrl")} />
      <Checkbox name="active" defaultChecked={form.checked("active", campaign ? campaign.active : true)}>
        Active (accepting signatures)
      </Checkbox>
      <Notice state={state} />
      <div className="cms-publish">
        <SubmitButton className="btn btn--accent">{campaign ? "Save changes" : "Create campaign"}</SubmitButton>
      </div>
    </form>
  );
}

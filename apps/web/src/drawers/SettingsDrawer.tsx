import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ActionClass, AutonomyLevel, BrandProfile, Policy, PolicyVersion, RedLine, Role, SpendCaps, Workspace } from "../types";
import { api, errorText } from "../api";
import { ChipsInput } from "../components/ChipsInput";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { RelativeTime } from "../components/RelativeTime";
import { TimezonePicker } from "../components/TimezonePicker";
import { useToast } from "../components/Toast";
import { ACTION_CLASS_LABEL, ACTION_CLASS_ORDER, actorLabel, AUTONOMY_LABEL, plural } from "../lib/format";
import { AUTONOMY_HINT, AUTONOMY_LEVELS, policyDiff, type SettingsSectionId } from "../lib/policy";
import { useRoom } from "../lib/room";
import { formatDateTime } from "../lib/time";
import { clockIn, tzName, wallParts } from "../lib/tz";
import { useNow } from "../lib/useNow";
import { RedLinesSection } from "./settings/RedLines";


const SECTIONS: { id: SettingsSectionId; label: string }[] = [
  { id: "brand", label: "Brand" },
  { id: "redlines", label: "Red lines" },
  { id: "autonomy", label: "Autonomy" },
  { id: "timezone", label: "Timezone" },
  { id: "spend", label: "Spend caps" },
  { id: "history", label: "History" },
];

const DEFAULT_CAPS: SpendCaps = { xReadsUsdMonthly: 50, modelUsdMonthly: 100 };
const OWNER_ONLY = "Only an owner can change this.";
const PEOPLE_ONLY = "Only an owner, signed in as a person, can change this. Agents' keys can't.";
const BRAND_ROLES: (Role | null)[] = ["owner", "approver", "editor", null];

/**
 * The workspace's brand profile and policy in one place: what the AI reads about the brand, the red lines, how far
 * agents may go, the workspace's timezone and monthly spend caps, and every policy version so far. Each section saves
 * on its own; the policy ones save the whole policy as a new version.
 */
export function SettingsDrawer({
  myRole,
  isHuman,
  workspaceName,
  initial,
  onPolicy,
  onClose,
}: {
  /** null while unknown (an API key): the controls show and the server decides. */
  myRole: Role | null;
  /** Policy changes are for people; an agent's key is refused. */
  isHuman: boolean;
  workspaceName: string;
  initial?: SettingsSectionId;
  /** A saved policy, so the room (timezone, brief, top bar) follows at once. */
  onPolicy: (p: Policy) => void;
  onClose: () => void;
}) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [history, setHistory] = useState<PolicyVersion[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  const loadHistory = useCallback(() => {
    setHistoryError(null);
    api
      .policyHistory()
      .then(setHistory)
      .catch((e: unknown) => setHistoryError(errorText(e)));
  }, []);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.policy(), api.workspace()])
      .then(([p, w]) => {
        setPolicy(p);
        setWs(w);
      })
      .catch((e: unknown) => setError(errorText(e)));
    loadHistory();
  }, [loadHistory]);
  useEffect(load, [load]);

  const jump = useCallback((id: SettingsSectionId, smooth = true) => {
    const el = body.current?.querySelector<HTMLElement>(`#settings-${id}`);
    el?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    el?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  }, []);

  // Opened for one section (from a "Set red lines" link): go there once everything has rendered.
  useEffect(() => {
    if (!policy || !ws || !initial || scrolled.current) return;
    scrolled.current = true;
    window.requestAnimationFrame(() => jump(initial, false));
  }, [policy, ws, initial, jump]);

  const canPolicy = isHuman && (myRole === "owner" || myRole === null);
  const canBrand = BRAND_ROLES.includes(myRole);
  const note = isHuman ? OWNER_ONLY : PEOPLE_ONLY;

  /** Save the whole policy with these fields changed. Throws the server's refusal for the section to show. */
  const savePolicy = useCallback(
    async (patch: Partial<Policy>): Promise<Policy> => {
      if (!policy) throw new Error("The policy hasn't loaded yet.");
      const next = await api.updatePolicy({ ...policy, ...patch });
      setPolicy(next);
      onPolicy(next);
      loadHistory();
      return next;
    },
    [policy, onPolicy, loadHistory],
  );

  return (
    <Drawer
      title="Settings"
      className="drawer-wide settings-drawer"
      subtitle={<span className="muted">{policy ? `${workspaceName} · policy version ${policy.version}` : workspaceName}</span>}
      onClose={onClose}
    >
      <div ref={body}>
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className="chip" onClick={() => jump(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <PanelState error={error} loading={(!policy || !ws) && !error} onRetry={load} />
        {policy && ws ? (
          <>
            <Section id="brand" title="Brand" lede="What the Scout and the writing operators read about the brand before they suggest or draft anything.">
              <BrandSection ws={ws} canEdit={canBrand} onSaved={setWs} />
            </Section>
            <Section id="redlines" title={policy.redLines.length ? plural(policy.redLines.length, "red line") : "Red lines"} lede="Checked on every post and reply, from every person and agent, before anything goes out.">
              <RedLinesSection
                lines={policy.redLines}
                canEdit={canPolicy}
                readOnlyNote={note}
                timezone={policy.timezone}
                competitors={[...new Set([...(policy.competitors ?? []), ...stringList((ws.profile as BrandProfile).competitors)])]}
                onSave={async (redLines: RedLine[]) => void (await savePolicy({ redLines }))}
              />
            </Section>
            <Section id="autonomy" title="Autonomy" lede="How far agents (operators and MCP-connected assistants) may go on their own, per kind of action. People follow their role.">
              <AutonomySection policy={policy} canEdit={canPolicy} note={note} onSave={savePolicy} />
            </Section>
            <Section id="timezone" title="Timezone" lede="The workspace's days and hours: schedules, the calendar, reports and daily post caps read in it.">
              <TimezoneSection policy={policy} canEdit={canPolicy} note={note} onSave={savePolicy} />
            </Section>
            <Section id="spend" title="Spend caps" lede="Monthly ceilings on what this workspace spends on outside services. When one is reached, that work pauses until next month.">
              <SpendSection policy={policy} canEdit={canPolicy} note={note} onSave={savePolicy} />
            </Section>
            <Section id="history" title="History" lede="Every saved policy is a new version; older ones stay on record.">
              <HistorySection history={history} error={historyError} onRetry={loadHistory} />
            </Section>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}

function Section({ id, title, lede, children }: { id: SettingsSectionId; title: string; lede: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="dsec settings-sec" aria-labelledby={`settings-${id}-h`}>
      <h3 id={`settings-${id}-h`} className="section-h" tabIndex={-1}>
        {title}
      </h3>
      <p className="small settings-lede">{lede}</p>
      {children}
    </section>
  );
}

function SaveRow({ busy, dirty, disabled, error, onUndo, label = "Save" }: { busy: boolean; dirty: boolean; disabled?: boolean; error: string | null; onUndo: () => void; label?: string }) {
  return (
    <>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="dsec-act">
        <button type="submit" className="btn btn-primary" disabled={busy || !dirty || disabled}>
          {busy ? "Saving…" : label}
        </button>
        {dirty && !busy ? (
          <button type="button" className="btn btn-ghost" onClick={onUndo}>
            Undo changes
          </button>
        ) : null}
      </div>
    </>
  );
}

// --- Brand ----------------------------------------------------------------------

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const MAX_EXAMPLES = 10;

interface BrandDraft {
  description: string;
  audience: string;
  topics: string[];
  voiceDo: string[];
  voiceDont: string[];
  examples: string[];
  competitors: string[];
}

function brandOf(profile: Record<string, unknown>): BrandDraft {
  const p = profile as BrandProfile;
  const voice = (p.voice && typeof p.voice === "object" ? p.voice : {}) as Record<string, unknown>;
  return {
    description: text(p.description),
    audience: text(p.audience),
    topics: stringList(p.topics),
    voiceDo: stringList(voice.do),
    voiceDont: stringList(voice.dont),
    examples: stringList(voice.examples),
    competitors: stringList(p.competitors),
  };
}

/** The draft merged into the profile as it is now: keys this form doesn't know about are kept. */
function mergeBrand(profile: Record<string, unknown>, d: BrandDraft): Record<string, unknown> {
  const next: Record<string, unknown> = { ...profile };
  const put = (k: string, v: string) => {
    if (v.trim()) next[k] = v.trim();
    else delete next[k];
  };
  put("description", d.description);
  put("audience", d.audience);
  next.topics = d.topics;
  next.competitors = d.competitors;
  const voice = profile.voice && typeof profile.voice === "object" && !Array.isArray(profile.voice) ? (profile.voice as Record<string, unknown>) : {};
  next.voice = { ...voice, do: d.voiceDo, dont: d.voiceDont, examples: d.examples.map((e) => e.trim()).filter(Boolean) };
  return next;
}

function sameBrand(a: BrandDraft, b: BrandDraft): boolean {
  const clean = (d: BrandDraft) => ({ ...d, description: d.description.trim(), audience: d.audience.trim(), examples: d.examples.map((e) => e.trim()).filter(Boolean) });
  return JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

function BrandSection({ ws, canEdit, onSaved }: { ws: Workspace; canEdit: boolean; onSaved: (w: Workspace) => void }) {
  const toast = useToast();
  const saved = brandOf(ws.profile);
  const [d, setD] = useState<BrandDraft>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setD(brandOf(ws.profile)), [ws]);
  const set = (p: Partial<BrandDraft>) => setD((x) => ({ ...x, ...p }));
  const dirty = !sameBrand(d, saved);

  if (!canEdit) {
    const empty = <span className="muted">Not set</span>;
    const chips = (xs: string[]) => (xs.length ? xs.map((x) => <span key={x} className="tag">{x}</span>) : empty);
    return (
      <>
        <dl className="kv settings-kv">
          <div className="kv-row">
            <dt>Description</dt>
            <dd>{saved.description || empty}</dd>
          </div>
          <div className="kv-row">
            <dt>Audience</dt>
            <dd>{saved.audience || empty}</dd>
          </div>
          <div className="kv-row">
            <dt>Topics</dt>
            <dd className="settings-tags">{chips(saved.topics)}</dd>
          </div>
          <div className="kv-row">
            <dt>Voice: do</dt>
            <dd className="settings-tags">{chips(saved.voiceDo)}</dd>
          </div>
          <div className="kv-row">
            <dt>Voice: don't</dt>
            <dd className="settings-tags">{chips(saved.voiceDont)}</dd>
          </div>
          <div className="kv-row">
            <dt>Example posts</dt>
            <dd>{saved.examples.length ? plural(saved.examples.length, "example") : empty}</dd>
          </div>
          <div className="kv-row">
            <dt>Competitors</dt>
            <dd className="settings-tags">{chips(saved.competitors)}</dd>
          </div>
        </dl>
        <p className="muted small links-note">Owners, approvers and editors can change the brand profile.</p>
      </>
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setError(null);
    try {
      // Merge into the profile as the server has it now, so a key someone else just added survives.
      const fresh = await api.workspace().catch(() => ws);
      const next = await api.updateProfile(mergeBrand(fresh.profile ?? {}, d));
      onSaved(next);
      toast("Brand profile saved");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={(e) => void save(e)}>
      <label className="field">
        <span>Description</span>
        <textarea
          className="textarea"
          rows={2}
          maxLength={1000}
          placeholder="Specialty roaster in Portland with four cafés and a wholesale program."
          value={d.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Audience</span>
        <textarea
          className="textarea"
          rows={2}
          maxLength={1000}
          placeholder="Who the brand talks to, and what they care about."
          value={d.audience}
          onChange={(e) => set({ audience: e.target.value })}
        />
      </label>
      <ChipsInput id="brand-topics" label="Topics" what="topic" values={d.topics} onChange={(topics) => set({ topics })} placeholder="cold brew, sourcing" help="What the brand talks about. The Scout ranks trends by these." max={40} />
      <div className="settings-pair">
        <ChipsInput id="brand-do" label="Voice: do" what="voice rule" values={d.voiceDo} onChange={(voiceDo) => set({ voiceDo })} placeholder="plain words" max={30} maxLength={200} />
        <ChipsInput id="brand-dont" label="Voice: don't" what="voice rule" values={d.voiceDont} onChange={(voiceDont) => set({ voiceDont })} placeholder="hype" max={30} maxLength={200} />
      </div>
      <div className="field">
        <span id="brand-examples">Example posts</span>
        <p className="muted small chipsin-help">Posts that sound right. Drafts imitate them.</p>
        <div className="settings-examples" role="group" aria-labelledby="brand-examples">
          {d.examples.map((ex, i) => (
            <div key={i} className="settings-example">
              <textarea
                className="textarea"
                rows={2}
                maxLength={2000}
                aria-label={`Example post ${i + 1}`}
                value={ex}
                onChange={(e) => set({ examples: d.examples.map((x, j) => (j === i ? e.target.value : x)) })}
              />
              <button type="button" className="btn btn-small btn-ghost" aria-label={`Remove example post ${i + 1}`} onClick={() => set({ examples: d.examples.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
        </div>
        {d.examples.length < MAX_EXAMPLES ? (
          <div>
            <button type="button" className="btn btn-small" onClick={() => set({ examples: [...d.examples, ""] })}>
              Add an example
            </button>
          </div>
        ) : null}
      </div>
      <ChipsInput id="brand-competitors" label="Competitors" what="competitor" values={d.competitors} onChange={(competitors) => set({ competitors })} placeholder="Blue Bottle, Stumptown" help="Brands the AI should know about. To keep posts from naming them, add a competitor red line." max={40} />
      <SaveRow busy={busy} dirty={dirty} error={error} onUndo={() => setD(saved)} label="Save brand" />
    </form>
  );
}

// --- Autonomy ----------------------------------------------------------------------

function AutonomySection({ policy, canEdit, note, onSave }: { policy: Policy; canEdit: boolean; note: string; onSave: (p: Partial<Policy>) => Promise<Policy> }) {
  const toast = useToast();
  const [dial, setDial] = useState(policy.autonomy);
  const [editors, setEditors] = useState(policy.requireApprovalForEditors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDial(policy.autonomy);
    setEditors(policy.requireApprovalForEditors);
  }, [policy]);
  const dirty = editors !== policy.requireApprovalForEditors || ACTION_CLASS_ORDER.some((c) => dial[c] !== policy.autonomy[c]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave({ autonomy: dial, requireApprovalForEditors: editors });
      toast("Autonomy saved");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={(e) => void save(e)}>
      <div className="dial">
        {ACTION_CLASS_ORDER.map((c: ActionClass) => {
          const v = dial[c];
          return (
            <div key={c} className="dial-row">
              <label className="dial-label" htmlFor={`dial-${c}`}>
                {ACTION_CLASS_LABEL[c]}
              </label>
              <select id={`dial-${c}`} className="select select-small dial-select" disabled={!canEdit} value={v ?? ""} onChange={(e) => setDial({ ...dial, [c]: e.target.value as AutonomyLevel })}>
                {!v ? <option value="">Not set</option> : null}
                {AUTONOMY_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {AUTONOMY_LABEL[l]}
                  </option>
                ))}
              </select>
              <span className="muted small dial-hint">{v ? AUTONOMY_HINT[v] : "Agents follow the default for this action."}</span>
            </div>
          );
        })}
      </div>
      <details className="dial-legend">
        <summary className="small">What each setting means</summary>
        <dl className="kv">
          {AUTONOMY_LEVELS.map((l) => (
            <div key={l} className="kv-row">
              <dt>{AUTONOMY_LABEL[l]}</dt>
              <dd>{AUTONOMY_HINT[l]}</dd>
            </div>
          ))}
        </dl>
      </details>
      <label className="check">
        <input type="checkbox" checked={editors} disabled={!canEdit} onChange={(e) => setEditors(e.target.checked)} />
        <span>
          Editors' posts need an approver <span className="muted small">· owners and approvers never do</span>
        </span>
      </label>
      {canEdit ? (
        <SaveRow
          busy={busy}
          dirty={dirty}
          error={error}
          onUndo={() => {
            setDial(policy.autonomy);
            setEditors(policy.requireApprovalForEditors);
          }}
          label="Save autonomy"
        />
      ) : (
        <p className="muted small links-note">{note}</p>
      )}
    </form>
  );
}

// --- Timezone ----------------------------------------------------------------------

function offsetLabel(ms: number, tz: string): string {
  try {
    const w = wallParts(ms, tz);
    const mins = Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000) / 60_000);
    if (mins === 0) return "UTC";
    const sign = mins > 0 ? "+" : "−";
    const a = Math.abs(mins);
    return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
  } catch {
    return "";
  }
}

function TimezoneSection({ policy, canEdit, note, onSave }: { policy: Policy; canEdit: boolean; note: string; onSave: (p: Partial<Policy>) => Promise<Policy> }) {
  const toast = useToast();
  const now = useNow(30_000);
  const [tz, setTz] = useState(policy.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setTz(policy.timezone), [policy.timezone]);
  const dirty = tz !== policy.timezone;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await onSave({ timezone: tz });
      toast(`Timezone is now ${tzName(next.timezone)}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  let local = "";
  try {
    local = `${new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: tz }).format(new Date(now))} ${clockIn(now, tz)}`;
  } catch {
    local = "";
  }

  return (
    <form className="settings-form" onSubmit={(e) => void save(e)}>
      <div className="field">
        <span>Workspace timezone</span>
        <TimezonePicker value={tz} onChange={setTz} label="Workspace timezone" disabled={!canEdit} now={now} />
      </div>
      <p className="tz-now" aria-live="polite">
        It's <span className="mono strong">{local}</span> there now · <span className="muted">{tzName(tz)}, {offsetLabel(now, tz)}</span>
      </p>
      {policy.redLines.some((r) => r.kind === "quiet_hours") ? <p className="muted small">Quiet hours keep the timezone each was declared in.</p> : null}
      {canEdit ? <SaveRow busy={busy} dirty={dirty} error={error} onUndo={() => setTz(policy.timezone)} label="Save timezone" /> : <p className="muted small links-note">{note}</p>}
    </form>
  );
}

// --- Spend caps ----------------------------------------------------------------------

const CAP_FIELDS: { key: keyof SpendCaps; label: string; covers: string }[] = [
  {
    key: "modelUsdMonthly",
    label: "Model spend",
    covers: "Adapting posts per network, translation, alias suggestions, operators' drafts and the weekly brief. When it's reached they stop; publishing and listening go on.",
  },
  {
    key: "xReadsUsdMonthly",
    label: "X reads",
    covers: "Metered reads from the X API: mentions, replies and searches on X. 0 turns reading X off.",
  },
];

function SpendSection({ policy, canEdit, note, onSave }: { policy: Policy; canEdit: boolean; note: string; onSave: (p: Partial<Policy>) => Promise<Policy> }) {
  const toast = useToast();
  const caps = policy.spendCaps ?? DEFAULT_CAPS;
  const asText = (c: SpendCaps) => ({ modelUsdMonthly: String(c.modelUsdMonthly), xReadsUsdMonthly: String(c.xReadsUsdMonthly) });
  const [d, setD] = useState(asText(caps));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setD(asText(policy.spendCaps ?? DEFAULT_CAPS)), [policy.spendCaps]);

  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const valid = CAP_FIELDS.every((f) => Number.isFinite(num(d[f.key])) && num(d[f.key]) >= 0);
  const dirty = CAP_FIELDS.some((f) => num(d[f.key]) !== caps[f.key]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ spendCaps: { ...caps, modelUsdMonthly: num(d.modelUsdMonthly), xReadsUsdMonthly: num(d.xReadsUsdMonthly) } });
      toast("Spend caps saved");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={(e) => void save(e)}>
      {CAP_FIELDS.map((f) => (
        <div key={f.key} className="cap-row">
          <label className="field cap-field">
            <span>{f.label}, per month</span>
            <span className="cap-input">
              <span className="muted mono" aria-hidden="true">
                $
              </span>
              <input
                className="input mono"
                type="number"
                inputMode="decimal"
                min={0}
                step={1}
                disabled={!canEdit}
                value={d[f.key]}
                aria-invalid={!(num(d[f.key]) >= 0)}
                onChange={(e) => setD({ ...d, [f.key]: e.target.value })}
              />
            </span>
          </label>
          <p className="muted small cap-covers">{f.covers}</p>
        </div>
      ))}
      {!valid ? <p className="small field-warn">Use an amount of 0 or more.</p> : null}
      {canEdit ? (
        <SaveRow busy={busy} dirty={dirty} disabled={!valid} error={error} onUndo={() => setD(asText(caps))} label="Save spend caps" />
      ) : (
        <p className="muted small links-note">{note}</p>
      )}
    </form>
  );
}

// --- History ----------------------------------------------------------------------

const HISTORY_SHOWN = 8;

function HistorySection({ history, error, onRetry }: { history: PolicyVersion[] | null; error: string | null; onRetry: () => void }) {
  const { people, timezone } = useRoom();
  const [all, setAll] = useState(false);
  if (error || !history) return <PanelState error={error} loading={!history && !error} onRetry={onRetry} />;
  if (!history.length) return <p className="muted">No versions saved yet.</p>;
  const sorted = [...history].sort((a, b) => b.version - a.version);
  const shown = all ? sorted : sorted.slice(0, HISTORY_SHOWN);
  return (
    <>
      <ol className="ph-list">
        {shown.map((row) => {
          const prev = sorted.find((r) => r.version < row.version) ?? null;
          const changes = policyDiff(prev ? prev.document : null, row.document);
          return (
            <li key={row.id} className="ph-row">
              <div className="ph-head">
                <span className="strong mono">v{row.version}</span>
                {row.active ? <span className="tag">Current</span> : null}
                <span>{actorLabel(row.createdBy, people)}</span>
                <span className="muted small" title={formatDateTime(row.createdAt, timezone)}>
                  <RelativeTime iso={row.createdAt} />
                </span>
              </div>
              <ul className="ph-changes small">
                {changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      {sorted.length > HISTORY_SHOWN ? (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${sorted.length} versions`}
        </button>
      ) : null}
    </>
  );
}

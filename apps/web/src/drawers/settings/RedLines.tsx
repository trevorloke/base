import { useMemo, useState, type FormEvent } from "react";
import type { Network, RedLine, RedLineKind, RedLineSeverity } from "../../types";
import { errorText } from "../../api";
import { ChipsInput } from "../../components/ChipsInput";
import { TimezonePicker } from "../../components/TimezonePicker";
import { useToast } from "../../components/Toast";
import { NETWORKS, networkLabel, plural, SEVERITY_LABEL } from "../../lib/format";
import {
  compilePattern,
  DAY_SHORT,
  DISCLOSURE_WHEN,
  RED_LINE_KIND_HINT,
  RED_LINE_KIND_LABEL,
  RED_LINE_KINDS,
  redLineDetail,
  redLineKindLabel,
  SEVERITIES,
  SEVERITY_CHOICE,
} from "../../lib/policy";
import { useRoom } from "../../lib/room";

type When = "ai_assisted" | "always" | "paid";

/** Every field any kind needs; only the chosen kind's fields are sent. */
interface LineDraft {
  id: string | null;
  kind: RedLineKind;
  severity: RedLineSeverity;
  description: string;
  phrases: string[];
  keywords: string[];
  semantic: boolean;
  patterns: string[];
  competitors: string[];
  timezone: string;
  startHour: number;
  endHour: number;
  days: number[];
  requiredText: string;
  when: When;
  limit: string;
  networks: string[];
  pattern: string;
  flags: string;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function draftOf(r: RedLine | null, tz: string): LineDraft {
  const d: LineDraft = {
    id: r?.id ?? null,
    kind: (r?.kind as RedLineKind | undefined) ?? "forbidden_phrase",
    severity: r?.severity ?? "block",
    description: r?.description ?? "",
    phrases: strs(r?.phrases),
    keywords: strs(r?.keywords),
    semantic: r?.semantic === true,
    patterns: strs(r?.patterns).length ? strs(r?.patterns) : [""],
    competitors: strs(r?.competitors),
    timezone: typeof r?.timezone === "string" ? r.timezone : tz,
    startHour: typeof r?.startHour === "number" ? r.startHour : 22,
    endHour: typeof r?.endHour === "number" ? r.endHour : 7,
    days: Array.isArray(r?.days) ? (r.days as number[]) : [],
    requiredText: typeof r?.requiredText === "string" ? r.requiredText : "",
    when: (r?.when as When | undefined) ?? "ai_assisted",
    limit: typeof r?.limit === "number" ? String(r.limit) : "3",
    networks: strs(r?.networks),
    pattern: typeof r?.pattern === "string" ? r.pattern : "",
    flags: typeof r?.flags === "string" ? r.flags : "i",
  };
  return d;
}

/** The red line the schema expects for this kind, or what is missing. */
function build(d: LineDraft): { line: RedLine | null; problem: string | null } {
  const base = { id: d.id ?? newId(), kind: d.kind, severity: d.severity, description: d.description.trim() };
  if (!base.description) return { line: null, problem: "Say in a few words what this red line is for." };
  switch (d.kind) {
    case "forbidden_phrase":
      return d.phrases.length ? { line: { ...base, phrases: d.phrases }, problem: null } : { line: null, problem: "Add at least one phrase." };
    case "forbidden_topic":
      return d.keywords.length ? { line: { ...base, keywords: d.keywords, semantic: d.semantic }, problem: null } : { line: null, problem: "Add at least one keyword." };
    case "forbidden_claim": {
      const patterns = d.patterns.map((p) => p.trim()).filter(Boolean);
      if (!patterns.length) return { line: null, problem: "Add at least one pattern." };
      const bad = patterns.find((p) => compilePattern(p).error);
      if (bad) return { line: null, problem: `“${bad}” isn't a valid pattern: ${compilePattern(bad).error}` };
      return { line: { ...base, patterns }, problem: null };
    }
    case "custom_regex": {
      const pattern = d.pattern.trim();
      if (!pattern) return { line: null, problem: "Write the pattern." };
      const c = compilePattern(pattern, d.flags);
      if (c.error) return { line: null, problem: `That isn't a valid pattern: ${c.error}` };
      return { line: { ...base, pattern, flags: d.flags.replace(/[^dimsuy]/g, "") || "i" }, problem: null };
    }
    case "no_competitor_mention":
      return d.competitors.length ? { line: { ...base, competitors: d.competitors }, problem: null } : { line: null, problem: "Add at least one competitor." };
    case "quiet_hours":
      if (d.startHour === d.endHour) return { line: null, problem: "Start and end are the same hour, so the window is empty." };
      return { line: { ...base, timezone: d.timezone, startHour: d.startHour, endHour: d.endHour, days: [...d.days].sort() }, problem: null };
    case "required_disclosure":
      return d.requiredText.trim() ? { line: { ...base, requiredText: d.requiredText.trim(), when: d.when }, problem: null } : { line: null, problem: "Write the text that must appear." };
    case "max_posts_per_day": {
      const limit = Number(d.limit);
      if (!Number.isInteger(limit) || limit < 1) return { line: null, problem: "The cap is a whole number, 1 or more." };
      return { line: { ...base, limit, networks: d.networks }, problem: null };
    }
    case "network_restriction":
      return d.networks.length ? { line: { ...base, networks: d.networks }, problem: null } : { line: null, problem: "Pick at least one network." };
  }
}

function newId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `rl_${Date.now().toString(36)}${r}`;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Every red line in plain words, with add, edit and remove for owners. Each change saves the whole policy as a new
 * version (`onSave` throws the server's refusal, shown here).
 */
export function RedLinesSection({
  lines,
  canEdit,
  readOnlyNote,
  timezone,
  competitors,
  onSave,
}: {
  lines: RedLine[];
  canEdit: boolean;
  readOnlyNote: string;
  timezone: string;
  /** The brand's competitors, offered as a starting list for a competitor red line. */
  competitors: string[];
  onSave: (next: RedLine[]) => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  async function remove(r: RedLine) {
    setBusy(r.id);
    setRowError(null);
    try {
      await onSave(lines.filter((x) => x.id !== r.id));
      setConfirming(null);
      toast(`Removed red line: ${r.description || redLineKindLabel(r.kind)}`);
    } catch (e) {
      setRowError({ id: r.id, text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function save(line: RedLine) {
    const exists = lines.some((x) => x.id === line.id);
    await onSave(exists ? lines.map((x) => (x.id === line.id ? line : x)) : [...lines, line]);
    setEditing(null);
    toast(exists ? "Red line saved" : "Red line added");
  }

  return (
    <>
      {lines.length ? (
        <ul className="rl-list">
          {lines.map((r) =>
            editing === r.id ? (
              <li key={r.id} className="rl-row rl-row-edit">
                <RedLineForm initial={r} timezone={timezone} competitors={competitors} onCancel={() => setEditing(null)} onSave={save} />
              </li>
            ) : (
              <li key={r.id} className="rl-row">
                <div className="rl-main">
                  <div className="rl-top">
                    <span className={`rl-sev rl-${r.severity}`}>{SEVERITY_LABEL[r.severity] ?? r.severity}</span>
                    <span className="tag">{redLineKindLabel(r.kind)}</span>
                  </div>
                  <div className="rl-title">{r.description || <span className="muted">No description</span>}</div>
                  <div className="muted small rl-detail">{redLineDetail(r)}</div>
                  {rowError?.id === r.id ? (
                    <div className="card-error" role="alert">
                      {rowError.text}
                    </div>
                  ) : null}
                </div>
                {canEdit ? (
                  confirming === r.id ? (
                    <div className="acct-confirm rl-confirm" role="group" aria-label={`Remove ${r.description}?`}>
                      <span>Remove it?</span>
                      <button type="button" className="btn btn-small btn-danger" disabled={busy === r.id} onClick={() => void remove(r)}>
                        {busy === r.id ? "…" : "Yes"}
                      </button>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)}>
                        No
                      </button>
                    </div>
                  ) : (
                    <div className="rl-act">
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        disabled={editing !== null}
                        aria-label={`Edit red line: ${r.description}`}
                        onClick={() => {
                          setRowError(null);
                          setEditing(r.id);
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" className="btn btn-small btn-ghost" aria-label={`Remove red line: ${r.description}`} onClick={() => setConfirming(r.id)}>
                        Remove
                      </button>
                    </div>
                  )
                ) : null}
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="muted">None declared yet. Until there is one, nothing an agent writes is checked against your rules; with autonomy below “Posts on its own”, it waits on a person anyway.</p>
      )}
      {canEdit ? (
        editing === "new" ? (
          <div className="rl-new">
            <RedLineForm initial={null} timezone={timezone} competitors={competitors} onCancel={() => setEditing(null)} onSave={save} />
          </div>
        ) : (
          <div className="dsec-act rl-add">
            <button type="button" className="btn" disabled={editing !== null} onClick={() => setEditing("new")}>
              Add a red line
            </button>
          </div>
        )
      ) : (
        <p className="muted small links-note">{readOnlyNote}</p>
      )}
    </>
  );
}

function RedLineForm({
  initial,
  timezone,
  competitors,
  onCancel,
  onSave,
}: {
  initial: RedLine | null;
  timezone: string;
  competitors: string[];
  onCancel: () => void;
  onSave: (line: RedLine) => Promise<void>;
}) {
  const { accountsById } = useRoom();
  const [d, setD] = useState<LineDraft>(() => draftOf(initial, timezone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const set = (p: Partial<LineDraft>) => setD((x) => ({ ...x, ...p }));
  const fid = (f: string) => `rl-${initial?.id ?? "new"}-${f}`;
  const built = build(d);

  // Networks worth offering: the connected ones first, then any already on the line.
  const networks = useMemo(() => {
    const connected = [...new Set([...accountsById.values()].map((a) => a.network))];
    const base = connected.length ? connected : NETWORKS.filter((n) => n !== "news");
    return [...new Set([...base, ...(d.networks as Network[])])];
  }, [accountsById, d.networks]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (!built.line) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(built.line);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const toggleNet = (n: string) => set({ networks: d.networks.includes(n) ? d.networks.filter((x) => x !== n) : [...d.networks, n] });
  const toggleDay = (n: number) => set({ days: d.days.includes(n) ? d.days.filter((x) => x !== n) : [...d.days, n] });

  return (
    <form className="rl-form" onSubmit={(e) => void submit(e)} aria-label={initial ? `Edit red line: ${initial.description}` : "New red line"}>
      <h4 className="rl-form-h">{initial ? "Edit red line" : "New red line"}</h4>
      <label className="field">
        <span>Kind</span>
        <select className="select" value={d.kind} onChange={(e) => set({ kind: e.target.value as RedLineKind })}>
          {RED_LINE_KINDS.map((k) => (
            <option key={k} value={k}>
              {RED_LINE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small rl-hint">{RED_LINE_KIND_HINT[d.kind]}</p>

      <div className="field">
        <span id={fid("sev")}>When a post crosses it</span>
        <div className="seg seg-wide seg-small" role="radiogroup" aria-labelledby={fid("sev")}>
          {SEVERITIES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={d.severity === s} className="seg-btn" onClick={() => set({ severity: s })}>
              {SEVERITY_CHOICE[s].label}
            </button>
          ))}
        </div>
        <span className="muted small">{SEVERITY_CHOICE[d.severity].hint}</span>
      </div>

      <label className="field">
        <span>Description</span>
        <input
          className="input"
          maxLength={200}
          placeholder={DESCRIPTION_PLACEHOLDER[d.kind]}
          value={d.description}
          aria-invalid={tried && !d.description.trim()}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>

      {d.kind === "forbidden_phrase" ? (
        <ChipsInput id={fid("phrases")} label="Phrases" what="phrase" values={d.phrases} onChange={(phrases) => set({ phrases })} placeholder="guaranteed, best in the world" help="Enter or a comma adds one. Matched as whole words, any case." />
      ) : null}

      {d.kind === "forbidden_topic" ? (
        <>
          <ChipsInput id={fid("keywords")} label="Keywords" what="keyword" values={d.keywords} onChange={(keywords) => set({ keywords })} placeholder="election, ballot" help="Words that signal the topic." />
          <label className="check">
            <input type="checkbox" checked={d.semantic} onChange={(e) => set({ semantic: e.target.checked })} />
            <span>
              Also judge by meaning <span className="muted small">· the classifier is asked even when no keyword matches</span>
            </span>
          </label>
        </>
      ) : null}

      {d.kind === "forbidden_claim" ? (
        <div className="field">
          <span>Patterns</span>
          <div className="rl-patterns">
            {d.patterns.map((p, i) => {
              const err = p.trim() ? compilePattern(p).error : null;
              return (
                <div key={i} className="rl-pattern">
                  <span className="rl-slash mono" aria-hidden="true">
                    /
                  </span>
                  <input
                    className="input mono"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="guarantee[sd]? .* results"
                    aria-label={`Pattern ${i + 1}`}
                    aria-invalid={!!err}
                    value={p}
                    onChange={(e) => set({ patterns: d.patterns.map((x, j) => (j === i ? e.target.value : x)) })}
                  />
                  <span className="rl-slash mono" aria-hidden="true">
                    /iu
                  </span>
                  {d.patterns.length > 1 ? (
                    <button type="button" className="btn btn-small btn-ghost" aria-label={`Remove pattern ${i + 1}`} onClick={() => set({ patterns: d.patterns.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  ) : null}
                  {err ? <span className="small field-warn rl-pattern-err">{err}</span> : null}
                </div>
              );
            })}
          </div>
          <div>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => set({ patterns: [...d.patterns, ""] })}>
              Add a pattern
            </button>
          </div>
          <PatternTester patterns={d.patterns.map((p) => p.trim()).filter(Boolean)} flags="i" />
        </div>
      ) : null}

      {d.kind === "custom_regex" ? (
        <div className="field">
          <span id={fid("pattern")}>Pattern</span>
          <div className="rl-pattern">
            <span className="rl-slash mono" aria-hidden="true">
              /
            </span>
            <input
              className="input mono"
              spellCheck={false}
              autoComplete="off"
              aria-labelledby={fid("pattern")}
              aria-invalid={!!(d.pattern.trim() && compilePattern(d.pattern, d.flags).error)}
              placeholder={"\\b(dm|message) us for (a )?discount\\b"}
              value={d.pattern}
              onChange={(e) => set({ pattern: e.target.value })}
            />
            <span className="rl-slash mono" aria-hidden="true">
              /
            </span>
            <input className="input mono rl-flags" spellCheck={false} aria-label="Flags" maxLength={6} value={d.flags} onChange={(e) => set({ flags: e.target.value.replace(/[^dimsuy]/g, "") })} />
            {d.pattern.trim() && compilePattern(d.pattern, d.flags).error ? <span className="small field-warn rl-pattern-err">{compilePattern(d.pattern, d.flags).error}</span> : null}
          </div>
          <span className="muted small">Flags: i ignores case (the usual), m and s change how lines and dots match.</span>
          <PatternTester patterns={d.pattern.trim() ? [d.pattern.trim()] : []} flags={d.flags} />
        </div>
      ) : null}

      {d.kind === "no_competitor_mention" ? (
        <>
          <ChipsInput id={fid("competitors")} label="Competitors" what="competitor" values={d.competitors} onChange={(c) => set({ competitors: c })} placeholder="Blue Bottle, Stumptown" />
          {competitors.some((c) => !d.competitors.includes(c)) ? (
            <div>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => set({ competitors: [...new Set([...d.competitors, ...competitors])] })}>
                Add the brand's competitors ({competitors.join(", ")})
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {d.kind === "quiet_hours" ? (
        <>
          <div className="rl-hours">
            <label className="field">
              <span>From</span>
              <select className="select mono" value={d.startHour} onChange={(e) => set({ startHour: Number(e.target.value) })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hh(h)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Until</span>
              <select className="select mono" value={d.endHour} onChange={(e) => set({ endHour: Number(e.target.value) })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hh(h)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small rl-hint">
            {d.startHour === d.endHour
              ? "Pick different hours."
              : `Nothing goes out from ${hh(d.startHour)} until ${hh(d.endHour)}${d.startHour > d.endHour ? " the next morning" : ""}.`}
          </p>
          <div className="field">
            <span>Timezone</span>
            <TimezonePicker value={d.timezone} onChange={(timezone) => set({ timezone })} label="Quiet hours timezone" now={Date.now()} />
          </div>
          <div className="field">
            <span id={fid("days")}>Days</span>
            <div className="rl-days" role="group" aria-labelledby={fid("days")}>
              {DAY_SHORT.map((name, i) => (
                <button key={name} type="button" className={`chip${d.days.includes(i) ? " chip-on" : ""}`} aria-pressed={d.days.includes(i)} onClick={() => toggleDay(i)}>
                  {name}
                </button>
              ))}
            </div>
            <span className="muted small">{d.days.length ? `Only on ${plural(d.days.length, "day")} a week.` : "None picked: every day."}</span>
          </div>
        </>
      ) : null}

      {d.kind === "required_disclosure" ? (
        <div className="rl-hours">
          <label className="field">
            <span>Text that must appear</span>
            <input className="input" maxLength={100} placeholder="#AIassisted" value={d.requiredText} onChange={(e) => set({ requiredText: e.target.value })} />
          </label>
          <label className="field">
            <span>In</span>
            <select className="select" value={d.when} onChange={(e) => set({ when: e.target.value as When })}>
              {(["ai_assisted", "always", "paid"] as When[]).map((w) => (
                <option key={w} value={w}>
                  {DISCLOSURE_WHEN[w]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {d.kind === "max_posts_per_day" || d.kind === "network_restriction" ? (
        <>
          {d.kind === "max_posts_per_day" ? (
            <label className="field rl-limit">
              <span>Most posts a day</span>
              <input className="input mono" type="number" inputMode="numeric" min={1} step={1} value={d.limit} onChange={(e) => set({ limit: e.target.value })} />
            </label>
          ) : null}
          <div className="field">
            <span id={fid("nets")}>{d.kind === "max_posts_per_day" ? "Networks" : "Never post to"}</span>
            <div className="rl-days" role="group" aria-labelledby={fid("nets")}>
              {networks.map((n) => (
                <button key={n} type="button" className={`chip${d.networks.includes(n) ? " chip-on" : ""}`} aria-pressed={d.networks.includes(n)} onClick={() => toggleNet(n)}>
                  {networkLabel(n)}
                </button>
              ))}
            </div>
            {d.kind === "max_posts_per_day" ? (
              <span className="muted small">{d.networks.length ? "Counted per network picked." : "None picked: counted across all networks together."}</span>
            ) : null}
          </div>
        </>
      ) : null}

      {tried && built.problem ? <p className="small field-warn">{built.problem}</p> : null}
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="dsec-act">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save red line" : "Add red line"}
        </button>
        <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const DESCRIPTION_PLACEHOLDER: Record<RedLineKind, string> = {
  forbidden_phrase: "Never promise guaranteed results",
  forbidden_topic: "We stay out of politics",
  forbidden_claim: "No health claims about coffee",
  no_competitor_mention: "Never name a competitor",
  quiet_hours: "Nothing goes out overnight",
  required_disclosure: "AI-assisted posts say so",
  max_posts_per_day: "No more than three posts a day",
  network_restriction: "We don't post on TikTok",
  custom_regex: "No “DM us for a discount”",
};

/** Paste a sample post and see, live, what each pattern catches. */
function PatternTester({ patterns, flags }: { patterns: string[]; flags: string }) {
  const [sample, setSample] = useState("");
  const results = patterns.map((p) => {
    const c = compilePattern(p, flags);
    const m = c.re && sample ? sample.match(c.re) : null;
    return { p, error: c.error, match: m && m[0] ? m[0] : null };
  });
  const hit = results.some((r) => r.match);
  return (
    <div className="rl-tester">
      <label className="field">
        <span>Try it on a sample</span>
        <textarea className="textarea" rows={2} placeholder="Paste a post to see whether it matches" value={sample} onChange={(e) => setSample(e.target.value)} />
      </label>
      {sample.trim() && patterns.length ? (
        <ul className="rl-results" aria-live="polite">
          {results.map((r) => (
            <li key={r.p} className={r.match ? "rl-hit" : "rl-miss"}>
              <span className="mono rl-result-p">/{r.p}/</span>
              {r.error ? (
                <span className="field-warn"> isn't valid</span>
              ) : r.match ? (
                <span>
                  {" "}
                  matches this sample: <mark className="mono">{r.match}</mark>
                </span>
              ) : (
                <span className="muted"> no match</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {sample.trim() && patterns.length ? <p className={`small ${hit ? "field-warn" : "muted"}`}>{hit ? "This sample crosses the red line." : "This sample is clear."}</p> : null}
    </div>
  );
}

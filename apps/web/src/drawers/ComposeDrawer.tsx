import { useEffect, useMemo, useState } from "react";
import type { Account, ComposePrefill, CreatePostInput, Media, Network, PolicyCheckInput, PolicyDecision, PostDetail, VariantIssue } from "../types";
import { api, errorText, isApiError } from "../api";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { StagePill } from "../components/Pill";
import { useToast } from "../components/Toast";
import { NETWORK_MAX_MEDIA, NETWORK_MAX_TEXT, NETWORK_NEEDS_MEDIA, NETWORK_THREADS, networkLabel, textLength, violationText } from "../lib/format";
import { useRoom } from "../lib/room";
import { dayClockIn, fromLocalInput, toLocalInput, tzName } from "../lib/tz";

type Mode = "now" | "schedule" | "draft";

interface Attachment {
  url: string;
  alt: string;
}

/** One account's version. `text: null` means it still follows the idea as written. */
interface Draft {
  text: string | null;
  thread: string[];
  media: Attachment[];
}

const EMPTY: Draft = { text: null, thread: [], media: [] };
const CHECK_DEBOUNCE_MS = 600;
const HALF_HOUR = 30 * 60_000;

/** The next half hour at least an hour out: a sensible first guess for "Schedule". */
function defaultWhen(): number {
  return Math.ceil((Date.now() + 60 * 60_000) / HALF_HOUR) * HALF_HOUR;
}

function mediaKind(url: string): Media["kind"] {
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return "video";
  if (/\.gif(\?|$)/i.test(url)) return "gif";
  return "image";
}

export function ComposeDrawer({
  prefill,
  reviewer,
  onClose,
  onCreated,
  onOpenAccounts,
}: {
  prefill?: ComposePrefill;
  reviewer?: string;
  onClose: () => void;
  onCreated: (detail: PostDetail) => void;
  onOpenAccounts: () => void;
}) {
  const { accountsById, timezone: tz } = useRoom();
  const toast = useToast();
  const accounts = useMemo(() => [...accountsById.values()], [accountsById]);
  const usable = useMemo(() => accounts.filter((a) => a.status === "active"), [accounts]);

  const [body, setBody] = useState(prefill?.body ?? "");
  const [picked, setPicked] = useState<string[] | null>(null); // null: every connected account, until the person picks
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adapting, setAdapting] = useState(false);
  const [adaptNote, setAdaptNote] = useState<{ tone: "quiet" | "bad"; text: string } | null>(null);
  const [adaptedBy, setAdaptedBy] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("schedule");
  const [when, setWhen] = useState(() => toLocalInput(defaultWhen(), tz));

  const [check, setCheck] = useState<PolicyDecision | null>(null);
  const [checking, setChecking] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [issues, setIssues] = useState<VariantIssue[]>([]);

  // The timezone can arrive with the policy after the drawer opens; keep the default time honest.
  useEffect(() => setWhen(toLocalInput(defaultWhen(), tz)), [tz]);

  const selectedIds = picked ?? usable.map((a) => a.id);
  const selected = usable.filter((a) => selectedIds.includes(a.id));

  const effective = (id: string): { text: string; thread: string[]; media: Attachment[]; follows: boolean } => {
    const d = drafts[id] ?? EMPTY;
    return { text: d.text ?? body, thread: d.thread, media: d.media, follows: d.text === null };
  };

  const updateDraft = (id: string, fn: (d: Draft) => Draft) => {
    setDrafts((all) => ({ ...all, [id]: fn(all[id] ?? EMPTY) }));
    setIssues((list) => list.filter((i) => i.socialAccountId !== id));
  };

  const toggle = (id: string) => {
    setPicked((p) => {
      const cur = p ?? usable.map((a) => a.id);
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    });
  };

  const scheduledMs = mode === "schedule" ? fromLocalInput(when, tz) : null;
  const scheduledIso = scheduledMs !== null ? new Date(scheduledMs).toISOString() : undefined;
  // "Post now" is checked at this minute (quiet hours care); a draft has no time to check.
  const checkAt = mode === "now" ? new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString() : scheduledIso;

  // --- Live red-line check (debounced) ---
  const checkVariants = selected
    .map((a) => {
      const v = effective(a.id);
      return { network: a.network, text: [v.text, ...v.thread].filter((t) => t.trim()).join("\n") };
    })
    .filter((v) => v.text.trim());
  const checkInput: PolicyCheckInput | null = !checkVariants.length
    ? null
    : checkAt
      ? { variants: checkVariants, scheduledAt: checkAt }
      : { variants: checkVariants };
  const checkKey = checkInput ? JSON.stringify(checkInput) : "";

  useEffect(() => {
    if (!checkInput) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setChecking(true);
      api
        .policyCheck(checkInput)
        .then((d) => {
          if (!cancelled) setCheck(d);
        })
        .catch(() => {
          // The gate runs again on submit; a failed dry run only means no early warning.
          if (!cancelled) setCheck(null);
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // Keyed on the serialized input: the object itself is rebuilt every render.
  }, [checkKey]);

  // --- Adapt ---
  async function adapt() {
    const networks = [...new Set(selected.map((a) => a.network))];
    if (!body.trim() || !networks.length) return;
    setAdapting(true);
    setAdaptNote(null);
    try {
      const res = await api.adapt({ body, networks, topicId: prefill?.topicId });
      const byNet = new Map<Network, (typeof res.variants)[number]>(res.variants.map((v) => [v.network, v]));
      setDrafts((all) => {
        const next = { ...all };
        for (const a of selected) {
          const v = byNet.get(a.network);
          if (!v) continue;
          const keepsThread = NETWORK_THREADS.has(a.network);
          const thread = v.thread.filter((s) => s.trim());
          next[a.id] = {
            ...(all[a.id] ?? EMPTY),
            text: keepsThread || !thread.length ? v.text : [v.text, ...thread].join("\n\n"),
            thread: keepsThread ? thread : [],
          };
        }
        return next;
      });
      setAdaptedBy(res.usage.model);
      const notes = Array.isArray(res.notes) ? res.notes.join(" ") : (res.notes ?? "");
      setAdaptNote({ tone: "quiet", text: `${notes ? `${notes} · ` : ""}${res.usage.model} · $${res.usage.costUsd.toFixed(4)}` });
    } catch (e) {
      if (isApiError(e) && e.status === 503) {
        setDrafts((all) => {
          const next = { ...all };
          for (const a of selected) next[a.id] = { ...(all[a.id] ?? EMPTY), text: body };
          return next;
        });
        setAdaptNote({ tone: "quiet", text: "Model not configured; variants start from your text" });
      } else {
        setAdaptNote({ tone: "bad", text: errorText(e) });
      }
    } finally {
      setAdapting(false);
    }
  }

  // --- What stops the primary button ---
  const blocked = check?.verdict === "block";
  const needsApproval = check?.verdict === "require_approval";
  const reason = (() => {
    if (!usable.length) return null;
    if (!selected.length) return "Pick at least one account";
    for (const a of selected) {
      const v = effective(a.id);
      const media = v.media.filter((m) => m.url.trim());
      if (!v.text.trim() && !media.length) return `${networkLabel(a.network)} has nothing to post`;
      const max = NETWORK_MAX_TEXT[a.network];
      if ([v.text, ...v.thread].some((s) => textLength(a.network, s) > max)) return `${networkLabel(a.network)} is over ${max} characters`;
      if (NETWORK_NEEDS_MEDIA.has(a.network) && !media.length) return `${networkLabel(a.network)} needs an image or video`;
    }
    if (mode === "schedule" && (scheduledMs === null || scheduledMs <= Date.now())) return "Pick a time in the future";
    return null;
  })();
  const canSubmit = usable.length > 0 && !reason && !blocked && !submitting;

  const primaryLabel = submitting
    ? mode === "draft"
      ? "Saving…"
      : "Sending…"
    : mode === "draft"
      ? "Save draft"
      : needsApproval
        ? "Send for approval"
        : mode === "now"
          ? "Post now"
          : "Schedule";

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setIssues([]);
    const input: CreatePostInput = {
      body: body.trim() || effective(selected[0]!.id).text,
      actionClass: "new_post",
      variants: selected.map((a) => {
        const v = effective(a.id);
        const media: Media[] = v.media
          .filter((m) => m.url.trim())
          .map((m) => ({ kind: mediaKind(m.url.trim()), url: m.url.trim(), ...(m.alt.trim() ? { alt: m.alt.trim() } : {}) }));
        const thread = NETWORK_THREADS.has(a.network) ? v.thread.filter((s) => s.trim()) : [];
        return { socialAccountId: a.id, text: v.text, ...(media.length ? { media } : {}), ...(thread.length ? { thread } : {}) };
      }),
      disclosure: {
        aiAssisted: adaptedBy !== null,
        aiContributions: adaptedBy !== null ? ["text_drafted"] : [],
        humanReviewed: true,
        ...(reviewer ? { reviewedBy: reviewer } : {}),
        ...(adaptedBy ? { model: adaptedBy } : {}),
      },
    };
    // "Post now" is a schedule for this moment: the gate still decides whether it may go.
    if (mode === "now") input.scheduledAt = new Date().toISOString();
    if (mode === "schedule" && scheduledIso) input.scheduledAt = scheduledIso;
    if (prefill?.topicId) input.trendTopicId = prefill.topicId;
    if (prefill?.stage) input.trendStageAtCreation = prefill.stage;
    if (prefill?.forecastId) input.trendForecastId = prefill.forecastId;

    try {
      const detail = await api.createPost(input);
      const { status, scheduledAt } = detail.post;
      if (status === "blocked") toast("Blocked by a red line", "bad");
      else if (status === "pending_approval") toast("Waiting on approval");
      else if (status === "draft") toast("Saved as draft");
      else if (status === "publishing" || status === "published" || mode === "now") toast("Going out now");
      else if (status === "scheduled" && scheduledAt) toast(`Scheduled for ${dayClockIn(scheduledAt, tz)}`);
      else toast("Saved");
      onCreated(detail);
      onClose();
    } catch (e) {
      if (isApiError(e) && e.status === 400 && Array.isArray(e.details)) {
        const list = (e.details as VariantIssue[]).filter((i) => i && typeof i.code === "string");
        setIssues(list);
        setSubmitError(list.length ? "Some variants need fixing first." : errorText(e));
      } else {
        setSubmitError(errorText(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const issuesFor = (a: Account) => issues.filter((i) => (i.socialAccountId ? i.socialAccountId === a.id : i.network === a.network));
  const unusable = accounts.filter((a) => a.status !== "active");
  const shown = check && check.verdict !== "allow" ? check.violations.filter((v) => v.severity !== "warn").sort((a, b) => (a.severity === "block" ? -1 : 0) - (b.severity === "block" ? -1 : 0)) : [];

  return (
    <Drawer
      title="New post"
      className="drawer-wide"
      subtitle={
        prefill?.topicName ? (
          <>
            <span className="muted">Rides</span>
            <span className="strong">{prefill.topicName}</span>
            {prefill.stage ? <StagePill stage={prefill.stage} title="Stage right now" /> : null}
          </>
        ) : null
      }
      onClose={onClose}
      footer={
        <>
          {check && check.verdict !== "allow" ? (
            <div className={`verdict ${blocked ? "card-blocked" : "card-flag"}`} role={blocked ? "alert" : "status"}>
              <p className="verdict-h">{blocked ? "Blocked by a red line:" : "A human will need to approve:"}</p>
              {shown.length ? (
                <ul className="violations">
                  {shown.map((v, i) => (
                    <li key={i}>
                      {violationText(v.message)}
                      {v.matches.length ? <span className="mono match">{v.matches.join(", ")}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small">{blocked ? "Change the text and it will check again." : "Your autonomy settings send this to an approver."}</p>
              )}
            </div>
          ) : null}
          {submitError ? (
            <div className="card-error" role="alert">
              {submitError}
            </div>
          ) : null}
          <div className="compose-actions">
            <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void submit()}>
              {primaryLabel}
            </button>
            {reason ? <span className="muted small">{reason}</span> : checking ? <span className="muted small">Checking red lines…</span> : null}
            <button type="button" className="btn btn-ghost compose-cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      }
    >
      <section className="dsec">
        <label className="section-h" htmlFor="compose-body">
          The idea
        </label>
        <textarea
          id="compose-body"
          className="textarea"
          rows={4}
          value={body}
          placeholder={prefill?.topicName ? `What do you want to say about ${prefill.topicName}?` : "Write it once. Adapt it for each network below."}
          onChange={(e) => setBody(e.target.value)}
          autoFocus
        />
      </section>

      <section className="dsec">
        <h3 className="section-h">Post to</h3>
        {accounts.length === 0 ? (
          <p className="muted">
            No accounts connected yet.{" "}
            <button type="button" className="linkish strong" onClick={onOpenAccounts}>
              Connect one
            </button>
          </p>
        ) : (
          <div className="acct-chips">
            {usable.map((a) => {
              const on = selectedIds.includes(a.id);
              return (
                <button key={a.id} type="button" className={`chip chip-acct${on ? " chip-acct-on" : ""}`} aria-pressed={on} onClick={() => toggle(a.id)}>
                  <NetworkBadge network={a.network} />
                  <span>@{a.handle}</span>
                </button>
              );
            })}
            {unusable.map((a) => (
              <span key={a.id} className="chip chip-acct chip-acct-off" aria-disabled="true" title="Reconnect it in Accounts to post here">
                <NetworkBadge network={a.network} />
                <span>@{a.handle}</span>
                <span className="chip-acct-why">Needs reconnecting</span>
              </span>
            ))}
          </div>
        )}
        <div className="adapt-row">
          <button type="button" className="btn" disabled={adapting || !body.trim() || !selected.length} onClick={() => void adapt()}>
            {adapting ? "Adapting…" : "Adapt for each network"}
          </button>
          {adaptNote ? <span className={`small ${adaptNote.tone === "bad" ? "card-error" : "muted"}`}>{adaptNote.text}</span> : null}
        </div>
      </section>

      {selected.length ? (
        <section className="dsec">
          <h3 className="section-h">{selected.length === 1 ? "The post" : `${selected.length} variants`}</h3>
          <div className="cv-list">
            {selected.map((a) => (
              <VariantEditor
                key={a.id}
                account={a}
                value={effective(a.id)}
                issues={issuesFor(a)}
                onText={(text) => updateDraft(a.id, (d) => ({ ...d, text }))}
                onFollow={() => updateDraft(a.id, (d) => ({ ...d, text: null }))}
                onThread={(thread) => updateDraft(a.id, (d) => ({ ...d, text: d.text ?? body, thread }))}
                onMedia={(media) => updateDraft(a.id, (d) => ({ ...d, media }))}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="dsec">
        <h3 className="section-h">When</h3>
        <div className="seg seg-wide" role="radiogroup" aria-label="When">
          {(
            [
              ["now", "Post now"],
              ["schedule", "Schedule"],
              ["draft", "Save as draft"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className="seg-btn" onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        {mode === "schedule" ? (
          <div className="when-row">
            <input
              type="datetime-local"
              className="input mono"
              value={when}
              min={toLocalInput(Date.now(), tz)}
              onChange={(e) => setWhen(e.target.value)}
              aria-label={`Date and time, ${tzName(tz)}`}
            />
            <span className="muted small">{tzName(tz)}</span>
          </div>
        ) : (
          <p className="muted small when-hint">{mode === "now" ? "Goes out as soon as the red lines allow." : "Stays here until someone schedules it."}</p>
        )}
      </section>
    </Drawer>
  );
}

function Counter({ network, text }: { network: Network; text: string }) {
  const max = NETWORK_MAX_TEXT[network];
  const n = textLength(network, text);
  return (
    <span className={`mono variant-count${n > max ? " over" : ""}`} title={`${networkLabel(network)} allows ${max} characters`}>
      {n}/{max}
    </span>
  );
}

function VariantEditor({
  account,
  value,
  issues,
  onText,
  onFollow,
  onThread,
  onMedia,
}: {
  account: Account;
  value: { text: string; thread: string[]; media: Attachment[]; follows: boolean };
  issues: VariantIssue[];
  onText: (text: string) => void;
  onFollow: () => void;
  onThread: (thread: string[]) => void;
  onMedia: (media: Attachment[]) => void;
}) {
  const net = account.network;
  const label = networkLabel(net);
  const threads = NETWORK_THREADS.has(net);
  const needsMedia = NETWORK_NEEDS_MEDIA.has(net) && !value.media.some((m) => m.url.trim());
  const parts = 1 + value.thread.length;

  return (
    <div className={`variant cv${issues.length ? " variant-failed" : ""}`}>
      <div className="variant-head">
        <NetworkBadge network={net} />
        <span className="muted">@{account.handle}</span>
        {value.follows ? <span className="tag">Follows the idea</span> : null}
        {parts > 1 ? <span className="mono muted small">1/{parts}</span> : null}
        <Counter network={net} text={value.text} />
      </div>
      <textarea className="textarea" rows={3} value={value.text} aria-label={`${label} text`} onChange={(e) => onText(e.target.value)} />

      {value.thread.map((seg, i) => (
        <div key={i} className="cv-seg">
          <div className="variant-head">
            <span className="mono muted small">
              {i + 2}/{parts}
            </span>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onThread(value.thread.filter((_, j) => j !== i))}>
              Remove
            </button>
            <Counter network={net} text={seg} />
          </div>
          <textarea
            className="textarea"
            rows={2}
            value={seg}
            aria-label={`${label} thread part ${i + 2}`}
            onChange={(e) => onThread(value.thread.map((s, j) => (j === i ? e.target.value : s)))}
          />
        </div>
      ))}

      {value.media.map((m, i) => (
        <div key={i} className="cv-media">
          <input
            className="input"
            type="url"
            placeholder="https://… image URL"
            value={m.url}
            aria-label={`${label} image ${i + 1} URL`}
            onChange={(e) => onMedia(value.media.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
          />
          <input
            className="input"
            placeholder="Alt text"
            value={m.alt}
            aria-label={`${label} image ${i + 1} alt text`}
            onChange={(e) => onMedia(value.media.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)))}
          />
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onMedia(value.media.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}

      {needsMedia ? <p className="cv-need">{label} needs an image or video.</p> : null}

      {issues.map((iss, i) => (
        <div key={i} className="variant-error" role="alert">
          {issueText(iss, net)}
        </div>
      ))}

      <div className="cv-tools">
        {threads ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onThread([...value.thread, ""])}>
            Add to thread
          </button>
        ) : null}
        {value.media.length < NETWORK_MAX_MEDIA[net] ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onMedia([...value.media, { url: "", alt: "" }])}>
            Add image
          </button>
        ) : null}
        {!value.follows ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={onFollow}>
            Back to the idea
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A 400's per-variant issue, in the network's terms. */
function issueText(i: VariantIssue, network: Network): string {
  const label = networkLabel(network);
  const part = typeof i.segment === "number" && i.segment > 0 ? ` (part ${i.segment + 1})` : "";
  switch (i.code) {
    case "empty":
      return `${label} has no text and no media.`;
    case "too_long":
      return `${label} is over ${NETWORK_MAX_TEXT[network]} characters${part}.`;
    case "media_required":
      return `${label} needs an image or video.`;
    case "too_many_media":
      return `${label} takes at most ${NETWORK_MAX_MEDIA[network]} attachments.`;
    case "thread_unsupported":
      return `${label} doesn't do threads.`;
    default:
      return i.message;
  }
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Account, ComposePrefill, CreatePostInput, Media, Network, PolicyCheckInput, PolicyDecision, PostDetail, VariantIssue, VariantOptions } from "../types";
import { api, errorText, isApiError } from "../api";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { StagePill } from "../components/Pill";
import { useToast } from "../components/Toast";
import { capabilitiesFor, kindsFor } from "../lib/connectors";
import { ACCOUNT_STATUS_LABEL, atHandle, NETWORK_MAX_MEDIA, NETWORK_MAX_TEXT, NETWORK_THREADS, networkLabel, plural, textLength, violationText } from "../lib/format";
import { useRoom } from "../lib/room";
import { MediaTray, Thumb, type ItemsUpdate, type MediaItem } from "./compose/MediaTray";
import { defaultPick, NetworkOptions, NO_TIKTOK, variantProblems, wireOptions, type TikTokExtras } from "./compose/NetworkOptions";
import { dayClockIn, fromLocalInput, toLocalInput, tzName } from "../lib/tz";

type Mode = "now" | "schedule" | "draft";

/**
 * One account's version. `text: null` means it still follows the idea as written; `mediaPick: null` means it
 * takes the attachments that suit its network (see defaultPick) until the person picks.
 */
interface Draft {
  text: string | null;
  thread: string[];
  mediaPick: string[] | null;
  options: VariantOptions;
  tiktok: TikTokExtras;
}

interface Effective {
  text: string;
  thread: string[];
  media: MediaItem[];
  picked: string[];
  options: VariantOptions;
  tiktok: TikTokExtras;
  follows: boolean;
  kinds: string[];
  problems: string[];
}

const EMPTY: Draft = { text: null, thread: [], mediaPick: null, options: {}, tiktok: NO_TIKTOK };
const CHECK_DEBOUNCE_MS = 600;
const HALF_HOUR = 30 * 60_000;

/** The next half hour at least an hour out: a sensible first guess for "Schedule". */
function defaultWhen(): number {
  return Math.ceil((Date.now() + 60 * 60_000) / HALF_HOUR) * HALF_HOUR;
}

export function ComposeDrawer({
  prefill,
  reviewer,
  onClose,
  onCreated,
  onOpenAccounts,
  onOpenLinks,
}: {
  prefill?: ComposePrefill;
  reviewer?: string;
  onClose: () => void;
  onCreated: (detail: PostDetail) => void;
  onOpenAccounts: () => void;
  /** The Links drawer, where an owner turns link tracking on. */
  onOpenLinks?: () => void;
}) {
  const { accountsById, connectors, timezone: tz } = useRoom();
  const toast = useToast();
  const accounts = useMemo(() => [...accountsById.values()], [accountsById]);
  // A connector that can't publish (WeChat Official Accounts here: replies only) has nothing to post to.
  const canPost = useCallback((a: Account) => capabilitiesFor(connectors, a)?.publish !== false, [connectors]);
  const usable = useMemo(() => accounts.filter((a) => a.status === "active" && canPost(a)), [accounts, canPost]);

  const [body, setBody] = useState(prefill?.body ?? "");
  const [picked, setPicked] = useState<string[] | null>(null); // null: every connected account, until the person picks
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [items, setItemsState] = useState<MediaItem[]>([]);
  const setItems = useCallback<ItemsUpdate>((fn) => setItemsState(fn), []);
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

  // Link tracking needs a short-link base on the server and the workspace's switch on. Until we know, offer it
  // (the server ignores it when off); once we know it's off, say so once instead of a checkbox per variant.
  const [linkTracking, setLinkTracking] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .linkSettings()
      .then((s) => {
        if (!cancelled) setLinkTracking(s.enabled && !!s.baseUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const tracking = linkTracking !== false;

  // The timezone can arrive with the policy after the drawer opens; keep the default time honest.
  useEffect(() => setWhen(toLocalInput(defaultWhen(), tz)), [tz]);

  const selectedIds = picked ?? usable.map((a) => a.id);
  const selected = usable.filter((a) => selectedIds.includes(a.id));

  const effective = (a: Account): Effective => {
    const d = drafts[a.id] ?? EMPTY;
    const live = new Set(items.map((m) => m.id));
    const picked = (d.mediaPick ?? defaultPick(a.network, items)).filter((id) => live.has(id));
    const media = items.filter((m) => picked.includes(m.id) && m.status !== "failed");
    const kinds = kindsFor(connectors, a);
    return {
      text: d.text ?? body,
      thread: d.thread,
      media,
      picked,
      options: d.options,
      tiktok: d.tiktok,
      follows: d.text === null,
      kinds,
      problems: variantProblems(a.network, kinds, d.options, d.tiktok, media),
    };
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
      const v = effective(a);
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
    if (items.some((m) => m.status === "uploading")) return "Waiting for uploads to finish";
    for (const a of selected) {
      const v = effective(a);
      if (!v.text.trim() && !v.media.length) return `${networkLabel(a.network)} has nothing to post`;
      const max = NETWORK_MAX_TEXT[a.network];
      if ([v.text, ...v.thread].some((s) => textLength(a.network, s) > max)) return `${networkLabel(a.network)} is over ${max} characters`;
      if (v.problems[0]) return v.problems[0];
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
      body: body.trim() || effective(selected[0]!).text,
      actionClass: "new_post",
      variants: selected.map((a) => {
        const v = effective(a);
        const media = v.media.map(toMedia).filter((m): m is Media => m !== null);
        const thread = NETWORK_THREADS.has(a.network) ? v.thread.filter((s) => s.trim()) : [];
        const options = wireOptions(a.network, v.kinds, v.options, v.tiktok, tracking);
        return { socialAccountId: a.id, text: v.text, ...(media.length ? { media } : {}), ...(thread.length ? { thread } : {}), ...(options ? { options } : {}) };
      }),
      disclosure: {
        aiAssisted: adaptedBy !== null,
        aiContributions: adaptedBy !== null ? ["text_drafted"] : [],
        humanReviewed: true,
        ...(reviewer ? { reviewedBy: reviewer } : {}),
        ...(adaptedBy ? { model: adaptedBy } : {}),
      },
    };
    const allMedia = items.map(toMedia).filter((m): m is Media => m !== null);
    if (allMedia.length) input.media = allMedia;
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
  const unusable = accounts.filter((a) => a.status !== "active" || !canPost(a));
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
        <h3 className="section-h">Media</h3>
        <MediaTray items={items} onItems={setItems} />
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
                  <span>{atHandle(a.handle, a.network)}</span>
                </button>
              );
            })}
            {unusable.map((a) => (
              <span
                key={a.id}
                className="chip chip-acct chip-acct-off"
                aria-disabled="true"
                title={a.status === "active" ? `${networkLabel(a.network)} only answers messages here; it can't post` : "Reconnect it in Connections to post here"}
              >
                <NetworkBadge network={a.network} />
                <span>{atHandle(a.handle, a.network)}</span>
                <span className="chip-acct-why">{a.status === "active" ? "Replies only" : ACCOUNT_STATUS_LABEL[a.status]}</span>
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
          {!tracking ? (
            <p className="muted small compose-links-off">
              Link tracking is off, so links go out as written.{" "}
              {onOpenLinks ? (
                <button type="button" className="linkish strong" onClick={onOpenLinks}>
                  Links settings
                </button>
              ) : null}
            </p>
          ) : null}
          <div className="cv-list">
            {selected.map((a) => (
              <VariantEditor
                key={a.id}
                account={a}
                value={effective(a)}
                items={items}
                issues={issuesFor(a)}
                onText={(text) => updateDraft(a.id, (d) => ({ ...d, text }))}
                onFollow={() => updateDraft(a.id, (d) => ({ ...d, text: null }))}
                onThread={(thread) => updateDraft(a.id, (d) => ({ ...d, text: d.text ?? body, thread }))}
                onPick={(mediaPick) => updateDraft(a.id, (d) => ({ ...d, mediaPick }))}
                onOptions={(options) => updateDraft(a.id, (d) => ({ ...d, options }))}
                onTikTok={(tiktok) => updateDraft(a.id, (d) => ({ ...d, tiktok }))}
                linkTracking={tracking}
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
  items,
  issues,
  onText,
  onFollow,
  onThread,
  onPick,
  onOptions,
  onTikTok,
  linkTracking,
}: {
  linkTracking: boolean;
  account: Account;
  value: Effective;
  items: MediaItem[];
  issues: VariantIssue[];
  onText: (text: string) => void;
  onFollow: () => void;
  onThread: (thread: string[]) => void;
  onPick: (ids: string[]) => void;
  onOptions: (o: VariantOptions) => void;
  onTikTok: (t: TikTokExtras) => void;
}) {
  const net = account.network;
  const label = networkLabel(net);
  const threads = NETWORK_THREADS.has(net);
  const parts = 1 + value.thread.length;
  const offered = items.filter((m) => m.status !== "failed");

  const togglePick = (id: string) => {
    const cur = value.picked;
    // Keep the tray's order whatever order things were ticked in.
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : offered.map((m) => m.id).filter((x) => x === id || cur.includes(x));
    onPick(next);
  };

  return (
    <div className={`variant cv${issues.length ? " variant-failed" : ""}`}>
      <div className="variant-head">
        <NetworkBadge network={net} />
        <span className="muted">{atHandle(account.handle, account.network)}</span>
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

      {offered.length ? (
        <div className="cv-media-pick" role="group" aria-label={`${label} attachments`}>
          {offered.map((m) => {
            const on = value.picked.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                className={`pick${on ? " pick-on" : ""}`}
                aria-pressed={on}
                title={on ? `Leave ${m.name} off ${label}` : `Add ${m.name} to ${label}`}
                onClick={() => togglePick(m.id)}
              >
                <Thumb kind={m.kind} url={m.previewUrl} name={m.name} durationSeconds={m.durationSeconds} small />
                <span className="pick-mark" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
              </button>
            );
          })}
          <span className="muted small">
            {value.media.length === offered.length ? (offered.length === 1 ? "Attached" : `All ${offered.length} attached`) : `${value.media.length} of ${plural(offered.length, "file")}`}
            {NETWORK_MAX_MEDIA[net] < offered.length ? ` · takes up to ${NETWORK_MAX_MEDIA[net]}` : ""}
          </span>
        </div>
      ) : null}

      <NetworkOptions network={net} kinds={value.kinds} value={value.options} tiktok={value.tiktok} onChange={onOptions} onTikTok={onTikTok} linkTracking={linkTracking} />

      {value.problems.length ? (
        <ul className="cv-need">
          {value.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

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
        {!value.follows ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={onFollow}>
            Back to the idea
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A ready attachment as the post's Media, with the alt text typed here. */
function toMedia(m: MediaItem): Media | null {
  if (m.status !== "ready" || !m.asset) return null;
  const alt = m.alt.trim();
  const base: Media = m.asset.media ?? { kind: m.asset.kind, url: m.asset.url, mime: m.asset.mime, assetId: m.asset.id };
  const { alt: _old, ...rest } = base;
  return alt ? { ...rest, alt } : rest;
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
    case "title_required":
      return `${label} needs a title.`;
    case "subreddit_required":
      return "Reddit needs a subreddit.";
    case "board_required":
      return "Pinterest needs a board.";
    case "privacy_required":
      return "Choose who can see it on TikTok.";
    case "video_required":
      return `${label} needs a video.`;
    default:
      return i.message;
  }
}

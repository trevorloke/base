import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { LinkPlacement, LinkReport, LinkReportTop, LinkSettingsResponse, Role, TrackedLink } from "../types";
import { api, errorText, isApiError } from "../api";
import { BigNumber } from "../components/BigNumber";
import { Drawer } from "../components/Drawer";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { useToast } from "../components/Toast";
import { compact, plural, truncate } from "../lib/format";
import { formatDateShort, formatRange } from "../lib/time";
import { appUrl } from "../lib/base";

const PLACEMENT_LABEL: Record<LinkPlacement, string> = {
  text: "In the text",
  thread: "In a thread reply",
  link: "Link field",
  first_comment: "First comment",
  manual: "Made here",
};

/** 49 → "$49", 1234.5 → "$1,234.50"; without a currency, just the number. */
function money(value: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
    } catch {
      // unknown currency code: fall through to a plain number with the code after it
      return `${value.toLocaleString()} ${currency}`;
    }
  }
  return value.toLocaleString();
}

/** "YYYY-MM-DD" read at midday UTC, so the label never slips a day in the viewer's time zone. */
function dayLabel(day: string): string {
  return formatDateShort(`${day}T12:00:00Z`);
}

/** "https://nwc.to/guji" → "nwc.to/guji" */
function bareUrl(u: string): string {
  return u.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Copy to the clipboard and say so in the toast (which is the aria-live region). */
function useCopy() {
  const toast = useToast();
  return useCallback(
    async (text: string, what = "link") => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`Copied the ${what}`);
      } catch {
        toast("Couldn't copy. Select the text and copy it by hand.", "bad");
      }
    },
    [toast],
  );
}

/** Short links Base Air put in published posts: who clicked, what they bought, and the settings behind it. */
export function LinksDrawer({ myRole, onClose }: { myRole: Role | null; onClose: () => void }) {
  const toast = useToast();
  const copy = useCopy();
  const canChange = myRole === "owner" || myRole === "approver";
  const canMake = !!myRole && myRole !== "viewer";
  const [report, setReport] = useState<LinkReport | null>(null);
  const [settings, setSettings] = useState<LinkSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(() => {
    setError(null);
    void Promise.allSettled([api.linkReport(), api.linkSettings()]).then(([r, s]) => {
      if (r.status === "fulfilled") setReport(r.value);
      else setError(errorText(r.reason));
      if (s.status === "fulfilled") setSettings(s.value);
    });
  }, []);
  useEffect(load, [load]);

  async function turnOff(l: LinkReportTop) {
    setTurningOff(l.id);
    setRowError(null);
    try {
      await api.disableLink(l.id);
      setConfirming(null);
      toast(`Turned off ${l.shortUrl ? bareUrl(l.shortUrl) : l.slug}`);
      load();
    } catch (e) {
      setRowError({ id: l.id, text: errorText(e) });
    } finally {
      setTurningOff(null);
    }
  }

  const totals = report?.totals;
  const currencies = totals?.valueByCurrency.filter((c) => c.value) ?? [];
  const firstCurrency = currencies[0];
  const valueText = firstCurrency ? money(firstCurrency.value, firstCurrency.currency) : totals?.conversionValue ? money(totals.conversionValue, null) : "—";
  const valueTitle =
    currencies.length > 1 ? `Also ${currencies.slice(1).map((c) => money(c.value, c.currency)).join(", ")}` : "What the conversions were worth, as the site reported it";

  return (
    <Drawer
      title="Links"
      subtitle={report ? <span className="muted mono">{`${formatRange(report.from, report.to)} · ${plural(report.topLinks.length, "link")}`}</span> : null}
      onClose={onClose}
    >
      <PanelState error={error} loading={!report && !error} onRetry={load} />

      {report && !report.configured ? (
        <section className="dsec">
          <h3 className="section-h">Not on yet</h3>
          <p>
            Link tracking turns on when the server has <code className="links-inline-code">BASE_AIR_LINK_BASE_URL</code> set, or a public{" "}
            <code className="links-inline-code">BASE_AIR_PUBLIC_URL</code>. Until then, links in posts go out as written and nothing is counted.
          </p>
        </section>
      ) : null}

      {report && totals && report.configured ? (
        <>
          <section className="dsec">
            <div className="links-nums">
              <BigNumber value={compact(totals.uniqueVisitors)} label="people who clicked" title={`${totals.clicks.toLocaleString()} clicks in all`} />
              <BigNumber value={compact(totals.conversions)} label="conversions" muted={!totals.conversions} />
              <BigNumber
                value={
                  <>
                    {valueText}
                    {currencies.length > 1 ? <span className="links-more"> +{currencies.length - 1} more</span> : null}
                  </>
                }
                label="value"
                title={valueTitle}
                muted={!currencies.length && !totals.conversionValue}
              />
              <BigNumber
                value={compact(totals.previews)}
                label="previews"
                muted
                title="Link-preview crawlers that fetched the link to draw a card. They aren't people and aren't counted as clicks."
              />
            </div>
            <ClickStrip days={report.byDay} />
          </section>

          <section className="dsec">
            <h3 className="section-h">By network</h3>
            {report.byNetwork.length ? (
              <table className="links-table">
                <thead>
                  <tr>
                    <th scope="col">Network</th>
                    <th scope="col">People</th>
                    <th scope="col">Conversions</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byNetwork.map((n) => (
                    <tr key={n.network ?? "none"}>
                      <td>{n.network ? <NetworkBadge network={n.network} /> : <span className="tag">Other</span>}</td>
                      <td className="mono">{compact(n.uniqueVisitors)}</td>
                      <td className="mono">{compact(n.conversions)}</td>
                      <td className="mono">{n.value ? money(n.value, currencies.length === 1 ? (firstCurrency?.currency ?? null) : null) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No clicks in this range yet.</p>
            )}
          </section>

          <section className="dsec">
            <h3 className="section-h">Top links</h3>
            {report.topLinks.length ? (
              <ul className="acct-list">
                {report.topLinks.map((l) => (
                  <li key={l.id} className="acct-row links-row">
                    <div className="acct-main">
                      <div className="acct-id">
                        {l.shortUrl ? <span className="mono strong links-short">{bareUrl(l.shortUrl)}</span> : <span className="mono strong">{l.slug}</span>}
                        {l.shortUrl ? (
                          <button type="button" className="btn btn-small btn-ghost" onClick={() => void copy(l.shortUrl!)} aria-label={`Copy ${bareUrl(l.shortUrl)}`}>
                            Copy
                          </button>
                        ) : null}
                      </div>
                      <a className="links-dest small" href={l.destination} target="_blank" rel="noreferrer" title={l.destination}>
                        {truncate(bareUrl(l.destination), 64)}
                      </a>
                      <div className="acct-meta muted small">
                        {l.network ? <NetworkBadge network={l.network} /> : null}
                        <span className="tag">{PLACEMENT_LABEL[l.placement] ?? l.placement}</span>
                        <span>
                          <span className="mono links-n">{compact(l.clicks)}</span> clicks
                        </span>
                        <span>
                          <span className="mono links-n">{compact(l.uniqueVisitors)}</span> people
                        </span>
                        <span>
                          <span className="mono links-n">{compact(l.conversions)}</span> {l.conversions === 1 ? "conversion" : "conversions"}
                        </span>
                      </div>
                      {rowError?.id === l.id ? (
                        <div className="card-error" role="alert">
                          {rowError.text}
                        </div>
                      ) : null}
                    </div>
                    {canChange ? (
                      confirming === l.id ? (
                        <div className="acct-confirm" role="group" aria-label={`Turn off ${l.slug}?`}>
                          <span>Turn off?</span>
                          <button type="button" className="btn btn-small btn-danger" disabled={turningOff === l.id} onClick={() => void turnOff(l)}>
                            {turningOff === l.id ? "…" : "Yes"}
                          </button>
                          <span className="sep" aria-hidden="true">
                            ·
                          </span>
                          <button type="button" className="btn btn-small btn-ghost" onClick={() => setConfirming(null)}>
                            No
                          </button>
                        </div>
                      ) : (
                        <div className="acct-actions">
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            title="The short link stops working and shows a not-found page"
                            onClick={() => {
                              setRowError(null);
                              setConfirming(l.id);
                            }}
                          >
                            Turn off
                          </button>
                        </div>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No links yet. They appear here once a post with a link goes out.</p>
            )}
          </section>

          {canMake ? <MakeLink onMade={load} /> : null}
        </>
      ) : null}

      {report ? <LinkSettingsSection settings={settings} isOwner={myRole === "owner"} onSaved={setSettings} /> : null}
      {report ? <ConversionSnippet /> : null}
    </Drawer>
  );
}

/** One bar per day. Plain divs; the numbers live in each bar's title and in the summary label. */
function ClickStrip({ days }: { days: LinkReport["byDay"] }) {
  const max = Math.max(1, ...days.map((d) => d.clicks));
  const total = days.reduce((n, d) => n + d.clicks, 0);
  const peak = days.reduce<LinkReport["byDay"][number] | null>((best, d) => (!best || d.clicks > best.clicks ? d : best), null);
  if (!days.length) return null;
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const summary = `${total.toLocaleString()} clicks over ${plural(days.length, "day")}${peak && peak.clicks ? `, most on ${dayLabel(peak.day)} (${peak.clicks})` : ""}`;
  return (
    <div className="links-strip-wrap">
      <div className="links-strip" role="img" aria-label={summary}>
        {days.map((d) => (
          <div key={d.day} className="links-bar" title={`${dayLabel(d.day)}: ${plural(d.clicks, "click")}`}>
            <span className="links-bar-fill" style={{ height: `${d.clicks ? Math.max(4, (d.clicks / max) * 100) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="links-strip-axis muted small">
        <span>{dayLabel(first.day)}</span>
        <span>clicks per day</span>
        <span>{dayLabel(last.day)}</span>
      </div>
    </div>
  );
}

function MakeLink({ onMade }: { onMade: () => void }) {
  const copy = useCopy();
  const [url, setUrl] = useState("");
  const [campaign, setCampaign] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<TrackedLink | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const link = await api.createLink({ url: url.trim(), ...(campaign.trim() ? { campaign: campaign.trim() } : {}) });
      setMade(link);
      setUrl("");
      onMade();
    } catch (err) {
      setError(isApiError(err) && err.status === 503 ? "Short links aren't set up on this server yet." : errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dsec">
      <h3 className="section-h">Make a link</h3>
      <p className="muted small links-lede">For a bio, a newsletter or anywhere Base Air doesn't post for you.</p>
      <form className="links-make" onSubmit={(e) => void submit(e)}>
        <label className="field links-make-url">
          <span>Web address</span>
          <input className="input" type="url" required placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>Campaign (optional)</span>
          <input className="input" placeholder="fall-2026" value={campaign} maxLength={100} onChange={(e) => setCampaign(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
          {busy ? "Making…" : "Make link"}
        </button>
      </form>
      {error ? (
        <div className="card-error" role="alert">
          {error}
        </div>
      ) : null}
      {made?.shortUrl ? (
        <div className="invite-result">
          <div className="invite-link-row">
            <input id="made-link" className="input mono" readOnly value={made.shortUrl} onFocus={(e) => e.currentTarget.select()} aria-label="New short link" />
            <button type="button" className="btn" onClick={() => void copy(made.shortUrl!)}>
              Copy
            </button>
          </div>
          <p className="muted small">Goes to {truncate(bareUrl(made.destination), 60)}</p>
        </div>
      ) : null}
    </section>
  );
}

type Draft = { enabled: boolean; utm: boolean; clickIds: boolean; defaultCampaign: string };

function draftOf(s: LinkSettingsResponse): Draft {
  return { enabled: s.enabled, utm: s.utm, clickIds: s.clickIds, defaultCampaign: s.defaultCampaign ?? "" };
}

function LinkSettingsSection({ settings, isOwner, onSaved }: { settings: LinkSettingsResponse | null; isOwner: boolean; onSaved: (s: LinkSettingsResponse) => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(settings ? draftOf(settings) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setDraft(draftOf(settings));
  }, [settings]);

  const dirty = useMemo(() => {
    if (!settings || !draft) return false;
    const s = draftOf(settings);
    return s.enabled !== draft.enabled || s.utm !== draft.utm || s.clickIds !== draft.clickIds || s.defaultCampaign.trim() !== draft.defaultCampaign.trim();
  }, [settings, draft]);

  if (!settings || !draft) return null;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateLinkSettings({ enabled: draft.enabled, utm: draft.utm, clickIds: draft.clickIds, defaultCampaign: draft.defaultCampaign.trim() });
      onSaved(next);
      toast("Link settings saved");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!isOwner) {
    const onOff = (b: boolean) => (b ? "On" : "Off");
    return (
      <section className="dsec">
        <h3 className="section-h">Settings</h3>
        <dl className="kv">
          <div className="kv-row">
            <dt>Wrap links in posts</dt>
            <dd>{onOff(settings.enabled)}</dd>
          </div>
          <div className="kv-row">
            <dt>Add UTM tags</dt>
            <dd>{onOff(settings.utm)}</dd>
          </div>
          <div className="kv-row">
            <dt>Pass a click id to the site</dt>
            <dd>{onOff(settings.clickIds)}</dd>
          </div>
          <div className="kv-row">
            <dt>Default campaign</dt>
            <dd className="mono">{settings.defaultCampaign || <span className="muted">the post</span>}</dd>
          </div>
        </dl>
        <p className="muted small links-note">Only an owner can change these.</p>
      </section>
    );
  }

  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  return (
    <section className="dsec">
      <h3 className="section-h">Settings</h3>
      <form className="links-settings" onSubmit={(e) => void save(e)}>
        <label className="check">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>
            Wrap links in posts <span className="muted small">· links go out as short links and clicks are counted</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.utm} onChange={(e) => set({ utm: e.target.checked })} />
          <span>
            Add UTM tags <span className="muted small">· source, medium and campaign, for your analytics</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.clickIds} onChange={(e) => set({ clickIds: e.target.checked })} />
          <span>
            Pass a click id to the site <span className="muted small">· adds ssclid, so a sale can be traced back to the post</span>
          </span>
        </label>
        <label className="field links-campaign">
          <span>Default campaign</span>
          <input className="input" placeholder="Blank uses the post" maxLength={100} value={draft.defaultCampaign} onChange={(e) => set({ defaultCampaign: e.target.value })} />
        </label>
        {error ? (
          <div className="card-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="dsec-act">
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </button>
          {dirty && !busy ? (
            <button type="button" className="btn btn-ghost" onClick={() => setDraft(draftOf(settings))}>
              Undo changes
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function ConversionSnippet() {
  const copy = useCopy();
  const snippet = `<script src="${appUrl("/s.js")}" async></script>\n<script>\n  // after a purchase, on the thank-you page\n  baseAir.convert("purchase", 49, "USD");\n</script>`;
  return (
    <section className="dsec">
      <h3 className="section-h">Count conversions</h3>
      <p className="small links-lede">Put this on your site. Call baseAir.convert when someone buys or signs up, with the value and currency if there is one.</p>
      <div className="links-code-head">
        <span className="muted small">HTML</span>
        <button type="button" className="btn btn-small" onClick={() => void copy(snippet, "snippet")}>
          Copy snippet
        </button>
      </div>
      <pre className="links-code">
        <code>{snippet}</code>
      </pre>
      <p className="muted small links-note">
        From your server instead: POST to <code className="links-inline-code">/v1/conversions</code> with an API key and the <code className="links-inline-code">ssclid</code> from the landing URL as{" "}
        <code className="links-inline-code">clickId</code>.
      </p>
    </section>
  );
}

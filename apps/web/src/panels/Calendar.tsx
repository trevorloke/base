import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Network, PostStatus, PostSummary } from "../types";
import { api, errorText } from "../api";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { plural, POST_STATUS_LABEL, truncate } from "../lib/format";
import { useRoom } from "../lib/room";
import { addDays, clockIn, dayClockIn, dayHeadIn, dayKey, rangeIn, tzName, weekStartMs } from "../lib/tz";

type Tone = "scheduled" | "waiting" | "out" | "failed";

const TONE: Partial<Record<PostStatus, Tone>> = {
  approved: "scheduled",
  scheduled: "scheduled",
  publishing: "scheduled",
  pending_approval: "waiting",
  published: "out",
  partially_published: "failed",
  failed: "failed",
};

const LEGEND: { tone: Tone; label: string }[] = [
  { tone: "scheduled", label: "Scheduled" },
  { tone: "waiting", label: "Waiting on you" },
  { tone: "out", label: "Went out" },
  { tone: "failed", label: "Failed" },
];

const WEEKS = 2;

function timeOf(item: PostSummary): number {
  return Date.parse(item.post.publishedAt ?? item.post.scheduledAt ?? item.post.createdAt);
}

function networksOf(item: PostSummary): Network[] {
  return [...new Set(item.variants.map((v) => v.network))];
}

/** Two weeks of what is going out, waiting, and went out, in the workspace's days. */
export function Calendar({ head, refreshTick }: { head: ReactNode; refreshTick: number }) {
  const { timezone: tz } = useRoom();
  const [start, setStart] = useState(() => weekStartMs(Date.now(), tz));
  const [items, setItems] = useState<PostSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The policy (and so the timezone) can arrive after the panel mounts: re-anchor on this week.
  useEffect(() => setStart(weekStartMs(Date.now(), tz)), [tz]);

  const end = addDays(start, WEEKS * 7, tz);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api.calendar(new Date(start).toISOString(), new Date(end).toISOString()));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [start, end]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const days = useMemo(() => Array.from({ length: WEEKS * 7 }, (_, i) => addDays(start, i, tz)), [start, tz]);
  const byDay = useMemo(() => {
    const m = new Map<string, PostSummary[]>();
    for (const item of [...(items ?? [])].sort((a, b) => timeOf(a) - timeOf(b))) {
      const k = dayKey(timeOf(item), tz);
      const list = m.get(k);
      if (list) list.push(item);
      else m.set(k, [item]);
    }
    return m;
  }, [items, tz]);

  const todayKey = dayKey(Date.now(), tz);
  const thisWeek = weekStartMs(Date.now(), tz);
  const shift = (weeks: number) => setStart((s) => addDays(s, weeks * 7, tz));
  const count = items?.length ?? 0;

  return (
    <section className="panel panel-calendar" aria-label="Calendar">
      <header className="panel-head panel-head-center">
        {head}
        <div className="cal-nav">
          <span className="panel-meta mono cal-range">{rangeIn(start, end, tz)}</span>
          <button type="button" className="btn btn-small" onClick={() => shift(-1)} aria-label="Previous week">
            ‹
          </button>
          <button type="button" className="btn btn-small" onClick={() => setStart(thisWeek)} disabled={start === thisWeek}>
            Today
          </button>
          <button type="button" className="btn btn-small" onClick={() => shift(1)} aria-label="Next week">
            ›
          </button>
        </div>
      </header>
      <div className="panel-body">
        <PanelState loading={loading && !items} error={error} onRetry={() => void load()} />

        {items ? (
          <>
            <div className="cal-grid">
              {Array.from({ length: WEEKS }, (_, w) => (
                <div key={w} className="cal-week">
                  {days.slice(w * 7, w * 7 + 7).map((d) => {
                    const k = dayKey(d, tz);
                    const head = dayHeadIn(d, tz);
                    const posts = byDay.get(k) ?? [];
                    const isToday = k === todayKey;
                    const isPast = !isToday && k < todayKey;
                    return (
                      <div key={k} className={`cal-day${isToday ? " cal-today" : ""}${isPast ? " cal-past" : ""}`} aria-label={head.long}>
                        <div className="cal-dayhead">
                          <span>{head.weekday}</span>
                          <span className="mono cal-daynum">{head.day}</span>
                        </div>
                        <ul className="cal-chips">
                          {posts.map((p) => (
                            <li key={p.post.id}>
                              <CalChip item={p} tz={tz} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            <div className="cal-list">
              {count === 0 ? <div className="state state-empty">Nothing on the calendar these two weeks.</div> : null}
              {days.map((d) => {
                const k = dayKey(d, tz);
                const posts = byDay.get(k);
                if (!posts?.length) return null;
                return (
                  <section key={k} className="cal-listday">
                    <h3 className="section-h">
                      {dayHeadIn(d, tz).long}
                      {k === todayKey ? <span className="cal-todaytag"> · Today</span> : null}
                    </h3>
                    <ul>
                      {posts.map((p) => (
                        <li key={p.post.id}>
                          <CalRow item={p} tz={tz} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
      <footer className="cal-foot">
        <span className="cal-legend">
          {LEGEND.map((l) => (
            <span key={l.tone} className={`cal-key cal-${l.tone}`}>
              <span className="cal-swatch" aria-hidden="true" />
              {l.label}
            </span>
          ))}
        </span>
        <span className="muted">
          <span className="mono">{plural(count, "post")}</span> · {tzName(tz)}
        </span>
      </footer>
    </section>
  );
}

function CalChip({ item, tz }: { item: PostSummary; tz: string }) {
  const { openPost } = useRoom();
  const t = timeOf(item);
  const tone = TONE[item.post.status] ?? "scheduled";
  const label = POST_STATUS_LABEL[item.post.status];
  return (
    <button
      type="button"
      className={`cal-chip cal-${tone}`}
      onClick={() => openPost(item.post.id)}
      title={`${label} · ${dayClockIn(t, tz)}\n${item.post.body}`}
      aria-label={`${label}, ${dayClockIn(t, tz)}: ${truncate(item.post.body, 40)}`}
    >
      <span className="cal-chip-top">
        <time className="mono cal-time">{clockIn(t, tz)}</time>
        <span className="cal-nets">
          {networksOf(item).map((n) => (
            <NetworkBadge key={n} network={n} short className="netbadge-xs" />
          ))}
        </span>
      </span>
      <span className="cal-chip-text">{truncate(item.post.body, 40)}</span>
    </button>
  );
}

function CalRow({ item, tz }: { item: PostSummary; tz: string }) {
  const { openPost } = useRoom();
  const t = timeOf(item);
  const tone = TONE[item.post.status] ?? "scheduled";
  return (
    <button type="button" className={`cal-row cal-${tone}`} onClick={() => openPost(item.post.id)}>
      <time className="mono cal-time">{clockIn(t, tz)}</time>
      <span className="cal-row-main">
        <span className="cal-row-meta">
          {networksOf(item).map((n) => (
            <NetworkBadge key={n} network={n} />
          ))}
          <span className="cal-status">{POST_STATUS_LABEL[item.post.status]}</span>
        </span>
        <span className="cal-row-text">{truncate(item.post.body, 90)}</span>
      </span>
    </button>
  );
}

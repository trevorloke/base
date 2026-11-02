import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Account, Activity, ActivityKind, FeedQuery, LiveStatus, Network } from "../types";
import { api, errorText, USE_FIXTURES } from "../api";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { RelativeTime } from "../components/RelativeTime";
import { kindLabel, networkLabel } from "../lib/format";
import { useRoom } from "../lib/room";

type KindFilter = "all" | ActivityKind;

const KIND_CHIPS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mention", label: "Mentions" },
  { id: "reply", label: "Replies" },
  { id: "comment", label: "Comments" },
  { id: "dm", label: "DMs" },
];

const LIVE_LABEL: Record<LiveStatus, string> = { live: "Live", connecting: "Reconnecting…", off: "Paused" };

export function Feed({ accounts, liveTick, liveStatus }: { accounts: Account[]; liveTick: number; liveStatus: LiveStatus }) {
  const { streamsById } = useRoom();
  const [kind, setKind] = useState<KindFilter>("all");
  const [network, setNetwork] = useState<Network | null>(null);
  const [items, setItems] = useState<Activity[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());

  const networks = useMemo(() => Array.from(new Set(accounts.map((a) => a.network))), [accounts]);
  const query = useMemo<FeedQuery>(
    () => ({ kinds: kind === "all" ? undefined : [kind], networks: network ? [network] : undefined, limit: 60 }),
    [kind, network],
  );

  const itemsRef = useRef<Activity[] | null>(null);
  itemsRef.current = items;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.feed(query));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Fetch what arrived since the newest row and put it on top. */
  const refreshSince = useCallback(async () => {
    const current = itemsRef.current;
    const since = current?.[0]?.occurredAt;
    try {
      const incoming = await api.feed(since ? { ...query, since } : query);
      if (!incoming.length) return;
      const seen = new Set((current ?? []).map((a) => a.id));
      const add = incoming.filter((a) => !seen.has(a.id));
      if (!add.length) return;
      setItems([...add, ...(current ?? [])]);
      setFresh((f) => new Set([...f, ...add.map((a) => a.id)]));
    } catch {
      // the next event or poll will try again
    }
  }, [query]);

  const seenTick = useRef(liveTick);
  useEffect(() => {
    if (liveTick === seenTick.current) return;
    seenTick.current = liveTick;
    void refreshSince();
  }, [liveTick, refreshSince]);

  // Without a live connection, poll quietly.
  useEffect(() => {
    if (liveStatus === "live") return;
    const id = window.setInterval(() => void refreshSince(), 60_000);
    return () => window.clearInterval(id);
  }, [liveStatus, refreshSince]);

  return (
    <section className="panel panel-feed" aria-labelledby="feed-title">
      <header className="panel-head">
        <h2 id="feed-title">Feed</h2>
        <span className={`live live-${liveStatus}`}>
          <span className="live-dot" aria-hidden="true" />
          {LIVE_LABEL[liveStatus]}
          {USE_FIXTURES ? " · sample" : ""}
        </span>
      </header>
      <div className="chips" role="toolbar" aria-label="Filters">
        {KIND_CHIPS.map((c) => (
          <button key={c.id} type="button" className={`chip${kind === c.id ? " chip-on" : ""}`} aria-pressed={kind === c.id} onClick={() => setKind(c.id)}>
            {c.label}
          </button>
        ))}
        {networks.length ? <span className="chips-sep" aria-hidden="true" /> : null}
        {networks.map((n) => (
          <button
            key={n}
            type="button"
            className={`chip chip-net${network === n ? " chip-on" : ""}`}
            data-network={n}
            aria-pressed={network === n}
            onClick={() => setNetwork(network === n ? null : n)}
          >
            {networkLabel(n)}
          </button>
        ))}
      </div>
      <div className="panel-body">
        <PanelState loading={loading && !items} error={error} onRetry={() => void load()} empty={items && items.length === 0 ? "Quiet. Nothing matches these filters yet." : null} />
        {items?.map((a) => {
          const streams = a.matchedStreams.map((id) => streamsById.get(id)?.name).filter((n): n is string => !!n);
          return (
            <article key={a.id} className={`feed-row${fresh.has(a.id) ? " feed-fresh" : ""}`}>
              <div className="feed-head">
                <span className="feed-author">{a.authorName ?? a.authorHandle ?? "Someone"}</span>
                {a.authorHandle ? <span className="feed-handle muted">@{a.authorHandle}</span> : null}
                <NetworkBadge network={a.network} />
                <span className="feed-kind muted">{kindLabel(a.kind)}</span>
                <RelativeTime iso={a.occurredAt} className="feed-time" />
              </div>
              {a.text ? <p className="feed-text">{a.text}</p> : null}
              {streams.length || a.url ? (
                <div className="feed-foot">
                  {streams.map((name) => (
                    <span key={name} className="tag">
                      {name}
                    </span>
                  ))}
                  {a.url ? (
                    <a className="feed-link" href={a.url} target="_blank" rel="noopener noreferrer">
                      Open ↗
                    </a>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

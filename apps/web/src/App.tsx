import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Account, LiftByStage, Me, Policy, PostSummary, RadarEntry, Stream, Summary } from "./types";
import { api, errorText, getApiKey, isApiError, setApiKey, USE_FIXTURES } from "./api";
import { BigNumber } from "./components/BigNumber";
import { Tabs, type TabDef } from "./components/Tabs";
import { ToastProvider } from "./components/Toast";
import { PostDrawer } from "./drawers/PostDrawer";
import { TopicDrawer } from "./drawers/TopicDrawer";
import { AUTONOMY_LABEL, lift as formatLift } from "./lib/format";
import { RoomProvider, type RoomRefs } from "./lib/room";
import { isoDaysAgo, isoNow } from "./lib/time";
import { useLive } from "./lib/useLive";
import { Brief } from "./panels/Brief";
import { Feed } from "./panels/Feed";
import { Queue } from "./panels/Queue";
import { Radar } from "./panels/Radar";

type Theme = "light" | "dark";
const THEME_STORAGE = "meridian.theme";
const TAB_STORAGE = "meridian.tab";

// --- Theme ---------------------------------------------------------------

function readStoredTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_STORAGE);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Follows the system until the person picks; the pick is remembered in localStorage. */
function useTheme(): { theme: Theme; toggle: () => void } {
  const [stored, setStored] = useState<Theme | null>(readStoredTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (stored) document.documentElement.setAttribute("data-theme", stored);
    else document.documentElement.removeAttribute("data-theme");
  }, [stored]);

  const theme = stored ?? system;
  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setStored(next);
    try {
      localStorage.setItem(THEME_STORAGE, next);
    } catch {
      // fine: the choice lasts for this page load
    }
  }, [theme]);

  return { theme, toggle };
}

// --- App -----------------------------------------------------------------

export function App() {
  const [key, setKey] = useState<string | null>(() => getApiKey());
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const { theme, toggle } = useTheme();

  const disconnect = useCallback((message?: string) => {
    setApiKey(null);
    setKey(null);
    setGateMessage(message ?? null);
  }, []);

  const connected = USE_FIXTURES || key !== null;
  if (!connected) {
    return (
      <ConnectPanel
        initialError={gateMessage}
        theme={theme}
        onToggleTheme={toggle}
        onConnected={(k) => {
          setGateMessage(null);
          setKey(k);
        }}
      />
    );
  }

  return (
    <ToastProvider>
      <Room key={key ?? "fixtures"} theme={theme} onToggleTheme={toggle} onDisconnect={disconnect} />
    </ToastProvider>
  );
}

// --- Key gate ------------------------------------------------------------

function ConnectPanel({
  onConnected,
  initialError,
  theme,
  onToggleTheme,
}: {
  onConnected: (key: string) => void;
  initialError: string | null;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const k = value.trim();
    if (!k) return;
    setBusy(true);
    setError(null);
    setApiKey(k); // the client reads the key from storage
    try {
      await api.me();
      onConnected(k);
    } catch (err) {
      setApiKey(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="gate">
      <form className="gate-card" onSubmit={(e) => void submit(e)}>
        <div className="brand">Meridian</div>
        <h1>Connect to Meridian</h1>
        <p className="muted">Paste a workspace API key. It stays in this browser.</p>
        <label className="field">
          <span>API key</span>
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="mer_…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>
        {error ? (
          <div className="card-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
          {busy ? "Checking…" : "Connect"}
        </button>
        <p className="hint muted small">
          No key yet? Run <code className="mono">pnpm seed</code> to mint a dev key.
        </p>
      </form>
      <button type="button" className="btn btn-ghost gate-theme" onClick={onToggleTheme}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </main>
  );
}

// --- The room ------------------------------------------------------------

type DrawerState = { kind: "post"; id: string } | { kind: "topic"; id: string } | null;

function Room({ theme, onToggleTheme, onDisconnect }: { theme: Theme; onToggleTheme: () => void; onDisconnect: (message?: string) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [streams, setStreams] = useState<Stream[]>([]);

  const [radar, setRadar] = useState<RadarEntry[] | null>(null);
  const [radarLoading, setRadarLoading] = useState(true);
  const [radarError, setRadarError] = useState<string | null>(null);

  const [queue, setQueue] = useState<PostSummary[] | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [liftRows, setLiftRows] = useState<LiftByStage[] | null>(null);

  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [tab, setTab] = useState<string>(() => {
    try {
      return localStorage.getItem(TAB_STORAGE) ?? "queue";
    } catch {
      return "queue";
    }
  });

  const live = useLive(true);

  // Identity doubles as the key check: a 401/403 sends the person back to the gate.
  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((m) => {
        if (cancelled) return;
        setMe(m);
        setOffline(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isApiError(e) && (e.status === 401 || e.status === 403)) onDisconnect(errorText(e));
        else setOffline(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [onDisconnect]);

  const loadRefs = useCallback(async () => {
    const [p, a, s] = await Promise.allSettled([api.policy(), api.accounts(), api.streams()]);
    if (p.status === "fulfilled") setPolicy(p.value);
    if (a.status === "fulfilled") setAccounts(a.value);
    if (s.status === "fulfilled") setStreams(s.value);
  }, []);

  const loadRadar = useCallback(async () => {
    setRadarLoading(true);
    try {
      setRadar(await api.radar());
      setRadarError(null);
    } catch (e) {
      setRadarError(errorText(e));
    } finally {
      setRadarLoading(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      setQueue(await api.queue());
      setQueueError(null);
    } catch (e) {
      setQueueError(errorText(e));
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const loadMetrics = useCallback(async () => {
    const from = isoDaysAgo(7);
    const to = isoNow();
    const [s, l] = await Promise.allSettled([api.summary(from, to), api.liftByStage(from, to)]);
    if (s.status === "fulfilled") setSummary(s.value);
    if (l.status === "fulfilled") setLiftRows(l.value);
  }, []);

  useEffect(() => {
    void loadRefs();
    void loadRadar();
    void loadQueue();
    void loadMetrics();
  }, [loadRefs, loadRadar, loadQueue, loadMetrics]);

  // Live: a post changed → queue and the numbers; a forecast landed → radar (debounced, they come in bursts).
  const postTick = live.counters.post;
  const forecastTick = live.counters.forecast;
  useEffect(() => {
    if (postTick === 0) return;
    void loadQueue();
    void loadMetrics();
  }, [postTick, loadQueue, loadMetrics]);
  useEffect(() => {
    if (forecastTick === 0) return;
    const t = window.setTimeout(() => void loadRadar(), 1200);
    return () => window.clearTimeout(t);
  }, [forecastTick, loadRadar]);

  const onDecided = useCallback((id: string) => {
    setQueue((q) => q?.filter((item) => item.post.id !== id) ?? null);
  }, []);

  const refs = useMemo<RoomRefs>(
    () => ({
      accountsById: new Map(accounts.map((a) => [a.id, a])),
      streamsById: new Map(streams.map((s) => [s.id, s])),
      topicsById: new Map((radar ?? []).map((r) => [r.topic.id, r.topic])),
      openPost: (id) => setDrawer({ kind: "post", id }),
      openTopic: (id) => setDrawer({ kind: "topic", id }),
    }),
    [accounts, streams, radar],
  );

  const closeDrawer = useCallback(() => setDrawer(null), []);

  const changeTab = (id: string) => {
    setTab(id);
    try {
      localStorage.setItem(TAB_STORAGE, id);
    } catch {
      // fine
    }
  };

  const waiting = queue?.length ?? null;
  const wentOut = summary ? summary.publishedByNetwork.reduce((n, g) => n + g.posts, 0) : null;
  const risingRow = liftRows?.find((r) => r.stage === "rising") ?? null;
  const risingLift = risingRow && risingRow.posts > 0 ? formatLift(risingRow.lift) : null;
  const newPostAutonomy = policy?.autonomy.new_post ?? null;

  const retryAll = () => {
    setOffline(null);
    void api
      .me()
      .then((m) => setMe(m))
      .catch((e: unknown) => setOffline(errorText(e)));
    void loadRefs();
    void loadRadar();
    void loadQueue();
    void loadMetrics();
  };

  const tabs: TabDef[] = [
    { id: "radar", label: "Radar" },
    { id: "queue", label: "Queue", badge: waiting ?? undefined },
    { id: "feed", label: "Feed" },
    { id: "brief", label: "Brief" },
  ];

  return (
    <RoomProvider value={refs}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-id">
              <span className="brand">Meridian</span>
              <span className="ws-name">{me?.workspace.name ?? (offline ? "Offline" : "")}</span>
            </div>
            {newPostAutonomy || USE_FIXTURES ? (
              <div className="topbar-chips">
                {newPostAutonomy ? (
                  <span className="chip chip-static" title="What agents may do with new posts">
                    New posts: {AUTONOMY_LABEL[newPostAutonomy].toLowerCase()}
                  </span>
                ) : null}
                {USE_FIXTURES ? <span className="chip chip-static chip-sample">Sample data</span> : null}
              </div>
            ) : null}
          </div>
          <div className="topbar-nums">
            <BigNumber value={waiting ?? "—"} label="waiting on you" muted={waiting === 0} />
            <BigNumber value={wentOut ?? "—"} label="went out this week" />
            <BigNumber
              value={risingLift ?? "—"}
              label={risingLift ? "lift on rising topics" : "no rising posts yet"}
              muted={!risingLift}
              title="Engagement on posts that rode a rising topic, against the baseline"
            />
          </div>
          <div className="topbar-right">
            <button type="button" className="btn btn-ghost" onClick={onToggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
            {!USE_FIXTURES ? (
              <button type="button" className="btn btn-ghost" onClick={() => onDisconnect()}>
                Disconnect
              </button>
            ) : null}
          </div>
        </header>

        {offline ? (
          <div className="banner" role="alert">
            <span>{offline} Showing what loaded.</span>
            <button type="button" className="btn btn-small" onClick={retryAll}>
              Retry
            </button>
          </div>
        ) : null}

        <main className="room" data-tab={tab}>
          <div className="col col-radar" data-panel="radar">
            <Radar entries={radar} loading={radarLoading} error={radarError} onRetry={() => void loadRadar()} />
          </div>
          <div className="col col-center">
            <div className="col-queue" data-panel="queue">
              <Queue items={queue} loading={queueLoading} error={queueError} onRetry={() => void loadQueue()} onDecided={onDecided} />
            </div>
            <div className="col-feed" data-panel="feed">
              <Feed accounts={accounts} liveTick={live.counters.activity} liveStatus={live.status} />
            </div>
          </div>
          <div className="col col-brief" data-panel="brief">
            <Brief policy={policy} alertTick={live.counters.alert} />
          </div>
        </main>

        <Tabs tabs={tabs} active={tab} onChange={changeTab} />

        {drawer?.kind === "post" ? <PostDrawer id={drawer.id} onClose={closeDrawer} /> : null}
        {drawer?.kind === "topic" ? <TopicDrawer id={drawer.id} onClose={closeDrawer} /> : null}
      </div>
    </RoomProvider>
  );
}

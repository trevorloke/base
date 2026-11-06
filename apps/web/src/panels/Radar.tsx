import type { RadarEntry, TrendSource } from "../types";
import { StagePill } from "../components/Pill";
import { PanelState } from "../components/PanelState";
import { Sparkline } from "./Sparkline";
import { compact, pct, plural, sourceLabel, STAGE_HINT } from "../lib/format";
import { hoursLabel, relativeTime } from "../lib/time";
import { useRoom } from "../lib/room";

const THIN = 0.4;

export function Radar({
  entries,
  loading,
  error,
  onRetry,
  sources,
}: {
  entries: RadarEntry[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  sources: TrendSource[] | null;
}) {
  const { openTopic } = useRoom();
  return (
    <section className="panel panel-radar" aria-labelledby="radar-title">
      <header className="panel-head">
        <h2 id="radar-title">Radar</h2>
        <span className="panel-meta mono">{entries ? plural(entries.length, "topic") : ""}</span>
      </header>
      <div className="panel-body">
        <PanelState loading={loading && !entries} error={error} onRetry={onRetry} empty={entries && entries.length === 0 ? "Nothing on the radar yet. Topics appear as Starsign spots trending terms that fit your brand profile, and for each name you follow in the Tracker." : null} />
        {entries?.map((e) => <RadarRow key={e.topic.id} entry={e} onOpen={() => openTopic(e.topic.id)} />)}
      </div>
      {sources && sources.length ? <Sources sources={sources} /> : null}
    </section>
  );
}

const FRESH_MS = 2 * 3_600_000;

/** Where the radar's numbers come from, and whether each source is keeping up. */
function Sources({ sources }: { sources: TrendSource[] }) {
  const now = Date.now();
  const total = sources.reduce((n, s) => n + s.pointsLast24h, 0);
  return (
    <footer className="sources" aria-label="Trend sources">
      <span className="sources-h">Sources</span>
      <ul className="sources-list">
        {sources.map((s) => {
          const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
          const state = !s.configured ? "off" : !s.lastError && Number.isFinite(last) && now - last <= FRESH_MS ? "fresh" : "stale";
          const why = !s.configured
            ? "not configured"
            : s.lastError
              ? `last pull failed: ${s.lastError}`
              : s.lastRunAt
                ? `pulled ${relativeTime(s.lastRunAt, now)}`
                : "never pulled";
          return (
            <li key={s.name} className={`source source-${state}`} title={`${sourceLabel(s.name)}: ${why} · ${s.pointsLast24h} points in 24h`}>
              <span className="source-dot" aria-hidden="true" />
              {sourceLabel(s.name)}
            </li>
          );
        })}
      </ul>
      <span className="mono sources-n">{compact(total)} points in 24h</span>
    </footer>
  );
}

function RadarRow({ entry, onOpen }: { entry: RadarEntry; onOpen: () => void }) {
  const { topic, forecast, window: win, actedOn } = entry;
  const thin = forecast !== null && forecast.confidence < THIN;
  const rising = forecast?.stage === "rising";
  const sub = win ?? (forecast ? STAGE_HINT[forecast.stage] : "no forecast yet");

  return (
    <button type="button" className="radar-row" onClick={onOpen} aria-label={`${topic.name}, open details`}>
      <div className="radar-text">
        <div className="radar-name-line">
          <span className="radar-name">{topic.name}</span>
          {forecast ? <StagePill stage={forecast.stage} /> : null}
        </div>
        <div className={`radar-window${win ? " radar-window-act" : ""}`}>{sub}</div>
        {forecast ? (
          <div className="radar-stats">
            <span>
              <b className="mono">{pct(forecast.confidence)}</b> confidence
            </span>
            {rising && forecast.hoursToPeak !== null ? (
              <span>
                <b className="mono">{hoursLabel(forecast.hoursToPeak)}</b> to peak
              </span>
            ) : null}
            {actedOn > 0 ? (
              <span>
                <b className="mono">{actedOn}</b> {actedOn === 1 ? "post rode it" : "posts rode it"}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="radar-chart">
        {forecast ? (
          <Sparkline forecast={forecast.curve} stage={forecast.stage} thin={thin} width={112} height={40} title={`${topic.name}: forecast for the next 24h`} />
        ) : (
          <div className="spark spark-empty" style={{ width: 112, height: 40 }}>
            no forecast
          </div>
        )}
        {thin ? <span className="thin-label">thin data</span> : null}
      </div>
    </button>
  );
}

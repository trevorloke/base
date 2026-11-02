import type { RadarEntry } from "../types";
import { StagePill } from "../components/Pill";
import { PanelState } from "../components/PanelState";
import { Sparkline } from "./Sparkline";
import { pct, plural, STAGE_HINT } from "../lib/format";
import { hoursLabel } from "../lib/time";
import { useRoom } from "../lib/room";

const THIN = 0.4;

export function Radar({ entries, loading, error, onRetry }: { entries: RadarEntry[] | null; loading: boolean; error: string | null; onRetry: () => void }) {
  const { openTopic } = useRoom();
  return (
    <section className="panel panel-radar" aria-labelledby="radar-title">
      <header className="panel-head">
        <h2 id="radar-title">Radar</h2>
        <span className="panel-meta mono">{entries ? plural(entries.length, "topic") : ""}</span>
      </header>
      <div className="panel-body">
        <PanelState loading={loading && !entries} error={error} onRetry={onRetry} empty={entries && entries.length === 0 ? "Nothing on the radar yet." : null} />
        {entries?.map((e) => <RadarRow key={e.topic.id} entry={e} onOpen={() => openTopic(e.topic.id)} />)}
      </div>
    </section>
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

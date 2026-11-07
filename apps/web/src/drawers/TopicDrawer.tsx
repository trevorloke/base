import { useEffect, useState } from "react";
import type { TopicDetail } from "../types";
import { api, errorText } from "../api";
import { BigNumber } from "../components/BigNumber";
import { Drawer } from "../components/Drawer";
import { PanelState } from "../components/PanelState";
import { StagePill } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { compact, lift, pct, perHour, plural, sourceLabel, STAGE_HINT, STAGE_LABEL } from "../lib/format";
import { hoursLabel } from "../lib/time";
import { useRoom } from "../lib/room";
import { Sparkline } from "../panels/Sparkline";

const THIN = 0.4;

export function TopicDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { openPost, openCompose } = useRoom();
  const [data, setData] = useState<TopicDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .topic(id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const fc = data?.forecast ?? null;
  const thin = fc !== null && fc.confidence < THIN;

  return (
    <Drawer
      title={data?.topic.name ?? "Topic"}
      subtitle={
        fc ? (
          <>
            <StagePill stage={fc.stage} />
            <span className="muted">
              {STAGE_HINT[fc.stage]} · forecast <RelativeTime iso={fc.computedAt} />
            </span>
          </>
        ) : data ? (
          <span className="muted">no forecast yet</span>
        ) : null
      }
      onClose={onClose}
    >
      <PanelState error={error} loading={!data && !error} />
      {data ? (
        <>
          <section className="dsec dsec-act">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                openCompose({
                  topicId: data.topic.id,
                  topicName: data.topic.name,
                  stage: fc?.stage,
                  forecastId: fc?.id,
                })
              }
            >
              Draft a post on this
            </button>
            <span className="muted small">{fc ? `Rides it while it's ${STAGE_LABEL[fc.stage].toLowerCase()}` : "Rides it before there's a forecast"}</span>
          </section>
          {fc ? (
            <section className="dsec">
              <div className="stat-grid">
                <BigNumber value={pct(fc.confidence)} label={thin ? "confidence · thin data" : "confidence"} />
                <BigNumber
                  value={fc.hoursToPeak !== null ? hoursLabel(fc.hoursToPeak) : "—"}
                  label={fc.hoursToPeak !== null ? "to peak" : "no peak ahead"}
                  muted={fc.hoursToPeak === null}
                />
                <BigNumber value={perHour(fc.velocity)} label="velocity" />
                <BigNumber
                  value={fc.sources.length}
                  label={fc.sourceAgreement !== null ? `${fc.sources.length === 1 ? "source" : "sources"} · agree ${pct(fc.sourceAgreement)}` : fc.sources.length === 1 ? "source" : "sources"}
                />
              </div>
              <div className="chart-block">
                <div className="chart-head">
                  <span className="section-h">Next 24h</span>
                  <span className="muted small">{thin ? "thin data: the band is a rough guess" : "band: where the value is likely to land"}</span>
                </div>
                <Sparkline forecast={fc.curve.slice(0, 24)} stage={fc.stage} thin={thin} width={440} height={120} className="spark-big" title={`${data.topic.name}: forecast for the next 24h`} />
                <div className="chart-axis mono">
                  <span>now</span>
                  <span>+12h</span>
                  <span>+24h</span>
                </div>
              </div>
            </section>
          ) : null}

          <section className="dsec">
            <h3 className="section-h">Sources, last 48h</h3>
            {data.series.length === 0 ? <p className="muted">No observations yet.</p> : null}
            {data.series.map((s) => {
              const cutoff = Date.now() - 48 * 3_600_000;
              const recent = s.points.filter((p) => Date.parse(p.t) >= cutoff);
              const shown = recent.length >= 2 ? recent : s.points.slice(-48);
              const last = s.points[s.points.length - 1];
              return (
                <div key={s.source} className="source-row">
                  <div className="source-meta">
                    <span className="source-name">{sourceLabel(s.source)}</span>
                    <span className="mono muted">{last ? compact(last.v) : "—"}</span>
                  </div>
                  <Sparkline forecast={[]} history={shown} width={440} height={36} className="spark-wide" title={`${sourceLabel(s.source)}, last 48h`} />
                </div>
              );
            })}
            {data.series.length ? (
              <div className="chart-axis mono">
                <span>−48h</span>
                <span>−24h</span>
                <span>now</span>
              </div>
            ) : null}
            <p className="muted small">Each source on its own scale; the forecast above combines them.</p>
          </section>

          <section className="dsec">
            <h3 className="section-h">{data.actions.length ? `${plural(data.actions.length, "post")} rode this topic` : "No posts have ridden this topic yet"}</h3>
            {data.actions.length ? (
              <ul className="actions">
                {data.actions.map((a) => (
                  <li key={a.postId}>
                    <button type="button" className="action-row" onClick={() => openPost(a.postId)}>
                      <span className="action-when">
                        {a.stageAtAction ? <StagePill stage={a.stageAtAction} title="Stage when it went out" /> : null}
                        <RelativeTime iso={a.createdAt} />
                      </span>
                      <span className="action-outcome">{outcomeText(a.outcome24h)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <details className="dsec details">
            <summary>Details</summary>
            <dl className="kv">
              <dt>Topic</dt>
              <dd className="mono">{data.topic.id}</dd>
              {fc ? (
                <>
                  <dt>Forecast</dt>
                  <dd className="mono">{fc.id}</dd>
                  <dt>Stage</dt>
                  <dd className="mono">{STAGE_LABEL[fc.stage]}</dd>
                </>
              ) : null}
              <dt>Keywords</dt>
              <dd>{data.topic.keywords.join(", ") || "—"}</dd>
              <dt>Relevance</dt>
              <dd className="mono">{data.topic.relevance === null ? "not scored" : pct(data.topic.relevance)}</dd>
            </dl>
          </details>
        </>
      ) : null}
    </Drawer>
  );
}

function outcomeText(o: Record<string, unknown> | null): string {
  if (!o) return "24h outcome not in yet";
  const parts: string[] = [];
  if (typeof o.impressions === "number") parts.push(`${compact(o.impressions)} impressions`);
  if (typeof o.engagements === "number") parts.push(`${compact(o.engagements)} engagements`);
  if (typeof o.lift === "number") parts.push(`${lift(o.lift)} lift`);
  if (!parts.length) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number") parts.push(`${compact(v)} ${k.replace(/_/g, " ")}`);
    }
  }
  return parts.length ? `24h: ${parts.join(" · ")}` : "24h outcome captured";
}

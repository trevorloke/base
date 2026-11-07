import { useCallback, useEffect, useState } from "react";
import type { Alert, AlertSeverity, Brief as BriefDoc, Policy } from "../types";
import { api, errorText } from "../api";
import { PanelState } from "../components/PanelState";
import { Pill, type PillTone } from "../components/Pill";
import { RelativeTime } from "../components/RelativeTime";
import { useToast } from "../components/Toast";
import { ACTION_CLASS_LABEL, ACTION_CLASS_ORDER, ALERT_SEVERITY_LABEL, AUTONOMY_LABEL, plural, SEVERITY_LABEL, truncate } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";
import { formatRange } from "../lib/time";
import { useRoom } from "../lib/room";

const ALERT_TONE: Record<AlertSeverity, PillTone> = { urgent: "bad", attention: "warn", info: "info" };

export function Brief({ policy, alertTick }: { policy: Policy | null; alertTick: number }) {
  const { openTopic, topicsById, openSettings } = useRoom();
  const toast = useToast();
  const [brief, setBrief] = useState<BriefDoc | null | undefined>(undefined);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const loadBrief = useCallback(async () => {
    setBriefError(null);
    try {
      setBrief(await api.latestBrief());
    } catch (e) {
      setBriefError(errorText(e));
    }
  }, []);

  const loadAlerts = useCallback(async () => {
    setAlertsError(null);
    try {
      setAlerts(await api.alerts());
    } catch (e) {
      setAlertsError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void loadBrief();
  }, [loadBrief]);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts, alertTick]);

  async function ack(id: string) {
    setAcking(id);
    try {
      await api.ackAlert(id);
      setAlerts((list) => list?.filter((a) => a.id !== id) ?? null);
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setAcking(null);
    }
  }

  return (
    <section className="panel panel-brief" aria-labelledby="brief-title">
      <header className="panel-head">
        <h2 id="brief-title">Brief</h2>
        {brief ? <span className="panel-meta mono">{formatRange(brief.periodStart, brief.periodEnd)}</span> : null}
      </header>
      <div className="panel-body">
        <section className="brief-section" aria-label="Alerts">
          <h3 className="section-h">{alerts ? (alerts.length ? plural(alerts.length, "alert") : "No open alerts") : "Alerts"}</h3>
          <PanelState error={alertsError} onRetry={() => void loadAlerts()} loading={!alerts && !alertsError} />
          {alerts && alerts.length ? (
            <ul className="alerts">
              {alerts.map((a) => {
                const topic = a.topicId ? topicsById.get(a.topicId) : undefined;
                return (
                  <li key={a.id} className={`alert alert-${a.severity}`}>
                    <div className="alert-main">
                      <div className="alert-title">
                        <Pill tone={ALERT_TONE[a.severity]}>{ALERT_SEVERITY_LABEL[a.severity]}</Pill>
                        <span>{a.title}</span>
                      </div>
                      {a.body ? <p className="alert-body">{a.body}</p> : null}
                      <div className="alert-foot">
                        <RelativeTime iso={a.createdAt} />
                        {topic ? (
                          <button type="button" className="linkish" onClick={() => openTopic(topic.id)}>
                            {topic.name}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <button type="button" className="btn btn-small" disabled={acking === a.id} onClick={() => void ack(a.id)} aria-label={`Acknowledge: ${a.title}`}>
                      OK
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>

        <section className="brief-section brief-md" aria-label="Weekly brief">
          {brief === undefined && !briefError ? <PanelState loading /> : null}
          <PanelState error={briefError} onRetry={() => void loadBrief()} />
          {brief === null ? <PanelState empty="No brief yet. The first one is written after a week of activity." /> : null}
          {brief ? renderMarkdown(brief.contentMd) : null}
        </section>

        {policy ? (
          <>
            <section className="brief-section" aria-label="Red lines">
              <div className="brief-h">
                <h3 className="section-h">{plural(policy.redLines.length, "red line")}</h3>
                {policy.redLines.length ? (
                  <button type="button" className="linkish small" onClick={() => openSettings("redlines")}>
                    Change
                  </button>
                ) : null}
              </div>
              {policy.redLines.length ? (
                <ul className="redlines">
                  {policy.redLines.map((r) => (
                    <li key={r.id}>
                      <span className={`rl-sev rl-${r.severity}`}>{SEVERITY_LABEL[r.severity]}</span>
                      <span className="rl-desc" title={r.description}>
                        {truncate(r.description, 72)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  None declared yet. Everything an agent writes will wait on you.{" "}
                  <button type="button" className="linkish strong" onClick={() => openSettings("redlines")}>
                    Declare one in Settings
                  </button>
                </p>
              )}
            </section>

            <section className="brief-section" aria-label="Autonomy">
              <div className="brief-h">
                <h3 className="section-h">Autonomy</h3>
                <button type="button" className="linkish small" onClick={() => openSettings("autonomy")}>
                  Change
                </button>
              </div>
              <dl className="autonomy">
                {ACTION_CLASS_ORDER.map((c) => {
                  const level = policy.autonomy[c];
                  return (
                    <div key={c} className="autonomy-row">
                      <dt>{ACTION_CLASS_LABEL[c]}</dt>
                      <dd>{level ? AUTONOMY_LABEL[level] : "—"}</dd>
                    </div>
                  );
                })}
              </dl>
              {policy.requireApprovalForEditors ? <p className="muted small">Editors still need an approver.</p> : null}
            </section>
          </>
        ) : null}
      </div>
    </section>
  );
}

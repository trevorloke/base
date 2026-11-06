import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EntityReport, EntityReportRow } from "../types";
import { api, errorText } from "../api";
import { DaySpark } from "../components/DaySpark";
import { NetworkBadge } from "../components/NetworkBadge";
import { PanelState } from "../components/PanelState";
import { RelationPill } from "../components/Pill";
import { compact, networkLabel, percent, plural } from "../lib/format";
import { languageName } from "../lib/lang";
import { useRoom } from "../lib/room";
import { isoDaysAgo } from "../lib/time";
import { familyTree, fillDays, periodOf, PERIODS, type TrackerPeriod } from "../lib/tracker";

/** Up to this many top-level names get their own colour in the share-of-voice bar; the rest share "Others". */
const SOV_COLOURS = 6;

/**
 * Who is being talked about, and how much: the names the team follows, organisations with their people beneath,
 * over 24 hours, 7 days or 30 days.
 */
export function Tracker({
  head,
  period,
  onPeriod,
  refreshTick,
  canEdit,
  onOpen,
  onTrack,
}: {
  head: ReactNode;
  period: TrackerPeriod;
  onPeriod: (p: TrackerPeriod) => void;
  /** Bumped when a name was added, changed or archived. */
  refreshTick: number;
  canEdit: boolean;
  onOpen: (id: string) => void;
  onTrack: () => void;
}) {
  const { timezone } = useRoom();
  const [report, setReport] = useState<EntityReport | null>(null);
  /** For 24 hours the numbers cover the day, but the lines still show the week. */
  const [week, setWeek] = useState<EntityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const gen = useRef(0);
  const load = useCallback(async () => {
    const g = ++gen.current;
    setLoading(true);
    setError(null);
    const now = new Date().toISOString();
    const days = periodOf(period).days;
    try {
      const [r, w] = await Promise.all([api.entityReport(isoDaysAgo(days), now), days < 7 ? api.entityReport(isoDaysAgo(7), now) : Promise.resolve(null)]);
      if (g !== gen.current) return;
      setReport(r);
      setWeek(w);
    } catch (e) {
      if (g === gen.current) setError(errorText(e));
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const tree = useMemo(() => familyTree(report?.entities ?? []), [report]);
  const sparks = useMemo(() => {
    const src = week ?? report;
    const m = new Map<string, { day: string; n: number }[]>();
    if (src) for (const e of src.entities) m.set(e.id, fillDays(e.byDay, src.from, src.to, timezone));
    return m;
  }, [week, report, timezone]);
  const parentName = useMemo(() => new Map((report?.entities ?? []).map((e) => [e.id, e.name])), [report]);

  const empty = report && report.entities.length === 0;
  const p = periodOf(period);

  return (
    <section className="panel panel-tracker" aria-label="Tracker">
      <header className="panel-head">
        {head}
        <span className="panel-meta mono">{report && !empty ? plural(report.entities.length, "name") : ""}</span>
      </header>
      <div className="trk-bar">
        <div className="seg" role="radiogroup" aria-label="Period">
          {PERIODS.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={period === x.id} className="seg-btn" title={x.long} onClick={() => onPeriod(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        {loading && report ? <span className="muted small">Updating…</span> : null}
        {canEdit && !empty ? (
          <button type="button" className="btn btn-small trk-track" onClick={onTrack}>
            Track a name
          </button>
        ) : null}
      </div>
      <div className="panel-body">
        <PanelState loading={loading && !report} error={error} onRetry={() => void load()} />
        {empty ? (
          <div className="trk-empty">
            <p>The tracker follows the parties, brands and people you name, counting how often they come up across your inboxes, chat groups and public search, and who is talking.</p>
            {canEdit ? (
              <button type="button" className="btn btn-primary" onClick={onTrack}>
                Track a name
              </button>
            ) : (
              <p className="muted small">Ask an editor or owner to add the first one.</p>
            )}
          </div>
        ) : null}
        {report && !empty ? (
          <>
            <ShareOfVoice rows={tree.filter((t) => t.depth === 0).map((t) => t.row)} periodLong={p.long} />
            <ul className="trk-list" aria-label={`Tracked names, ${p.long}`}>
              {tree.map(({ row, depth, people }) => (
                <li key={row.id} className="trk-item" data-depth={Math.min(depth, 3)}>
                  <TrackerRow
                    row={row}
                    depth={depth}
                    people={people}
                    parent={row.parentId ? (parentName.get(row.parentId) ?? null) : null}
                    spark={sparks.get(row.id) ?? []}
                    onOpen={() => onOpen(row.id)}
                  />
                </li>
              ))}
            </ul>
            {week ? <p className="muted small trk-foot">Numbers cover the last 24 hours; the lines show the last 7 days.</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function TrackerRow({
  row,
  depth,
  people,
  parent,
  spark,
  onOpen,
}: {
  row: EntityReportRow;
  depth: number;
  /** How many belong to it directly. */
  people: number;
  parent: string | null;
  spark: { day: string; n: number }[];
  onOpen: () => void;
}) {
  const langs = row.byLanguage.filter((l): l is { lang: string; n: number } => !!l.lang).slice(0, 3);
  const nets = row.byNetwork.slice(0, 3);
  const share = depth === 0 ? row.shareOfVoice : row.shareWithinParent;
  return (
    // The name is the button; its hit area stretches over the whole row, so the numbers stay plain text for screen readers.
    <div className="trk-row">
      <span className="trk-top">
        <span className="trk-id">
          <button type="button" className="linkish trk-name trk-open" onClick={onOpen}>
            {row.name}
          </button>
          {row.role ? <span className="tag">{row.role}</span> : null}
          <RelationPill relation={row.relation} />
        </span>
        <DaySpark days={spark} className="trk-spark" />
      </span>
      <span className="trk-nums">
        <span>
          <span className="mono trk-n">{compact(row.mentions)}</span> {row.mentions === 1 ? "mention" : "mentions"}
          {people > 0 ? <span className="muted"> · {compact(row.familyMentions)} incl. its people</span> : null}
        </span>
        <span>
          <span className="mono trk-n">{compact(row.people)}</span> {row.people === 1 ? "person" : "people"} talking
        </span>
        <span>
          <span className="mono trk-n">{compact(row.authored)}</span> by them
        </span>
        {share !== null ? (
          <span title={depth === 0 ? "Share of everything said about the names at the top level" : `Share of what is said about ${parent ?? "the organisation"}'s people`}>
            <span className="mono trk-n">{percent(share)}</span> {depth === 0 ? "share of voice" : `within ${parent ?? "the organisation"}`}
          </span>
        ) : null}
      </span>
      {langs.length || nets.length ? (
        <span className="trk-meta">
          {langs.map((l) => (
            <span key={l.lang} className="tag" title={`${languageName(l.lang)}: ${plural(l.n, "mention")}`}>
              {languageName(l.lang)}
            </span>
          ))}
          {langs.length && nets.length ? <span className="trk-sep" aria-hidden="true" /> : null}
          {nets.map((n) => (
            <NetworkBadge key={n.network} network={n.network} title={`${networkLabel(n.network)}: ${plural(n.n, "mention")}`} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** One stacked bar across the top-level names, with the same numbers as a list beneath it. */
function ShareOfVoice({ rows, periodLong }: { rows: EntityReportRow[]; periodLong: string }) {
  const ranked = rows.filter((r) => (r.shareOfVoice ?? 0) > 0).sort((a, b) => (b.shareOfVoice ?? 0) - (a.shareOfVoice ?? 0));
  if (ranked.length < 2) return null;
  const shown = ranked.length > SOV_COLOURS ? ranked.slice(0, SOV_COLOURS - 1) : ranked;
  const rest = ranked.slice(shown.length);
  const parts = [
    ...shown.map((r, i) => ({ key: r.id, name: r.name, share: r.shareOfVoice ?? 0, colour: `var(--cat-${i + 1})` })),
    ...(rest.length ? [{ key: "others", name: `${rest.length} others`, share: rest.reduce((n, r) => n + (r.shareOfVoice ?? 0), 0), colour: "var(--fg-faint)" }] : []),
  ];
  return (
    <section className="sov" aria-labelledby="sov-title">
      <h3 id="sov-title" className="section-h">
        Share of voice <span className="muted sov-period">· {periodLong}</span>
      </h3>
      <div className="sov-bar" aria-hidden="true">
        {parts.map((p) => (
          <span key={p.key} className="sov-seg" style={{ flexGrow: p.share, background: p.colour }} title={`${p.name}: ${percent(p.share)}`}>
            {p.share >= 12 ? <span className="sov-seg-label">{percent(p.share)}</span> : null}
          </span>
        ))}
      </div>
      <ul className="sov-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="sov-swatch" style={{ background: p.colour }} aria-hidden="true" />
            <span className="sov-name">{p.name}</span> <span className="mono muted">{percent(p.share)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

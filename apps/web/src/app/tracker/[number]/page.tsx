import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CouncilLetter } from "@/components/tracker/CouncilLetter";
import { DueChip } from "@/components/tracker/DueChip";
import { FollowForm } from "@/components/tracker/FollowForm";
import { NeighbourhoodChips, SourceLinks, StatusBadge } from "@/components/tracker/PromiseList";
import { ShareButtons } from "@/components/tracker/ShareButtons";
import { councilLetter, followCopy } from "@/content/tracker";
import { formatDate } from "@/lib/dates";
import { env } from "@/lib/env";
import { shareLinks } from "@/lib/share";
import { todayInSurrey } from "@/lib/shifts";
import { dueInfo, formatIsoDate, promisePath, shareTextFor, STATUS_BY_ID } from "@/lib/tracker";
import { loadTracker } from "@/lib/server/tracker";
import "../tracker.css";

export const revalidate = 3600;

function parseNumber(raw: string): number | null {
  return /^\d{1,4}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
}

async function findPromise(raw: string) {
  const n = parseNumber(raw);
  if (!n) return null;
  const data = await loadTracker();
  const promise = data.promises.find((p) => p.number === n);
  return promise ? { promise, total: data.promises.length } : null;
}

export async function generateMetadata({ params }: PageProps<"/tracker/[number]">): Promise<Metadata> {
  const found = await findPromise((await params).number);
  if (!found) return { title: "Promise not found" };
  const { promise: p, total } = found;
  const title = `Promise ${p.number} of ${total}: ${p.title}`;
  const description = `${STATUS_BY_ID[p.status].label}. ${p.specifics ? `${p.specifics}. ` : ""}Scored against the public record, with the sources and the delivery test.`.slice(0, 300);
  return {
    title,
    description,
    alternates: { canonical: promisePath(p.number) },
    // The share image comes from opengraph-image.tsx in this folder.
    openGraph: { title, description, type: "article", url: promisePath(p.number) },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PromisePage({ params }: PageProps<"/tracker/[number]">) {
  const found = await findPromise((await params).number);
  if (!found) notFound();
  const { promise: p, total } = found;
  const today = todayInSurrey();
  const status = STATUS_BY_ID[p.status];
  const due = dueInfo({ status: p.status, targetDate: p.targetDate, promisedOn: p.promisedOn, hasRecord: p.updates.length > 0 }, today);
  const url = `${env.siteUrl}${promisePath(p.number)}`;
  const links = shareLinks({ url, text: shareTextFor(p, total), subject: `Promise ${p.number}: ${p.title}` });
  const letter = councilLetter({ number: p.number, total, title: p.title, statusLabel: status.label, dueLine: due?.label ?? null, url });
  const hasTest = Boolean(p.testKept);

  return (
    <>
      <section className="section--navy on-dark page-head">
        <div className="container stack" style={{ gap: 14 }}>
          <p className="eyebrow eyebrow--yellow">
            Promise {p.number} of {total} · {p.area}
          </p>
          <h1 className="display pop" style={{ fontSize: "clamp(30px, 4.6vw, 54px)" }}>
            {p.title}
          </h1>
          <div className="status-line">
            <StatusBadge status={p.status} />
            <span>{p.statusChangedAt ? `since ${formatDate(new Date(p.statusChangedAt))}` : "no public record of action yet"}</span>
            <DueChip info={due} large />
          </div>
          {p.specifics && (
            <p className="lede" style={{ maxWidth: 820 }}>
              {p.specifics}
            </p>
          )}
          <ul className="tracker-toolbar" aria-label="Tracker navigation">
            <li>
              <Link href="/tracker">← All {total} promises</Link>
            </li>
            <li>
              <a href="#follow">Follow this promise</a>
            </li>
            <li>
              <a href="#record">The record</a>
            </li>
            <li>
              <Link href="/tracker/methodology">How it&apos;s scored</Link>
            </li>
          </ul>
        </div>
      </section>

      <section className="section">
        <div className="container promise-page">
          <div className="promise-main-col">
            <div className="record-block">
              <h2>Where it was promised</h2>
              <p className="promise-sources">
                <SourceLinks sources={p.sources} />
              </p>
            </div>

            {hasTest && (
              <div className="record-block">
                <h2>The delivery test</h2>
                <dl className="delivery-test">
                  <div>
                    <dt>
                      <StatusBadge status="kept" />
                    </dt>
                    <dd>{p.testKept}</dd>
                  </div>
                  <div>
                    <dt>
                      <StatusBadge status="partly_kept" />
                    </dt>
                    <dd>{p.testPartly}</dd>
                  </div>
                  <div>
                    <dt>
                      <StatusBadge status="broken" />
                    </dt>
                    <dd>{p.testBroken}</dd>
                  </div>
                </dl>
                {p.testRecord && (
                  <p className="small">
                    <strong>Record to check:</strong> {p.testRecord}
                  </p>
                )}
              </div>
            )}

            <div className="record-block" id="record">
              <h2>The record</h2>
              {p.updates.length === 0 ? (
                <p className="small">No public record yet. The first update will appear here, with a date and a link to the record, as soon as one exists.</p>
              ) : (
                <ol className="update-list">
                  {p.updates.map((u) => (
                    <li key={u.id} id={`update-${u.id}`}>
                      <span className="update-date">{formatIsoDate(u.date)}</span>
                      {u.status && <StatusBadge status={u.status} />}
                      <span>
                        {u.note}
                        {u.url && (
                          <>
                            {" "}
                            <a href={u.url} target="_blank" rel="noopener noreferrer">
                              Source
                            </a>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {p.neighbourhoods.length > 0 && (
              <div className="record-block">
                <h2>Neighbourhoods</h2>
                <NeighbourhoodChips neighbourhoods={p.neighbourhoods} label={`Neighbourhoods this promise affects`} />
              </div>
            )}

            <div className="record-block" id="write">
              <h2>Write to council</h2>
              <p style={{ marginBottom: 12 }}>
                Council answers to residents, not to the tracker. Copy this letter, make it yours, and send it through the City&apos;s contact page.
              </p>
              <CouncilLetter text={letter} />
            </div>
          </div>

          <aside className="promise-aside" aria-label="Dates, follow and share">
            <div className="aside-card">
              <h2>Dates</h2>
              <dl className="dates-list">
                <dt>Promised on</dt>
                <dd>{p.promisedOn ? formatIsoDate(p.promisedOn) : "No dated commitment on record"}</dd>
                <dt>Due by</dt>
                <dd>{p.targetDate ? formatIsoDate(p.targetDate) : "No deadline given by the party"}</dd>
                <dt>Status</dt>
                <dd>
                  {status.label}
                  {p.statusChangedAt ? ` since ${formatDate(new Date(p.statusChangedAt))}` : ""}
                </dd>
              </dl>
              {due && (
                <p>
                  <DueChip info={due} large />
                </p>
              )}
            </div>

            <div className="aside-card" id="follow">
              <h2>{followCopy.title}</h2>
              <p>{followCopy.text}</p>
              <FollowForm promiseId={p.id} promiseNumber={p.number} />
            </div>

            <div className="aside-card">
              <h2>Share this promise</h2>
              <p className="small">The link carries its own image with the current score.</p>
              <ShareButtons links={links} label={`Share promise ${p.number}`} />
            </div>
          </aside>
        </div>
      </section>
    </>
  );
}

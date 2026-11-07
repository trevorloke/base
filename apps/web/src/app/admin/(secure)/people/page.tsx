import Link from "next/link";
import { BulkTagForm } from "@/components/admin/people/BulkTagForm";
import { describeQuery, hasFilters, MEMBERSHIP_FILTERS, NEWSLETTER_FILTERS, PAGE_SIZE, parsePeopleQuery, peopleHref, SMS_FILTERS, SORTS, type PeopleQuery } from "@/components/admin/people/query";
import { getDb } from "@/lib/db";
import { NEIGHBOURHOODS, OUTSIDE_SURREY } from "@/lib/neighbourhoods";
import { can, requireAdmin } from "@/lib/server/admin-auth";
import { filterFacets, searchSupporters, type PersonRow } from "@/lib/server/supporters";
import { bulkTagAction } from "./actions";
import "./people.css";

function MembershipBadge({ row }: { row: PersonRow }) {
  if (row.active_until) return <span className="badge badge--ok">Active until {row.active_until}</span>;
  if (row.past_member) return <span className="badge badge--bad">Expired</span>;
  if (row.pending_membership) return <span className="badge badge--warn">Pending payment</span>;
  return <span className="badge">—</span>;
}

function Pager({ query, total }: { query: PeopleQuery; total: number }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  const page = Math.min(query.page, pages);
  const around = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages].filter((p) => p >= 1 && p <= pages))].sort((a, b) => a - b);
  return (
    <nav className="crm-pager" aria-label="Pages">
      {page > 1 && (
        <Link href={peopleHref(query, { page: page - 1 })} rel="prev">
          Previous
        </Link>
      )}
      {around.map((p, i) => (
        <span key={p} style={{ display: "contents" }}>
          {i > 0 && around[i - 1] !== p - 1 && <span aria-hidden="true">…</span>}
          {p === page ? (
            <span aria-current="page">{p}</span>
          ) : (
            <Link href={peopleHref(query, { page: p })} aria-label={`Page ${p}`}>
              {p}
            </Link>
          )}
        </span>
      ))}
      {page < pages && (
        <Link href={peopleHref(query, { page: page + 1 })} rel="next">
          Next
        </Link>
      )}
    </nav>
  );
}

export default async function AdminPeople({ searchParams }: PageProps<"/admin/people">) {
  const user = await requireAdmin("people");
  const money = can(user, "money");
  const query = parsePeopleQuery(await searchParams, { money });
  const db = getDb();
  const [{ rows, total }, facets] = await Promise.all([searchSupporters(db, query), filterFacets(db)]);
  const first = total === 0 ? 0 : (query.page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, query.page * PAGE_SIZE);
  const chips = describeQuery(query);
  const neighbourhoods = [...NEIGHBOURHOODS, OUTSIDE_SURREY];

  return (
    <>
      <div className="crm-head">
        <h1 className="h3">Supporters</h1>
        <nav className="crm-sub" aria-label="Supporter tools">
          <Link href="/admin/people/sources">Where sign-ups come from</Link>
          <Link href="/admin/exports">Exports</Link>
          <a href={peopleHref(query, { page: 1 }, "/api/admin/export/people")}>Download this view as CSV</a>
        </nav>
      </div>

      <form method="get" action="/admin/people" className="crm-filters" aria-label="Search and filter supporters">
        <div className="field field--wide">
          <label htmlFor="q">Search by name, email, phone or postal code</label>
          <input id="q" name="q" type="search" className="input input--search" defaultValue={query.q} maxLength={80} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="membership">Membership</label>
          <select id="membership" name="membership" className="input input--compact" defaultValue={query.membership}>
            {MEMBERSHIP_FILTERS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="neighbourhood">Neighbourhood</label>
          <select id="neighbourhood" name="neighbourhood" className="input input--compact" defaultValue={query.neighbourhood}>
            <option value="">Any</option>
            {neighbourhoods.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tag">Tag</label>
          <select id="tag" name="tag" className="input input--compact" defaultValue={query.tag}>
            <option value="">Any</option>
            {!facets.tags.includes(query.tag) && query.tag && <option value={query.tag}>{query.tag}</option>}
            {facets.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="source">Source</label>
          <select id="source" name="source" className="input input--compact" defaultValue={query.source}>
            <option value="">Any</option>
            {!facets.sources.includes(query.source) && query.source && <option value={query.source}>{query.source}</option>}
            {facets.sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="newsletter">Newsletter</label>
          <select id="newsletter" name="newsletter" className="input input--compact" defaultValue={query.newsletter}>
            {NEWSLETTER_FILTERS.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sms">Text messages</label>
          <select id="sms" name="sms" className="input input--compact" defaultValue={query.sms}>
            {SMS_FILTERS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="language">Language</label>
          <select id="language" name="language" className="input input--compact" defaultValue={query.language}>
            <option value="">Any</option>
            {!facets.languages.includes(query.language) && query.language && <option value={query.language}>{query.language}</option>}
            {facets.languages.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">Sort</label>
          <select id="sort" name="sort" className="input input--compact" defaultValue={query.sort}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="crm-filters__flags">
          <label className="check">
            <input type="checkbox" name="volunteer" value="1" defaultChecked={query.volunteer} />
            <span>Wants to volunteer</span>
          </label>
          <label className="check">
            <input type="checkbox" name="lawnsign" value="1" defaultChecked={query.lawnsign} />
            <span>Wants a lawn sign</span>
          </label>
          {money && (
            <label className="check">
              <input type="checkbox" name="donated" value="1" defaultChecked={query.donated} />
              <span>Donated this year</span>
            </label>
          )}
        </div>
        <div className="crm-filters__actions">
          <button type="submit" className="btn btn--navy btn--compact">
            Apply
          </button>
          {hasFilters(query) && (
            <Link href="/admin/people" className="btn btn--outline btn--compact">
              Clear filters
            </Link>
          )}
        </div>
      </form>

      {chips.length > 0 && (
        <ul className="crm-chips" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c} className="chip">
              {c}
            </li>
          ))}
        </ul>
      )}

      <div className="crm-toolbar">
        <p role="status">
          <strong>{total}</strong> supporter{total === 1 ? "" : "s"}
          {total > 0 && ` · showing ${first}–${last}`}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="empty-state">No supporters match. Try fewer filters.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Supporters, page {query.page}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col">Neighbourhood</th>
                <th scope="col">Membership</th>
                <th scope="col">Newsletter</th>
                <th scope="col">Tags</th>
                <th scope="col">Source</th>
                <th scope="col">Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/admin/people/${r.id}`}>{[r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)"}</Link>
                    {(r.interest_volunteer || r.interest_lawn_sign) && (
                      <span className="small" style={{ display: "block" }}>
                        {[r.interest_volunteer && "volunteer", r.interest_lawn_sign && "lawn sign"].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td>{r.email}</td>
                  <td>{r.phone ?? ""}</td>
                  <td>{r.neighbourhood ?? ""}</td>
                  <td>
                    <MembershipBadge row={r} />
                  </td>
                  <td>{r.newsletter_status ?? ""}</td>
                  <td className="tags-cell">
                    {r.tags.map((t) => (
                      <Link key={t} href={peopleHref(query, { tag: t, page: 1 })} className="tag">
                        {t}
                      </Link>
                    ))}
                  </td>
                  <td>{r.source ?? ""}</td>
                  <td>{r.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager query={query} total={total} />

      {total > 0 && <BulkTagForm action={bulkTagAction} query={query} total={total} />}
    </>
  );
}

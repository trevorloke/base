import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { error } from "@/lib/server/api";
import { can } from "@/lib/server/admin-auth";
import { adminOnly } from "@/lib/server/admin-api";
import { csvResponse, csvStream, DATASETS, datasetPermission, datasetQuery, type Dataset } from "@/lib/server/admin-data";
import { audit } from "@/lib/server/audit";
import { supportersExportQuery } from "@/lib/server/supporters";
import { ISO_DATE_RE } from "@/lib/shifts";
import { describeQuery, parsePeopleQuery } from "@/components/admin/people/query";

/**
 * CSV downloads. `/api/admin/export/<dataset>` is one of the fixed datasets
 * (shifts take optional `from` and `to` dates); `/api/admin/export/people`
 * is the supporter list as filtered by the same query string as
 * /admin/people. Rows stream from a database cursor, so a large export
 * never sits in memory.
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/admin/export/[dataset]">) {
  const auth = await adminOnly();
  if (!auth.ok) return auth.response;
  const { dataset } = await ctx.params;
  const db = getDb();
  const sp = req.nextUrl.searchParams;

  if (dataset === "people") {
    if (!can(auth.user, "people")) return error("Your role can't export that.", 403);
    const money = can(auth.user, "money");
    const query = parsePeopleQuery(sp, { money });
    const stream = await csvStream(db, supportersExportQuery(query, { money }));
    await audit(auth.user, "export", { dataset: "people", filters: describeQuery(query) });
    return csvResponse(stream, "supporters");
  }

  if (!DATASETS.includes(dataset as Dataset)) return error("Unknown dataset.", 404);
  if (!can(auth.user, datasetPermission(dataset as Dataset))) return error("Your role can't export that.", 403);
  const date = (key: string) => {
    const v = sp.get(key);
    return v && ISO_DATE_RE.test(v) ? v : undefined;
  };
  const options = dataset === "shifts" ? { from: date("from"), to: date("to") } : {};
  const stream = await csvStream(db, datasetQuery(dataset as Dataset, options));
  await audit(auth.user, "export", { dataset, ...options });
  return csvResponse(stream, dataset);
}

import { ImageResponse } from "next/og";
import { shareImageColors } from "@/lib/brand";
import { shellBrand } from "@/lib/server/brand";
import { env } from "@/lib/env";
import { todayInSurrey } from "@/lib/shifts";
import { dueInfo, STATUS_BY_ID } from "@/lib/tracker";
import { loadTracker } from "@/lib/server/tracker";

// The share image for one promise: brand colours, the status badge, the
// title, "Promise N of 26" and the countdown. Drawn with the runtime's
// bundled font, so no font files ship with the site.

export const revalidate = 3600;
export const alt = "A promise on the Safe Surrey promise tracker, with its current status";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";


export default async function Image({ params }: { params: Promise<{ number: string }> }) {
  const { primary: NAVY, accentFill: RED, highlight: YELLOW, pale: PALE, onPrimary: ON_PRIMARY, onAccent: ON_ACCENT } = shareImageColors(await shellBrand());
  const raw = (await params).number;
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  const data = await loadTracker();
  const p = data.promises.find((x) => x.number === n);
  if (!p) return new Response("Not found", { status: 404 });
  const status = STATUS_BY_ID[p.status];
  const due = dueInfo({ status: p.status, targetDate: p.targetDate, promisedOn: p.promisedOn, hasRecord: p.updates.length > 0 }, todayInSurrey());
  const title = p.title.length > 150 ? `${p.title.slice(0, 147).replace(/\s\S*$/, "")}…` : p.title;
  const titleSize = title.length > 110 ? 40 : title.length > 70 ? 48 : 58;
  const host = new URL(env.siteUrl).host;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: NAVY, color: ON_PRIMARY }}>
        <div style={{ display: "flex", height: 18, background: YELLOW }} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "44px 64px 40px", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <div style={{ display: "flex", background: RED, color: ON_ACCENT, padding: "8px 18px", borderRadius: 8, fontSize: 26, letterSpacing: 2 }}>
                PROMISE {p.number} OF {data.promises.length}
              </div>
              <div style={{ display: "flex", color: PALE, fontSize: 26, letterSpacing: 2 }}>{p.area.toUpperCase()}</div>
            </div>
            <div style={{ display: "flex", fontSize: titleSize, lineHeight: 1.15 }}>{title}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
              <div style={{ display: "flex", background: status.color, color: status.text, padding: "12px 28px", borderRadius: 999, fontSize: 34 }}>{status.label}</div>
              {due ? <div style={{ display: "flex", color: due.kind === "overdue" ? YELLOW : PALE, fontSize: 30 }}>{due.label}</div> : null}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: PALE, fontSize: 24 }}>
              <div style={{ display: "flex" }}>Safe Surrey promise tracker · scored against the public record</div>
              <div style={{ display: "flex" }}>
                {host}/tracker/{p.number}
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}

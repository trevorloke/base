import { ImageResponse } from "next/og";
import { env } from "@/lib/env";
import { countByStatus, formatIsoDate, PROMISE_STATUSES } from "@/lib/tracker";
import { loadTracker } from "@/lib/server/tracker";

// The share image for /tracker: the scoreboard. Brand colours and the
// runtime's bundled font, so no font files ship with the site.

export const revalidate = 3600;
export const alt = "The Safe Surrey promise tracker scoreboard: how many promises are kept, in progress, partly kept, broken or not started";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const NAVY = "#003979";
const YELLOW = "#FFF100";
const PALE = "#D3DEEF";

export default async function Image() {
  const { promises, lastUpdated } = await loadTracker();
  const counts = countByStatus(promises.map((p) => p.status));
  const host = new URL(env.siteUrl).host;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: NAVY, color: "#FFFFFF" }}>
        <div style={{ display: "flex", height: 18, background: YELLOW }} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "48px 64px 40px", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", color: YELLOW, fontSize: 26, letterSpacing: 3 }}>ACCOUNTABILITY</div>
            <div style={{ display: "flex", fontSize: 64, lineHeight: 1.1 }}>Safe Surrey promise tracker</div>
            <div style={{ display: "flex", color: PALE, fontSize: 28 }}>
              {promises.length} promises from the 2026 campaign, scored against the public record
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            <div style={{ display: "flex", height: 34, borderRadius: 17, overflow: "hidden", background: "rgba(255,255,255,0.15)" }}>
              {PROMISE_STATUSES.filter((s) => counts[s.id] > 0).map((s) => (
                <div key={s.id} style={{ display: "flex", flexGrow: counts[s.id], background: s.color }} />
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {PROMISE_STATUSES.map((s) => (
                <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", fontSize: 64, lineHeight: 1 }}>{counts[s.id]}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, color: PALE, fontSize: 24 }}>
                    <div style={{ display: "flex", width: 18, height: 18, borderRadius: 9, background: s.color }} />
                    {s.label}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", color: PALE, fontSize: 24 }}>
              <div style={{ display: "flex" }}>{lastUpdated ? `Last updated ${formatIsoDate(lastUpdated)}` : "Tracking began October 18, 2026"}</div>
              <div style={{ display: "flex" }}>{host}/tracker</div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}

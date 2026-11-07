import type { Metadata } from "next";
import { PortalNav } from "./PortalNav";
import "../me.css";

export const metadata: Metadata = { title: "Your supporter home", robots: { index: false } };

// Every page under here calls requireMember() itself; this layout only
// draws the navigation. A layout check alone can be skipped by a direct
// request for the page segment.
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="portal">
      <PortalNav />
      {children}
    </div>
  );
}

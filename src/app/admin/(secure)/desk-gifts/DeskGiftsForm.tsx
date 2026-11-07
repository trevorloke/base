"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { Notice } from "@/components/admin/Notice";
import { SubmitButton } from "@/components/admin/SubmitButton";
import type { ActionState } from "@/lib/server/actions";

export type DeskGiftView = {
  id: string;
  name: string;
  email: string;
  address: string;
  city: string;
  postalCode: string;
  amount: string;
  /** Net of refunds, when it differs from the amount. */
  net: string | null;
  slate: string;
  kind: string;
  paid: string;
  reference: string;
  flags: string[];
  personId: string;
};

/** The unlogged gifts, with a "Mark logged" button per row and for the ticked ones. */
export function DeskGiftsForm({ gifts, action }: { gifts: DeskGiftView[]; action: (prev: ActionState, form: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  // After a save the list reloads without the logged rows; start the ticks afresh.
  useEffect(() => {
    if (state?.ok) setTicked(new Set());
  }, [state]);
  const all = gifts.length > 0 && gifts.every((g) => ticked.has(g.id));
  const toggle = (id: string, on: boolean) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <form action={formAction}>
      <Notice state={state} />
      <div className="crm-toolbar" style={{ marginTop: 12 }}>
        <p className="small" role="status">
          {gifts.length === 0 ? "Every online gift has been logged at the desk." : `${gifts.length} gift${gifts.length === 1 ? "" : "s"} to log${ticked.size ? ` · ${ticked.size} ticked` : ""}`}
        </p>
        {gifts.length > 0 && (
          <SubmitButton className="btn btn--navy btn--compact" pendingText="Saving…">
            Mark ticked gifts logged
          </SubmitButton>
        )}
      </div>
      {gifts.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Online gifts not yet logged at the desk, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">
                  <input type="checkbox" aria-label="Tick every gift" checked={all} onChange={(e) => setTicked(e.target.checked ? new Set(gifts.map((g) => g.id)) : new Set())} />
                </th>
                <th scope="col">Contributor</th>
                <th scope="col">Address</th>
                <th scope="col">Amount</th>
                <th scope="col">Slate</th>
                <th scope="col">Kind</th>
                <th scope="col">Paid (Pacific)</th>
                <th scope="col">Stripe reference</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {gifts.map((g) => (
                <tr key={g.id} data-gift={g.id}>
                  <td>
                    <input type="checkbox" name="ids" value={g.id} aria-label={`Tick ${g.name}, ${g.amount}, paid ${g.paid}`} checked={ticked.has(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} />
                  </td>
                  <td className="cell-wrap">
                    <Link href={`/admin/people/${g.personId}`}>{g.name}</Link>
                    <span className="small" style={{ display: "block" }}>
                      {g.email}
                    </span>
                  </td>
                  <td className="cell-wrap">
                    {g.address}
                    <span className="small" style={{ display: "block" }}>
                      {g.city} {g.postalCode}
                    </span>
                  </td>
                  <td>
                    {g.amount}
                    {g.net !== null && (
                      <span className="small" style={{ display: "block" }}>
                        Net of refunds: {g.net}
                      </span>
                    )}
                    {g.flags.map((f) => (
                      <span key={f} className="badge badge--bad" style={{ display: "inline-block", marginTop: 4 }}>
                        {f}
                      </span>
                    ))}
                  </td>
                  <td>{g.slate}</td>
                  <td>{g.kind}</td>
                  <td>{g.paid}</td>
                  <td className="cell-wrap">
                    <code style={{ fontSize: 13 }}>{g.reference || "—"}</code>
                  </td>
                  <td>
                    <SubmitButton className="btn btn--outline btn--compact" name="one" value={g.id} pendingText="Saving…" aria-label={`Mark logged: ${g.name}, ${g.amount}, paid ${g.paid}`}>
                      Mark logged
                    </SubmitButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </form>
  );
}

"use client";

import { useState } from "react";
import { DEFAULT_CENTS, PRESETS_CENTS, starClubCents, type Frequency } from "@/lib/contributions";
import { formatCents } from "@/lib/money";
import { applyCustomAmount, parseCustomAmount, presetPressed, type Choice } from "./amount";

export type { Choice } from "./amount";

export function choiceTotalCents(choice: Choice, limitCents: number): number {
  const star = starClubCents(choice.frequency, limitCents);
  return choice.tier === "standard" ? choice.amountCents : choice.tier === "star" ? star : star * 2;
}

export function choiceLabel(choice: Choice, limitCents: number): string {
  return formatCents(choiceTotalCents(choice, limitCents)) + (choice.frequency === "monthly" ? " a month" : "");
}

export const DEFAULT_MONTHLY_NOTE = "Monthly donors automatically support the Imagine Victory Fund, our war chest for the next election.";
export const DEFAULT_CLUB_NOTE =
  "The Star Club is our name for donors who give the yearly maximum, all at once or spread across twelve months. The Superstar Club gives the maximum to both our city council and school board slates: two contributions, one payment.";

/**
 * Frequency toggle and amount buttons, as on the home page "Chip in" card.
 * One-time is the default; monthly is only ever selected by the person.
 */
export function AmountPicker({
  choice,
  onChange,
  limitCents,
  allowCustom = false,
  onCustomError,
  monthlyNote = DEFAULT_MONTHLY_NOTE,
  clubNote = DEFAULT_CLUB_NOTE,
  idPrefix = "amount",
}: {
  choice: Choice;
  onChange: (c: Choice) => void;
  limitCents: number;
  allowCustom?: boolean;
  /** Told whenever the custom box's validity changes, so the form can block submit. */
  onCustomError?: (error: string | null) => void;
  monthlyNote?: string;
  clubNote?: string;
  idPrefix?: string;
}) {
  const star = starClubCents(choice.frequency, limitCents);
  const presets = PRESETS_CENTS[choice.frequency];
  const rules = { frequency: choice.frequency, limitCents };
  const [custom, setCustom] = useState(() => (choice.tier === "standard" && !presets.includes(choice.amountCents) && choice.amountCents > 0 ? String(choice.amountCents / 100) : ""));
  const customState = parseCustomAmount(custom, rules);
  const customId = `${idPrefix}-custom`;

  const pick = (next: Choice) => {
    setCustom("");
    onCustomError?.(null);
    onChange(next);
  };
  const setFrequency = (frequency: Frequency) => {
    if (frequency === choice.frequency) return;
    pick({ frequency, tier: choice.tier, amountCents: choice.tier === "standard" ? DEFAULT_CENTS[frequency] : choice.amountCents });
  };

  return (
    <>
      <div className="stack" style={{ gap: 8 }}>
        <p className="field-label" style={{ margin: 0 }} id={`${idPrefix}-freq-label`}>
          How often?
        </p>
        <div role="group" aria-labelledby={`${idPrefix}-freq-label`} className="toggle">
          <button type="button" aria-pressed={choice.frequency === "one_time"} onClick={() => setFrequency("one_time")}>
            One-time
          </button>
          <button type="button" aria-pressed={choice.frequency === "monthly"} onClick={() => setFrequency("monthly")}>
            Monthly
          </button>
        </div>
        {monthlyNote && (
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
            <strong>Monthly donors</strong> {monthlyNote.replace(/^Monthly donors\s*/i, "")}
          </p>
        )}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <p className="field-label" style={{ margin: 0 }} id={`${idPrefix}-amount-label`}>
          Choose an amount
        </p>
        <div role="group" aria-labelledby={`${idPrefix}-amount-label`} className="amounts">
          {presets.map((cents) => (
            <button
              key={cents}
              type="button"
              className="amount"
              aria-pressed={presetPressed(choice, cents, custom)}
              onClick={() => pick({ ...choice, tier: "standard", amountCents: cents })}
            >
              {formatCents(cents)}
            </button>
          ))}
          <button type="button" className="amount amount--wide" aria-pressed={choice.tier === "star"} onClick={() => pick({ ...choice, tier: "star", amountCents: star })}>
            Star Club {formatCents(star)}
          </button>
          <button
            type="button"
            className="amount amount--wide"
            aria-pressed={choice.tier === "superstar"}
            onClick={() => pick({ ...choice, tier: "superstar", amountCents: star * 2 })}
          >
            Superstar Club {formatCents(star * 2)}
          </button>
        </div>
        {allowCustom && (
          <div className="field" style={{ marginTop: 6 }}>
            <label htmlFor={customId}>Or enter another amount</label>
            <div className="custom-amount">
              <span aria-hidden="true">$</span>
              <input
                id={customId}
                className="input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="Other amount"
                value={custom}
                aria-invalid={customState.error ? true : undefined}
                aria-describedby={customState.error ? `${customId}-error` : undefined}
                onChange={(e) => {
                  const text = e.target.value;
                  setCustom(text);
                  const { error } = parseCustomAmount(text, rules);
                  onCustomError?.(text.trim() === "" ? null : error);
                  if (text.trim() === "") onChange({ frequency: choice.frequency, tier: "standard", amountCents: DEFAULT_CENTS[choice.frequency] });
                  else onChange(applyCustomAmount(choice, text, rules));
                }}
              />
            </div>
            {customState.error && (
              <p className="field-error" id={`${customId}-error`}>
                {customState.error}
              </p>
            )}
          </div>
        )}
      </div>
      {clubNote && (
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          {clubNote}
        </p>
      )}
    </>
  );
}

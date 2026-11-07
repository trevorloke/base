"use client";

export function PrintButton() {
  return (
    <button type="button" className="btn btn--navy" onClick={() => window.print()}>
      Print this sheet
    </button>
  );
}

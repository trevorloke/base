// Is this process using current time-zone rules? British Columbia moved to
// permanent UTC-7 on November 1, 2026; Node releases with older built-in
// data still switch to UTC-8 every November, which puts every Pacific time
// on the site an hour off. tzdata/README.md explains the fix.

/** Vancouver's UTC offset in hours at an instant, according to this process. */
export function vancouverOffsetHours(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "shortOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(name);
  return m ? Number(m[1]) + (m[2] ? Math.sign(Number(m[1])) * Number(m[2]) / 60 : 0) : 0;
}

/** True when the process knows BC stays on UTC-7 through the winter of 2026-27. */
export function hasCurrentBcRules(): boolean {
  return vancouverOffsetHours(new Date("2026-12-15T12:00:00Z")) === -7;
}

// The hours a person is on a shift: their own, when they said they can do
// only part of it (a booking's arrive_at / leave_at — the plan, not who
// came), else the shift's. One rule for the notices, the volunteer's
// screens and calendar entries.
//
//   hoursOf(shift, booking) → { starts_at, ends_at, part }
//     booking: { arrive_at, leave_at } (a booking row), or a GET /shifts
//     row's { my_arrive_at, my_leave_at } — the row itself works too.
//     part: true when the hours are the booking's own.
// Instants come back as they came (ISO strings, or Dates turned into ISO),
// so a shift that runs past midnight is never ambiguous.
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

export const hoursOf = (shift, booking) => {
  const from = booking?.arrive_at ?? booking?.my_arrive_at ?? null;
  const to = booking?.leave_at ?? booking?.my_leave_at ?? null;
  if (from && to) return { starts_at: iso(from), ends_at: iso(to), part: true };
  return { starts_at: iso(shift?.starts_at), ends_at: iso(shift?.ends_at), part: false };
};

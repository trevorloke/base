// A stand-in for SH's hoursOf (flexible shift hours), so the calendar
// (shared/ics.js) has the one rule to call before SH lands. SH's own file
// replaces this one; the rule is SH's: a booking's own hours when it has
// them (arrive_at, leave_at), else the shift's. part: true when the hours
// are the booking's own.
export const hoursOf = (shift, booking) => {
  const arrive = booking?.arrive_at || null;
  const leave = booking?.leave_at || null;
  if (!arrive && !leave) return { starts_at: shift.starts_at, ends_at: shift.ends_at ?? null, part: false };
  return { starts_at: arrive || shift.starts_at, ends_at: leave || shift.ends_at || null, part: true };
};

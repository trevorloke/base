/** "$50", "$1,429.70": whole dollars drop the cents, as on the design. */
export function formatCents(cents: number): string {
  const whole = cents % 100 === 0;
  const s = whole ? String(Math.round(cents / 100)) : (cents / 100).toFixed(2);
  const [dollars, fraction] = s.split(".");
  const grouped = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return "$" + grouped + (fraction ? "." + fraction : "");
}

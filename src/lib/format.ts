const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const whole = (n: number) => Math.round(Math.abs(n)).toLocaleString("en-SG");

// "2026-09-20" -> UTC date parts, so no timezone can shift the day.
const parts = (d: string) => {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
};

// Number, date and percentage formatting shared by every screen.
export const format = {
  // 1,234 and (1,234) for negatives
  money: (n: number | null | undefined) =>
    n == null ? "–" : n < 0 ? `(${whole(n)})` : whole(n),
  // 2 decimals, for balances that carry cents
  cents: (n: number | null | undefined) =>
    n == null
      ? "–"
      : `${n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  pct: (n: number | null | undefined, digits = 1) =>
    n == null ? "–" : `${(n * 100).toFixed(digits)}%`,
  signedPct: (n: number | null | undefined, digits = 1) =>
    n == null ? "–" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`,
  share: (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : "–"),
  date: (d: string | null | undefined) => {
    const p = d ? parts(d) : null;
    return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : "–";
  },
  // Whole days from today to a YYYY-MM-DD date (negative if it has passed).
  daysUntil: (d: string) => {
    const p = parts(d);
    if (!p) return 0;
    const target = Date.UTC(p.y, p.m - 1, p.d);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - today) / 86_400_000);
  },
  today: () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  },
};

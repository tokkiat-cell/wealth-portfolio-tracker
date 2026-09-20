import type { Settings } from "../../shared/schema";
import { format } from "./format";
import type { PortfolioModel } from "./portfolioModel";
import { breakdown, liteRows, loanCover, netCurrency, nonSgdPct } from "./riskModel";

// The text sent along with each chat question. It is built in the browser so the person can read
// exactly what leaves the app. Account numbers and account labels are never included.

export type ShareMode = "none" | "shares" | "full";

export const SHARE_MODES: { id: ShareMode; label: string; help: string }[] = [
  { id: "shares", label: "Percentages only", help: "Mix, exposures and loan terms. No SGD amounts." },
  { id: "full", label: "Full figures", help: "As above, with SGD amounts and loan balances." },
  { id: "none", label: "Nothing", help: "Ask general questions only." },
];

const p1 = (n: number) => `${n.toFixed(1)}%`;

export function buildChatContext(model: PortfolioModel, settings: Settings, mode: ShareMode): string {
  if (mode === "none" || model.rows.length === 0) return "";
  const full = mode === "full";
  const amt = (n: number) => (full ? ` (SGD ${format.money(n)})` : "");
  const L: string[] = [];

  const { totals, asOf } = model;
  L.push(`Today: ${format.today()}. Data dates: investments ${asOf.investments ?? "n/a"}, savings ${asOf.savings ?? "n/a"}, retirement ${asOf.retirement ?? "n/a"}, loans ${asOf.loans ?? "n/a"}.`);
  L.push(`Amounts are ${full ? "in SGD" : "hidden; only percentages are shared"}.`);

  L.push("", "Balance sheet:");
  if (full) {
    L.push(
      `- Net worth ${format.money(totals.net)}; assets ${format.money(totals.assets)}; debts ${format.money(totals.owed)} (${p1(totals.owedToAssets * 100)} of assets).`,
    );
  } else {
    L.push(`- Debts are ${p1(totals.owedToAssets * 100)} of assets.`);
  }
  const mix = model.groups.byType.map((g) => `${g.label} ${p1(totals.assets ? (g.value / totals.assets) * 100 : 0)}${amt(g.value)}`);
  L.push(`- Asset mix: ${mix.join("; ")}.`);

  const inv = liteRows(model, "investments");
  const all = liteRows(model, "all");
  L.push("", "Investments and retirement holdings (excluding deposits) by asset class:");
  for (const b of breakdown(inv, "assetClass")) L.push(`- ${b.label}: ${p1(b.pct)}${amt(b.value)}`);
  L.push("", "Same, by currency:");
  for (const b of breakdown(inv, "currency")) L.push(`- ${b.label}: ${p1(b.pct)}${amt(b.value)}`);
  L.push(`- Non-SGD share: ${p1(nonSgdPct(inv))} of investments; ${p1(nonSgdPct(all))} including deposits.`);

  L.push("", "Net currency position (assets less loans, per currency; positive gains if that currency rises against SGD):");
  const net = netCurrency(model);
  const netTotal = totals.assets || 1;
  for (const n of net) {
    L.push(`- ${n.currency}: ${p1((n.net / netTotal) * 100)} of total assets${amt(n.net)}`);
  }

  if (model.loanRows.length > 0) {
    L.push("", "Loans:");
    for (const l of model.loanRows) {
      const parts = [
        l.assetClass,
        l.currency,
        full ? `owed SGD ${format.money(l.owed)}` : `${p1(totals.owed ? (l.owed / totals.owed) * 100 : 0)} of debts`,
        l.ratePct != null ? `rate ${l.ratePct}%` : null,
        l.maturityDate ? `matures ${l.maturityDate} (${format.daysUntil(l.maturityDate)} days)` : null,
        full && l.monthlyPayment ? `monthly ${format.money(l.monthlyPayment)}` : null,
      ].filter(Boolean);
      L.push(`- ${parts.join(", ")}`);
    }
    if (model.loanStats.weightedRate != null) {
      L.push(`- Weighted average rate on loans with a rate: ${model.loanStats.weightedRate.toFixed(2)}%.`);
    }
    const cover = loanCover(model, 30);
    if (cover.dueTotal > 0) {
      L.push(
        `- Loans due within 30 days${full ? ` total SGD ${format.money(cover.dueTotal)}` : ""}; cash on hand covers them ${cover.ratio?.toFixed(1)}x${full ? ` (cash SGD ${format.money(cover.cash)})` : ""}.`,
      );
    }
  }

  L.push("", "Largest holdings, combined across brokers:");
  for (const t of model.top.slice(0, 10)) {
    L.push(`- ${t.name}: ${format.share(t.value, model.investedTotal)} of invested assets${amt(t.value)}`);
  }

  const targets = Object.entries(settings.targets);
  if (targets.length > 0 || settings.maxNonSgdPct != null || settings.maxPositionPct != null) {
    L.push("", "The owner's own targets and limits:");
    if (targets.length > 0) L.push(`- Target mix: ${targets.map(([k, v]) => `${k} ${v}%`).join(", ")}.`);
    if (settings.maxNonSgdPct != null) L.push(`- Maximum non-SGD share: ${settings.maxNonSgdPct}%.`);
    if (settings.maxPositionPct != null) L.push(`- Maximum single position: ${settings.maxPositionPct}%.`);
  }

  return L.join("\n");
}

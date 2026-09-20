import type { PortfolioModel } from "./portfolioModel";
import { format } from "./format";

// Descriptive analysis only. Every threshold and target comes from the user.

export type Scope = "investments" | "all";
export type Lite = { assetClass: string; currency: string; sgd: number };

const sum = (n: number[]) => n.reduce((a, b) => a + b, 0);

// The rows an analysis looks at: investments and retirement holdings, optionally plus deposits.
export function liteRows(model: PortfolioModel, scope: Scope): Lite[] {
  const rows = [...model.holdings, ...model.retirementRows, ...(scope === "all" ? model.savingsRows : [])];
  return rows
    .filter((r) => r.sgd != null)
    .map((r) => ({ assetClass: r.assetClass, currency: r.currency, sgd: r.sgd as number }));
}

export function breakdown(rows: Lite[], key: "assetClass" | "currency") {
  const total = sum(rows.map((r) => r.sgd));
  const m = new Map<string, number>();
  for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + r.sgd);
  return [...m.entries()]
    .map(([label, value]) => ({ label, value, pct: total ? (value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

export const nonSgdPct = (rows: Lite[]) => {
  const total = sum(rows.map((r) => r.sgd));
  return total ? (sum(rows.filter((r) => r.currency !== "SGD").map((r) => r.sgd)) / total) * 100 : 0;
};

// Assets less debts, per currency. A positive net gains when that currency rises against SGD.
export function netCurrency(model: PortfolioModel) {
  const assets = new Map<string, number>();
  for (const r of [...model.holdings, ...model.savingsRows, ...model.retirementRows, ...model.propertyRows, ...model.cpfRows]) {
    if (r.sgd == null) continue;
    assets.set(r.currency, (assets.get(r.currency) || 0) + r.sgd);
  }
  const debts = new Map<string, number>();
  for (const l of model.loanRows) debts.set(l.currency, (debts.get(l.currency) || 0) + l.owed);
  const currencies = [...new Set([...assets.keys(), ...debts.keys()])];
  return currencies
    .map((currency) => {
      const a = assets.get(currency) || 0;
      const d = debts.get(currency) || 0;
      return { currency, assets: a, debts: d, net: a - d };
    })
    .sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
}

// Cash you hold (deposits plus cash inside portfolios) against loans that fall due soon.
export function loanCover(model: PortfolioModel, withinDays = 30) {
  const cash =
    model.totals.savings +
    sum(
      [...model.holdings, ...model.retirementRows]
        .filter((r) => r.assetClass === "Cash" && r.sgd != null)
        .map((r) => r.sgd as number),
    );
  const due = model.loanRows.filter(
    (l) => l.maturityDate && format.daysUntil(l.maturityDate) <= withinDays,
  );
  const dueTotal = sum(due.map((l) => l.owed));
  return { cash, due, dueTotal, ratio: dueTotal > 0 ? cash / dueTotal : null };
}

// Amount to move per asset class to reach the user's own targets.
export function rebalance(rows: Lite[], targets: Record<string, number>, newMoney: number) {
  const total = sum(rows.map((r) => r.sgd));
  const current = new Map<string, number>();
  for (const r of rows) current.set(r.assetClass, (current.get(r.assetClass) || 0) + r.sgd);
  const classes = [...new Set([...current.keys(), ...Object.keys(targets)])];
  const lines = classes
    .map((label) => {
      const value = current.get(label) || 0;
      const target = targets[label] ?? null;
      const targetAmount = target == null ? null : ((total + newMoney) * target) / 100;
      return {
        label,
        value,
        pct: total ? (value / total) * 100 : 0,
        target,
        targetAmount,
        move: targetAmount == null ? null : targetAmount - value,
      };
    })
    .sort((a, b) => b.value - a.value);
  return { total, lines, targetSum: sum(Object.values(targets)) };
}

export type Hypo = {
  id: number;
  label: string;
  assetClass: string;
  exposure: string; // the currency the position really moves with
  amount: number; // SGD
  funding: "cash" | "new";
  fundingCurrency: string;
};

// Adds the user's hypothetical positions (and, when funded from cash, the matching cash outflow).
export function applyWhatIf(rows: Lite[], items: Hypo[]): Lite[] {
  const out = [...rows];
  for (const it of items) {
    if (!(it.amount > 0)) continue;
    out.push({ assetClass: it.assetClass || "Other", currency: it.exposure || "SGD", sgd: it.amount });
    if (it.funding === "cash") out.push({ assetClass: "Cash", currency: it.fundingCurrency || "SGD", sgd: -it.amount });
  }
  return out;
}

// Before / after shares for one dimension.
export function compare(before: Lite[], after: Lite[], key: "assetClass" | "currency") {
  const b = breakdown(before, key);
  const a = breakdown(after, key);
  const labels = [...new Set([...b.map((x) => x.label), ...a.map((x) => x.label)])];
  return labels
    .map((label) => {
      const bp = b.find((x) => x.label === label);
      const ap = a.find((x) => x.label === label);
      return {
        label,
        beforeValue: bp?.value ?? 0,
        afterValue: ap?.value ?? 0,
        beforePct: bp?.pct ?? 0,
        afterPct: ap?.pct ?? 0,
        change: (ap?.pct ?? 0) - (bp?.pct ?? 0),
      };
    })
    .sort((x, y) => y.afterValue - x.afterValue);
}

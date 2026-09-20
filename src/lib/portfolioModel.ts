import type { Overview, PositionRow } from "../../shared/schema";

const CONCENTRATION = 0.2;

const toSgd = (r: PositionRow, fx: Record<string, number>): number | null => {
  if (r.valueSgd != null) return r.valueSgd;
  if (r.valueLocal == null) return null;
  if (r.currency === "SGD") return r.valueLocal;
  const rate = fx[r.currency];
  return rate ? r.valueLocal * rate : null;
};

export type Row = PositionRow & { sgd: number | null };

function group(rows: Row[], key: (r: Row) => string) {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.sgd == null) continue;
    m.set(key(r), (m.get(key(r)) || 0) + r.sgd);
  }
  return [...m.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

const sum = (rows: Row[]) => rows.reduce((n, r) => n + (r.sgd ?? 0), 0);
const newest = (rows: Row[]) =>
  rows.reduce<string | null>((m, r) => (!m || r.asOf > m ? r.asOf : m), null);

// Turns the raw rows into the totals every tab needs.
export function buildPortfolioModel(data: Overview) {
  const rows: Row[] = data.positions.map((r) => ({ ...r, sgd: toSgd(r, data.fx) }));
  const of = (kind: Row["kind"]) => rows.filter((r) => r.kind === kind);
  const holdings = of("holding");
  const savings = of("savings");
  const retirement = of("retirement");
  const loans = of("loan");

  const investmentsTotal = sum(holdings);
  const savingsTotal = sum(savings);
  const retirementTotal = sum(retirement);
  const assets = investmentsTotal + savingsTotal + retirementTotal;
  const owed = -sum(loans); // loans are stored as negative values
  const net = assets - owed;

  const allAssets = [...holdings, ...savings, ...retirement];
  // Positions only: cash and net-short lines (such as options) are not "holdings".
  const investable = [...holdings, ...retirement].filter(
    (r) => r.assetClass !== "Cash" && (r.sgd ?? 0) > 0,
  );
  const investedTotal = sum(investable);

  // The same security held in several places is combined.
  const combined = new Map<string, { name: string; where: string[]; value: number }>();
  for (const r of investable) {
    if (r.sgd == null) continue;
    const k = (r.isin || r.symbol || r.name).toUpperCase();
    const c = combined.get(k) || { name: r.name, where: [], value: 0 };
    c.value += r.sgd;
    const place = r.kind === "retirement" ? `${r.broker} ${r.accountLabel}`.trim() : r.broker;
    if (!c.where.includes(place)) c.where.push(place);
    combined.set(k, c);
  }
  const top = [...combined.values()].sort((a, b) => b.value - a.value);

  const loanRows = loans
    .map((r) => ({
      key: `${r.broker}|${r.accountLabel}|${r.name}`,
      name: r.name,
      broker: r.broker,
      accountLabel: r.accountLabel,
      assetClass: r.assetClass,
      currency: r.currency,
      owed: -(r.sgd ?? 0),
      ratePct: r.ratePct,
      maturityDate: r.maturityDate,
      monthlyPayment: r.monthlyPayment,
      note: r.note,
      asOf: r.asOf,
    }))
    .sort((a, b) => b.owed - a.owed);
  const rated = loanRows.filter((l) => l.ratePct != null);
  const ratedOwed = rated.reduce((n, l) => n + l.owed, 0);

  const missingFx = [...new Set(rows.filter((r) => r.sgd == null).map((r) => r.currency))];

  return {
    rows,
    holdings,
    savingsRows: savings.slice().sort((a, b) => (b.sgd ?? 0) - (a.sgd ?? 0)),
    retirementRows: retirement.slice().sort((a, b) => (b.sgd ?? 0) - (a.sgd ?? 0)),
    loanRows,
    totals: {
      investments: investmentsTotal,
      savings: savingsTotal,
      retirement: retirementTotal,
      assets,
      owed,
      net,
      owedToAssets: assets ? owed / assets : 0,
      owedToNet: net ? owed / net : 0,
    },
    loanStats: {
      weightedRate: ratedOwed
        ? rated.reduce((n, l) => n + l.owed * (l.ratePct ?? 0), 0) / ratedOwed
        : null,
      annualInterest: rated.reduce((n, l) => n + (l.owed * (l.ratePct ?? 0)) / 100, 0),
      monthlyKnown: loanRows.reduce((n, l) => n + (l.monthlyPayment ?? 0), 0),
    },
    asOf: {
      investments: newest(holdings),
      savings: newest(savings),
      retirement: newest(retirement),
      loans: newest(loans),
      latest: newest(rows),
    },
    groups: {
      byType: [
        { label: "Investments", value: investmentsTotal },
        { label: "Savings", value: savingsTotal },
        { label: "Retirement (SRS/CPFIS)", value: retirementTotal },
      ].filter((g) => g.value > 0),
      byClass: group(allAssets, (r) => r.assetClass),
      byCurrency: group(allAssets, (r) => r.currency),
      byBroker: group(allAssets, (r) => r.broker),
      savingsByBank: group(savings, (r) => r.broker),
      savingsByCurrency: group(savings, (r) => r.currency),
    },
    top,
    concentration: top.filter((t) => investedTotal && t.value / investedTotal > CONCENTRATION),
    investedTotal,
    missingFx,
    currencies: [...new Set(rows.map((r) => r.currency))],
  };
}

export type PortfolioModel = ReturnType<typeof buildPortfolioModel>;

import { format } from "../lib/format";
import type { PortfolioModel } from "../lib/portfolioModel";

interface Props {
  model: PortfolioModel;
}

const SOON_DAYS = 14;

export function LoansPanel({ model }: Props) {
  const { loanRows, totals, loanStats, asOf } = model;

  if (loanRows.length === 0) {
    return (
      <section className="card state">
        <h2>No loans or debts</h2>
        <p>Import a statement or a loans table on the Import tab to track what you owe.</p>
      </section>
    );
  }

  const soon = loanRows
    .filter((l) => l.maturityDate && format.daysUntil(l.maturityDate) <= SOON_DAYS)
    .sort((a, b) => (a.maturityDate! < b.maturityDate! ? -1 : 1));

  return (
    <div>
      {soon.length > 0 && (
        <section className="flags">
          <h3>Coming up</h3>
          <ul>
            {soon.map((l) => {
              const days = format.daysUntil(l.maturityDate!);
              return (
                <li key={l.key}>
                  {l.name}{" "}
                  {days < 0 ? `was due ${-days} day(s) ago` : days === 0 ? "is due today" : `is due in ${days} day(s)`} (
                  {format.date(l.maturityDate)}). Owed: SGD {format.money(l.owed)}.
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Total owed</span>
          <span className="kpi-value">{format.money(totals.owed)}</span>
          <span className="kpi-sub">SGD · as of {format.date(asOf.loans)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Estimated interest a year</span>
          <span className="kpi-value">{format.money(loanStats.annualInterest)}</span>
          <span className="kpi-sub">SGD, from each loan's rate</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Average rate</span>
          <span className="kpi-value">
            {loanStats.weightedRate == null ? "–" : `${loanStats.weightedRate.toFixed(2)}%`}
          </span>
          <span className="kpi-sub">weighted by amount owed</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Debts / assets</span>
          <span className="kpi-value">{format.pct(totals.owedToAssets)}</span>
          <span className="kpi-sub">{format.pct(totals.owedToNet)} of net worth</span>
        </div>
        {loanStats.monthlyKnown > 0 && (
          <div className="kpi">
            <span className="kpi-label">Known monthly payments</span>
            <span className="kpi-value">{format.money(loanStats.monthlyKnown)}</span>
            <span className="kpi-sub">SGD, where a payment is recorded</span>
          </div>
        )}
      </div>

      <section className="card">
        <h3>What you owe</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Debt</th>
                <th>Lender</th>
                <th>Type</th>
                <th className="num">Owed (SGD)</th>
                <th className="num">Rate</th>
                <th>Due / matures</th>
                <th className="num">Monthly</th>
                <th>As of</th>
              </tr>
            </thead>
            <tbody>
              {loanRows.map((l) => {
                const days = l.maturityDate ? format.daysUntil(l.maturityDate) : null;
                return (
                  <tr key={l.key}>
                    <td className="wrap">
                      {l.name}
                      {l.note && <div className="note-line">{l.note}</div>}
                    </td>
                    <td>{l.broker}</td>
                    <td>{l.assetClass}</td>
                    <td className="num">{format.money(l.owed)}</td>
                    <td className="num">{l.ratePct == null ? "–" : `${l.ratePct}%`}</td>
                    <td className={days != null && days <= SOON_DAYS ? "soon" : ""}>
                      {l.maturityDate ? `${format.date(l.maturityDate)} (${days}d)` : "–"}
                    </td>
                    <td className="num">{l.monthlyPayment == null ? "–" : format.money(l.monthlyPayment)}</td>
                    <td>{format.date(l.asOf)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

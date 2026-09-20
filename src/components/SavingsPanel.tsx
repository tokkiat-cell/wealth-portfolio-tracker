import { AllocationDonut } from "./AllocationDonut";
import { format } from "../lib/format";
import type { PortfolioModel } from "../lib/portfolioModel";

interface Props {
  model: PortfolioModel;
}

export function SavingsPanel({ model }: Props) {
  const { savingsRows, retirementRows, totals, groups, asOf } = model;

  // SRS / CPFIS lines grouped by account.
  const accounts = new Map<string, { title: string; total: number; rows: typeof retirementRows }>();
  for (const r of retirementRows) {
    const key = `${r.broker}|${r.accountLabel}`;
    const a = accounts.get(key) || {
      title: `${r.broker}${r.accountLabel ? " " + r.accountLabel : ""}`,
      total: 0,
      rows: [],
    };
    a.total += r.sgd ?? 0;
    a.rows.push(r);
    accounts.set(key, a);
  }

  if (savingsRows.length === 0 && retirementRows.length === 0) {
    return (
      <section className="card state">
        <h2>No savings yet</h2>
        <p>Import a bank statement (PDF) or a deposits table on the Import tab.</p>
      </section>
    );
  }

  return (
    <div>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Savings and deposits</span>
          <span className="kpi-value">{format.money(totals.savings)}</span>
          <span className="kpi-sub">SGD · as of {format.date(asOf.savings)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Retirement (SRS / CPFIS)</span>
          <span className="kpi-value">{format.money(totals.retirement)}</span>
          <span className="kpi-sub">SGD · as of {format.date(asOf.retirement)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Savings less debts</span>
          <span className="kpi-value">{format.money(totals.savings - totals.owed)}</span>
          <span className="kpi-sub">deposits minus every loan and card</span>
        </div>
      </div>

      {savingsRows.length > 0 && (
        <>
          <div className="grid">
            <AllocationDonut title="Savings by bank" slices={groups.savingsByBank} />
            <AllocationDonut title="Savings by currency" slices={groups.savingsByCurrency} />
          </div>

          <section className="card">
            <h3>Deposit accounts</h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Bank</th>
                    <th>Account</th>
                    <th>Ccy</th>
                    <th className="num">Balance</th>
                    <th className="num">Value (SGD)</th>
                    <th className="num">Rate</th>
                    <th>As of</th>
                  </tr>
                </thead>
                <tbody>
                  {savingsRows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.broker}</td>
                      <td>{r.name}</td>
                      <td>{r.currency}</td>
                      <td className="num">{format.cents(r.valueLocal ?? r.valueSgd)}</td>
                      <td className="num">{r.sgd == null ? "no FX" : format.cents(r.sgd)}</td>
                      <td className="num">{r.ratePct == null ? "–" : `${r.ratePct}%`}</td>
                      <td>{format.date(r.asOf)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {[...accounts.values()].map((a) => (
        <section key={a.title} className="card">
          <h3>
            {a.title} <span className="muted">· SGD {format.cents(a.total)}</span>
          </h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Holding</th>
                  <th>Class</th>
                  <th className="num">Qty</th>
                  <th className="num">Value (SGD)</th>
                  <th className="num">P/L %</th>
                </tr>
              </thead>
              <tbody>
                {a.rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td>{r.assetClass}</td>
                    <td className="num">{r.quantity == null ? "–" : r.quantity.toLocaleString("en-SG")}</td>
                    <td className="num">{r.sgd == null ? "no FX" : format.cents(r.sgd)}</td>
                    <td className={`num ${r.plPct == null ? "" : r.plPct < 0 ? "loss" : "gain"}`}>
                      {format.signedPct(r.plPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

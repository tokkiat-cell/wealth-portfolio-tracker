import { useState } from "react";
import { api } from "../lib/api";
import { format } from "../lib/format";
import type { PortfolioModel } from "../lib/portfolioModel";
import { toast } from "../lib/toast";
import type { PositionInput } from "../../shared/schema";

interface Props {
  model: PortfolioModel;
  onChanged: () => void;
}

const CPF_ACCOUNTS = [
  { key: "OA", name: "Ordinary Account (OA)", use: "Housing, education, investment" },
  { key: "SA", name: "Special Account (SA)", use: "Retirement" },
  { key: "MA", name: "MediSave Account (MA)", use: "Approved medical costs" },
  { key: "RA", name: "Retirement Account (RA)", use: "Retirement payouts" },
] as const;

type PropDraft = { name: string; value: string; note: string };

const line = (name: string, assetClass: string, value: number, note: string): PositionInput => ({
  name,
  symbol: "",
  isin: "",
  assetClass,
  currency: "SGD",
  quantity: null,
  price: null,
  valueLocal: value,
  valueSgd: value,
  plPct: null,
  ratePct: null,
  maturityDate: null,
  monthlyPayment: null,
  note,
});

const letterOf = (s: string, pattern: RegExp) => s.match(pattern)?.[1]?.toUpperCase() ?? null;

export function PropertyCpfPanel({ model, onChanged }: Props) {
  const { totals, propertyRows, cpfRows, loanRows, asOf } = model;

  const [props, setProps] = useState<PropDraft[]>(() =>
    propertyRows.map((r) => ({ name: r.name, value: String(r.sgd ?? ""), note: r.note })),
  );
  const [cpf, setCpf] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      CPF_ACCOUNTS.map((a) => [a.key, String(cpfRows.find((r) => r.name.includes(`(${a.key})`))?.sgd ?? "")]),
    ),
  );
  const [propDate, setPropDate] = useState(format.today());
  const [cpfDate, setCpfDate] = useState(format.today());
  const [saving, setSaving] = useState<"property" | "cpf" | null>(null);

  // A mortgage belongs to a property when both carry the same letter: "Property A" and "(property A)".
  const owedBy = new Map<string, number>();
  for (const l of loanRows) {
    if (!/mortgage/i.test(l.assetClass)) continue;
    const k = letterOf(l.name, /\(property ([A-Z])\)/i) ?? "?";
    owedBy.set(k, (owedBy.get(k) ?? 0) + l.owed);
  }
  const owedFor = (name: string) => owedBy.get(letterOf(name, /^Property\s+([A-Z])\b/i) ?? "!") ?? 0;
  const equity = totals.property - totals.mortgages;

  const saveProperty = async () => {
    const positions = props
      .map((p) => ({ name: p.name.trim(), value: Number(p.value), note: p.note.trim() }))
      .filter((p) => p.name && Number.isFinite(p.value) && p.value > 0)
      .map((p) => line(p.name, "Property", p.value, p.note));
    if (positions.length === 0) return toast.error("Add at least one property with a name and a value.");
    setSaving("property");
    try {
      await api.importSnapshot({
        broker: "Property",
        accountLabel: "",
        kind: "property",
        asOf: propDate,
        source: "Owner estimates, entered by hand",
        positions,
      });
      toast.ok("Property values saved.");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(null);
    }
  };

  const saveCpf = async () => {
    const positions = CPF_ACCOUNTS.map((a) => ({ a, v: Number(cpf[a.key]) }))
      .filter(({ v }) => Number.isFinite(v) && v > 0)
      .map(({ a, v }) => line(a.name, "CPF", v, a.use));
    if (positions.length === 0) return toast.error("Enter at least one CPF balance.");
    setSaving("cpf");
    try {
      await api.importSnapshot({
        broker: "CPF",
        accountLabel: "",
        kind: "cpf",
        asOf: cpfDate,
        source: "CPF balances, entered by hand",
        positions,
      });
      toast.ok("CPF balances saved.");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <div className="kpis">
        <div className="kpi strong">
          <span className="kpi-label">Property (estimates)</span>
          <span className="kpi-value">{format.money(totals.property)}</span>
          <span className="kpi-sub">SGD · as of {format.date(asOf.property)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Mortgages</span>
          <span className="kpi-value">{format.money(totals.mortgages)}</span>
          <span className="kpi-sub">DBS home loans, SGD</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Property equity</span>
          <span className="kpi-value">{format.money(equity)}</span>
          <span className="kpi-sub">
            {totals.property ? `loan is ${format.share(totals.mortgages, totals.property)} of value` : "value less mortgages"}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">CPF</span>
          <span className="kpi-value">{format.money(totals.cpf)}</span>
          <span className="kpi-sub">SGD · as of {format.date(asOf.cpf)}</span>
        </div>
      </div>

      <section className="card">
        <h3>Property</h3>
        {propertyRows.length === 0 ? (
          <p className="muted">No property yet. Add your estimated values below.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Property</th>
                  <th className="num">Estimated value</th>
                  <th className="num">Mortgage</th>
                  <th className="num">Equity</th>
                  <th className="num">Loan / value</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {propertyRows.map((r, i) => {
                  const owed = owedFor(r.name);
                  const v = r.sgd ?? 0;
                  return (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td className="num">{format.money(v)}</td>
                      <td className="num">{owed ? format.money(owed) : "–"}</td>
                      <td className="num">{format.money(v - owed)}</td>
                      <td className="num">{owed && v ? format.share(owed, v) : "–"}</td>
                      <td className="wrap">{r.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Values are your own estimates, not valuations. Equity ignores selling costs, stamp duty, and any CPF that
          would have to be refunded with accrued interest on a sale. A mortgage is matched to a property when both carry
          the same letter, such as "Property A" and "(property A)".
        </p>
      </section>

      <section className="card">
        <h3>CPF</h3>
        {cpfRows.length === 0 ? (
          <p className="muted">No CPF balances yet. Add them below.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Balance</th>
                  <th className="num">% of CPF</th>
                  <th>Used for</th>
                </tr>
              </thead>
              <tbody>
                {cpfRows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name}</td>
                    <td className="num">{format.cents(r.sgd)}</td>
                    <td className="num">{format.share(r.sgd ?? 0, totals.cpf)}</td>
                    <td>{r.note}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td className="num">
                    <strong>{format.cents(totals.cpf)}</strong>
                  </td>
                  <td />
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          CPF has no feed this app can read: it needs your Singpass, which is never entered here. Copy the balances from
          the CPF app or a balance statement. They are locked to CPF rules and are not liquid cash. CPF used for housing
          and its accrued interest are not included.
        </p>
      </section>

      <details className="card" open={propertyRows.length === 0 && cpfRows.length === 0}>
        <summary>Enter or update property values and CPF balances</summary>

        <h3 style={{ marginTop: "0.75rem" }}>Property</h3>
        <p className="muted">
          Use a short label such as "Property A (condo)" rather than a full address. Saving on a new date keeps the older
          values as history.
        </p>
        {props.map((p, i) => (
          <div className="form" key={i}>
            <label className="field">
              Name
              <input value={p.name} onChange={(e) => setProps(props.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            </label>
            <label className="field">
              Estimated value (SGD)
              <input
                type="number"
                min="0"
                step="1000"
                value={p.value}
                onChange={(e) => setProps(props.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
            </label>
            <label className="field">
              Note
              <input value={p.note} onChange={(e) => setProps(props.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />
            </label>
            <div className="field">
              <span>&nbsp;</span>
              <button className="btn small" type="button" onClick={() => setProps(props.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          </div>
        ))}
        <div className="actions">
          <button className="btn small" type="button" onClick={() => setProps([...props, { name: "", value: "", note: "" }])}>
            Add a property
          </button>
          <label className="row muted">
            As of
            <input type="date" value={propDate} onChange={(e) => setPropDate(e.target.value)} style={{ width: "auto" }} />
          </label>
          <button className="btn primary" type="button" onClick={saveProperty} disabled={saving !== null || !propDate}>
            {saving === "property" ? "Saving…" : "Save property"}
          </button>
        </div>

        <h3 style={{ marginTop: "1.25rem" }}>CPF</h3>
        <div className="form">
          {CPF_ACCOUNTS.map((a) => (
            <label className="field" key={a.key}>
              {a.name} (SGD)
              <input
                type="number"
                min="0"
                step="0.01"
                value={cpf[a.key]}
                onChange={(e) => setCpf({ ...cpf, [a.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="actions">
          <label className="row muted">
            As of
            <input type="date" value={cpfDate} onChange={(e) => setCpfDate(e.target.value)} style={{ width: "auto" }} />
          </label>
          <button className="btn primary" type="button" onClick={saveCpf} disabled={saving !== null || !cpfDate}>
            {saving === "cpf" ? "Saving…" : "Save CPF"}
          </button>
        </div>
      </details>
    </div>
  );
}

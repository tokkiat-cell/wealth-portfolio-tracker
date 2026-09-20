import { useState } from "react";
import { BROKERS } from "./ImportPanel";
import { api } from "../lib/api";
import { format } from "../lib/format";
import { toast } from "../lib/toast";
import type { ExtractedStatement } from "../../shared/schema";

const KIND_LABEL = {
  holding: "Investments",
  savings: "Savings",
  retirement: "Retirement (SRS / CPFIS)",
  loan: "Loans and debts",
  property: "Property",
  cpf: "CPF",
} as const;

interface Props {
  result: ExtractedStatement;
  initialBroker: string;
  source: string; // stored with each snapshot, e.g. "PDF: statement.pdf"
  from: string; // used in the confirmation, e.g. "from the PDF"
  flaggedBy: string; // "The reader flagged" / "The fetch flagged"
  footnote: string;
  onImported: () => void;
  onDiscard: () => void;
}

// Shows what was read, lets the person untick sections, then saves each section as a snapshot.
export function ReviewImport({ result, initialBroker, source, from, flaggedBy, footnote, onImported, onDiscard }: Props) {
  const [broker, setBroker] = useState(initialBroker);
  const [asOf, setAsOf] = useState(result.statementDate ?? format.today());
  const [skip, setSkip] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);

  const doImport = async () => {
    setSaving(true);
    try {
      let n = 0;
      for (const [i, s] of result.sections.entries()) {
        if (skip[i]) continue;
        const r = await api.importSnapshot({
          broker,
          accountLabel: s.accountLabel,
          kind: s.kind,
          asOf,
          source: source.slice(0, 200),
          positions: s.positions,
        });
        n += r.inserted;
      }
      toast.ok(`Imported ${n} lines ${from}.`);
      onImported();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setSaving(false);
    }
  };

  const sectionTotal = (s: ExtractedStatement["sections"][number]) => {
    let total = 0;
    let missing = 0;
    for (const p of s.positions) {
      const v = p.valueSgd ?? (p.currency === "SGD" ? p.valueLocal : null);
      if (v == null) missing++;
      else total += v;
    }
    return { total, missing };
  };

  const chosen = result.sections.filter((_, i) => !skip[i]).length;

  return (
    <>
      <div className="form">
        <div className="field">
          <span>Institution read</span>
          <strong>{result.institution || "Unknown"}</strong>
        </div>
        <label className="field">
          <span>Broker / bank</span>
          <select value={broker} onChange={(e) => setBroker(e.target.value)}>
            {BROKERS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Statement date</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>

      {result.sections.map((s, i) => {
        const t = sectionTotal(s);
        return (
          <div key={i} className={`table-card ${skip[i] ? "skipped" : ""}`}>
            <div className="head">
              <div>
                <strong>{KIND_LABEL[s.kind]}</strong>
                {s.accountLabel && <span className="muted"> · {s.accountLabel}</span>}
                <div className="muted">
                  {s.positions.length} lines · total SGD {format.cents(t.total)}
                  {t.missing > 0 && ` (${t.missing} without an SGD value)`}
                </div>
              </div>
              <label className="row muted">
                <input
                  type="checkbox"
                  checked={!skip[i]}
                  onChange={(e) => setSkip((prev) => ({ ...prev, [i]: !e.target.checked }))}
                />
                Include
              </label>
            </div>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Class</th>
                    <th>Ccy</th>
                    <th className="num">Value</th>
                    <th className="num">Value SGD</th>
                    {s.kind === "loan" && <th className="num">Rate</th>}
                    {s.kind === "loan" && <th>Due</th>}
                  </tr>
                </thead>
                <tbody>
                  {s.positions.map((p, j) => (
                    <tr key={j}>
                      <td>
                        {p.name}
                        {p.symbol && <span className="mono"> {p.symbol}</span>}
                      </td>
                      <td>{p.assetClass}</td>
                      <td>{p.currency}</td>
                      <td className="num">{format.cents(p.valueLocal)}</td>
                      <td className="num">{format.cents(p.valueSgd)}</td>
                      {s.kind === "loan" && <td className="num">{p.ratePct == null ? "–" : `${p.ratePct}%`}</td>}
                      {s.kind === "loan" && <td>{p.maturityDate ?? "–"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {(result.skipped > 0 || result.notes.length > 0) && (
        <div className="flags">
          <h3>{flaggedBy}</h3>
          <ul>
            {result.skipped > 0 && <li>{result.skipped} line(s) were dropped because they had no value.</li>}
            {result.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted">{footnote}</p>
      <div className="actions">
        <button className="btn primary" onClick={doImport} disabled={chosen === 0 || !asOf || saving}>
          {saving ? "Importing…" : `Import ${chosen} section${chosen === 1 ? "" : "s"}`}
        </button>
        <button className="btn ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </button>
      </div>
    </>
  );
}

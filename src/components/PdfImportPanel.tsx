import { useState } from "react";
import { Dropzone } from "./Dropzone";
import { BROKERS } from "./ImportPanel";
import { api } from "../lib/api";
import { format } from "../lib/format";
import { toast } from "../lib/toast";
import { MAX_PDF_BYTES, type ExtractedStatement } from "../../shared/schema";

const KIND_LABEL = {
  holding: "Investments",
  savings: "Savings",
  retirement: "Retirement (SRS / CPFIS)",
  loan: "Loans and debts",
} as const;

const guessBroker = (institution: string) => {
  const t = institution.toLowerCase();
  if (/vickers/.test(t)) return "DBS Vickers";
  if (/dbs|posb/.test(t)) return "DBS";
  if (/standard chartered|scb/.test(t)) return "SCB";
  if (/uob|united overseas/.test(t)) return "UOB";
  if (/moomoo|futu/.test(t)) return "Moomoo";
  if (/interactive|ibkr/.test(t)) return "IBKR";
  return "Other";
};

interface Props {
  onChanged: () => void;
}

export function PdfImportPanel({ onChanged }: Props) {
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ExtractedStatement | null>(null);
  const [fileName, setFileName] = useState("");
  const [broker, setBroker] = useState("DBS");
  const [asOf, setAsOf] = useState(format.today());
  const [skip, setSkip] = useState<Record<number, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const read = async (files: File[]) => {
    const file = files[0];
    setError(null);
    setResult(null);
    setSkip({});
    setFileName(file.name);
    setReading(true);
    try {
      const r = await api.extractPdf(file);
      setResult(r);
      setBroker(guessBroker(r.institution));
      if (r.statementDate) setAsOf(r.statementDate);
      if (r.sections.length === 0) setError("No balances were found in that PDF.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that PDF");
    } finally {
      setReading(false);
    }
  };

  const doImport = async () => {
    if (!result) return;
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
          source: `PDF: ${fileName}`.slice(0, 200),
          positions: s.positions,
        });
        n += r.inserted;
      }
      toast.ok(`Imported ${n} lines from the PDF.`);
      setResult(null);
      setFileName("");
      onChanged();
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

  const chosen = result ? result.sections.filter((_, i) => !skip[i]).length : 0;

  return (
    <section className="card">
      <h3>Import a PDF statement</h3>
      <p className="muted">
        Works with bank and broker statements (DBS, SCB, UOB and similar). Google's Gemini reads the PDF and lists the
        balances, holdings and loans it finds. You review them before anything is saved.
      </p>
      <p className="notice" style={{ marginTop: "0.5rem" }}>
        Privacy: the whole PDF is sent to Google's Gemini API, and statements contain personal details. The AI is told
        to leave names, addresses and transactions out of its answer, and the PDF is not stored here. If you would
        rather not send it, use a CSV or an Obsidian note instead, which stay in your browser.
      </p>

      <Dropzone
        accept=".pdf,application/pdf"
        maxBytes={MAX_PDF_BYTES}
        title="Drop a PDF statement here, or click to choose"
        subtitle="One file, up to 3.5 MB"
        disabled={reading || saving}
        onFiles={read}
        onError={toast.error}
      />

      {reading && <p>Reading {fileName}. This can take up to a minute.</p>}
      {error && <p className="notice error">{error}</p>}

      {result && result.sections.length > 0 && (
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
              <h3>The reader flagged</h3>
              <ul>
                {result.skipped > 0 && <li>{result.skipped} line(s) were dropped because they had no value.</li>}
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted">
            Check these against your statement before importing. Totals here are the sum of the lines the AI read.
          </p>
          <div className="actions">
            <button className="btn primary" onClick={doImport} disabled={chosen === 0 || !asOf || saving}>
              {saving ? "Importing…" : `Import ${chosen} section${chosen === 1 ? "" : "s"}`}
            </button>
            <button className="btn ghost" onClick={() => setResult(null)} disabled={saving}>
              Discard
            </button>
          </div>
        </>
      )}
    </section>
  );
}

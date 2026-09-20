import { useEffect, useMemo, useState } from "react";
import { Dropzone } from "./Dropzone";
import { CLASSES, DISPLAY_FIELDS, importParsing, type Kind, type Table } from "../lib/importParsing";
import { api } from "../lib/api";
import { format } from "../lib/format";
import { toast } from "../lib/toast";
import type { PositionInput } from "../../shared/schema";

export const BROKERS = ["DBS", "DBS Vickers", "UOB", "SCB", "Moomoo", "Tiger", "IBKR", "CPF", "Other"];
const NONE = "__none";

type Source = { name: string; text: string };
type Override = { mapping?: Record<string, string>; classChoice?: string; kind?: Kind };

const KIND_OPTIONS: { value: Kind; label: string }[] = [
  { value: "holding", label: "Investments" },
  { value: "savings", label: "Savings / deposits" },
  { value: "retirement", label: "Retirement (SRS, CPFIS)" },
  { value: "loan", label: "Loans and other debts" },
];

interface Props {
  onChanged: () => void;
}

export function ImportPanel({ onChanged }: Props) {
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [sources, setSources] = useState<Source[]>([]);
  const [pasted, setPasted] = useState("");
  const [broker, setBroker] = useState("DBS");
  const [account, setAccount] = useState("");
  const [asOf, setAsOf] = useState(format.today());
  const [asOfTouched, setAsOfTouched] = useState(false);
  const [valueBasis, setValueBasis] = useState("row");
  const [plFormat, setPlFormat] = useState("percent");
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    const all: Source[] = [...sources, ...(pasted.trim() ? [{ name: "", text: pasted }] : [])];
    const tables: { id: string; source: string; table: Table; auto: Record<string, string> }[] = [];
    let asOfHint: string | null = null;
    all.forEach((s, si) => {
      const r = importParsing.parseAny(s.text, s.name);
      if (!asOfHint && r.asOf) asOfHint = r.asOf;
      r.tables.forEach((t, ti) =>
        tables.push({ id: `${si}-${ti}`, source: s.name || "Pasted text", table: t, auto: importParsing.autoMap(t) }),
      );
    });
    return { tables, asOfHint };
  }, [sources, pasted]);

  useEffect(() => {
    if (parsed.asOfHint && !asOfTouched) setAsOf(parsed.asOfHint);
  }, [parsed.asOfHint, asOfTouched]);

  const built = useMemo(
    () =>
      parsed.tables.map((t) => {
        const o = overrides[t.id] || {};
        const mapping = o.mapping ?? t.auto;
        const classChoice = o.classChoice ?? "auto";
        const kind: Kind = o.kind ?? t.table.kindHint ?? "holding";
        const usable = importParsing.isUsable(mapping);
        const res = usable
          ? importParsing.buildRows(t.table, mapping, {
              kind,
              classChoice,
              classHint: t.table.classHint,
              valueIsSgd: valueBasis === "sgd",
              plFraction: plFormat === "fraction",
            })
          : { rows: [] as PositionInput[], skipped: [] as string[] };
        return { t, mapping, classChoice, kind, usable, ...res };
      }),
    [parsed, overrides, valueBasis, plFormat],
  );

  const totalRows = built.reduce((n, b) => n + b.rows.length, 0);
  const patch = (id: string, change: Override) =>
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...change } }));

  const readFiles = async (files: File[]) => {
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
    setSources(read);
    setOverrides({});
  };

  const reset = () => {
    setSources([]);
    setPasted("");
    setOverrides({});
    setAsOfTouched(false);
  };

  const doImport = async () => {
    const groups: Record<Kind, PositionInput[]> = { holding: [], savings: [], retirement: [], loan: [] };
    built.forEach((b) => groups[b.kind].push(...b.rows));
    const source = sources.map((s) => s.name).join(", ").slice(0, 200) || "Pasted text";
    setBusy(true);
    try {
      let n = 0;
      for (const kind of ["holding", "savings", "retirement", "loan"] as const) {
        if (groups[kind].length === 0) continue;
        const r = await api.importSnapshot({
          broker,
          accountLabel: account.trim(),
          kind,
          asOf,
          source,
          positions: groups[kind],
        });
        n += r.inserted;
      }
      toast.ok(`Imported ${n} lines from ${broker}.`);
      reset();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const hasInput = sources.length > 0 || pasted.trim() !== "";

  return (
    <section className="card">
      <h3>Add data from a file or pasted table</h3>
      <p className="muted">
        Upload CSV or Obsidian (.md) files, or paste a table. This is read in your browser, and only the lines you
        confirm are saved.
      </p>

      <div className="subtabs">
        <button className="subtab" aria-pressed={mode === "file"} onClick={() => setMode("file")}>
          Upload files
        </button>
        <button className="subtab" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
          Paste text
        </button>
      </div>

      {mode === "file" ? (
        <>
          <Dropzone
            accept=".csv,.tsv,.md,.markdown,.txt"
            multiple
            title="Drop CSV or Obsidian .md files here, or click to choose"
            subtitle="One or many files. Each table in a note becomes a set of lines."
            onFiles={readFiles}
            onError={toast.error}
          />
          {sources.length > 0 && <p className="muted">Loaded: {sources.map((s) => s.name).join(", ")}</p>}
        </>
      ) : (
        <textarea
          rows={8}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste a table from a broker page, a spreadsheet, a CSV, or an Obsidian note here."
          aria-label="Pasted text"
        />
      )}

      <div className="form">
        <label className="field">
          <span>Broker / bank</span>
          <select value={broker} onChange={(e) => setBroker(e.target.value)}>
            {BROKERS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Account label</span>
          <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="optional, e.g. …1234" maxLength={60} />
        </label>
        <label className="field">
          <span>As-of date</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => {
              setAsOf(e.target.value);
              setAsOfTouched(true);
            }}
          />
        </label>
        <label className="field">
          <span>Value column is in</span>
          <select value={valueBasis} onChange={(e) => setValueBasis(e.target.value)}>
            <option value="row">Each row's currency</option>
            <option value="sgd">SGD</option>
          </select>
        </label>
        <label className="field">
          <span>P/L column looks like</span>
          <select value={plFormat} onChange={(e) => setPlFormat(e.target.value)}>
            <option value="percent">Percent (25 or 25%)</option>
            <option value="fraction">Fraction (0.25)</option>
          </select>
        </label>
      </div>

      {built.length === 0 && hasInput && (
        <p className="notice error">No table found. Check that the text has a header row and at least one data row.</p>
      )}

      {built.map((b) => (
        <div key={b.t.id} className="table-card">
          <div className="head">
            <strong>{b.t.table.title}</strong>
            <span className="muted">
              {b.t.source} · {b.rows.length} lines
              {b.skipped.length > 0 && `, ${b.skipped.length} skipped (no value)`}
            </span>
          </div>
          {b.t.table.note && <p className="muted">{b.t.table.note}</p>}
          {!b.usable && (
            <p className="notice error">
              Not included yet: no name and value columns were matched. Match them below to include this table.
            </p>
          )}
          <div className="form">
            <label className="field">
              <span>Type</span>
              <select value={b.kind} onChange={(e) => patch(b.t.id, { kind: e.target.value as Kind })}>
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Asset class</span>
              <select
                value={b.classChoice}
                onChange={(e) => patch(b.t.id, { classChoice: e.target.value })}
                disabled={b.kind === "loan"}
              >
                <option value="auto">Auto{b.t.table.classHint ? ` (${b.t.table.classHint})` : ""}</option>
                {CLASSES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>

          <details open={!b.usable}>
            <summary>Match columns</summary>
            <div className="map-grid">
              {DISPLAY_FIELDS.map((f) => (
                <label key={f.key} className="field">
                  <span>{f.label}</span>
                  <select
                    value={b.mapping[f.key] || NONE}
                    onChange={(e) =>
                      patch(b.t.id, {
                        mapping: { ...b.mapping, [f.key]: e.target.value === NONE ? "" : e.target.value },
                      })
                    }
                  >
                    <option value={NONE}>(not in file)</option>
                    {b.t.table.headers
                      .filter((h) => h)
                      .map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </div>
          </details>

          {b.rows.length > 0 && (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Line</th>
                    <th>Class</th>
                    <th>Ccy</th>
                    <th className="num">Value</th>
                    <th className="num">Value SGD</th>
                    <th className="num">P/L %</th>
                  </tr>
                </thead>
                <tbody>
                  {b.rows.slice(0, 5).map((r, i) => (
                    <tr key={i}>
                      <td>
                        {r.name}
                        {r.symbol && <span className="mono"> {r.symbol}</span>}
                      </td>
                      <td>{r.assetClass}</td>
                      <td>{r.currency}</td>
                      <td className="num">{format.money(r.valueLocal)}</td>
                      <td className="num">{format.money(r.valueSgd)}</td>
                      <td className="num">{r.plPct == null ? "–" : `${(r.plPct * 100).toFixed(1)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {b.rows.length > 5 && <p className="muted">…and {b.rows.length - 5} more lines</p>}
            </div>
          )}
        </div>
      ))}

      <div className="actions">
        <button className="btn primary" onClick={doImport} disabled={totalRows === 0 || !asOf || busy}>
          {busy ? "Importing…" : `Import ${totalRows} lines`}
        </button>
        {hasInput && (
          <button className="btn ghost" onClick={reset} disabled={busy}>
            Clear
          </button>
        )}
        <span className="muted">Importing the same broker, account, type and date replaces that snapshot.</span>
      </div>
    </section>
  );
}

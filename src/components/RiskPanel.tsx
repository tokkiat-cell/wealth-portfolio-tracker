import { useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { format } from "../lib/format";
import type { PortfolioModel } from "../lib/portfolioModel";
import {
  applyWhatIf,
  breakdown,
  compare,
  liteRows,
  loanCover,
  netCurrency,
  nonSgdPct,
  rebalance,
  type Hypo,
  type Scope,
} from "../lib/riskModel";
import { toast } from "../lib/toast";
import type { Settings } from "../../shared/schema";

interface Props {
  model: PortfolioModel;
  settings: Settings;
  onSaved: () => void;
}

const MOVES = [-10, -5, 5, 10];
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
const signedPp = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)} pp`;
const num = (s: string): number | null => {
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function RiskPanel({ model, settings, onSaved }: Props) {
  const [scope, setScope] = useState<Scope>("investments");
  const [targets, setTargets] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(settings.targets).map(([k, v]) => [k, String(v)])),
  );
  const [maxNonSgd, setMaxNonSgd] = useState(settings.maxNonSgdPct == null ? "" : String(settings.maxNonSgdPct));
  const [maxPos, setMaxPos] = useState(settings.maxPositionPct == null ? "" : String(settings.maxPositionPct));
  const [newMoney, setNewMoney] = useState("0");
  const [extraClass, setExtraClass] = useState("");
  const [items, setItems] = useState<Hypo[]>([]);
  const nextId = useRef(1);
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => liteRows(model, scope), [model, scope]);
  const investRows = useMemo(() => liteRows(model, "investments"), [model]);
  const currencies = useMemo(() => breakdown(rows, "currency"), [rows]);
  const nonSgd = nonSgdPct(rows);
  const net = useMemo(() => netCurrency(model), [model]);
  const cover = useMemo(() => loanCover(model, 30), [model]);

  const parsedTargets = useMemo(() => {
    const t: Record<string, number> = {};
    for (const [k, v] of Object.entries(targets)) {
      const n = num(v);
      if (n != null) t[k] = n;
    }
    return t;
  }, [targets]);
  const plan = useMemo(
    () => rebalance(investRows, parsedTargets, num(newMoney) ?? 0),
    [investRows, parsedTargets, newMoney],
  );

  const after = useMemo(() => applyWhatIf(rows, items), [rows, items]);
  const cmpCurrency = useMemo(() => compare(rows, after, "currency"), [rows, after]);
  const cmpClass = useMemo(() => compare(rows, after, "assetClass"), [rows, after]);

  const classOptions = useMemo(
    () => [...new Set([...breakdown(investRows, "assetClass").map((c) => c.label), "Gold", "Equities", "Fixed Income", "Cash"])],
    [investRows],
  );
  const currencyOptions = useMemo(
    () => [...new Set(["SGD", "USD", "HKD", "CHF", ...breakdown(rows, "currency").map((c) => c.label)])],
    [rows],
  );

  const top5 = model.top.slice(0, 5);
  const top5Pct = model.investedTotal ? (top5.reduce((n, t) => n + t.value, 0) / model.investedTotal) * 100 : 0;
  const posLimit = settings.maxPositionPct;
  const overPos = posLimit == null ? [] : model.top.filter((t) => (t.value / model.investedTotal) * 100 > posLimit);

  const save = async () => {
    const t: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsedTargets)) if (v > 0) t[k] = v;
    const cur = num(maxNonSgd);
    const pos = num(maxPos);
    setSaving(true);
    try {
      await api.saveSettings({
        targets: t,
        maxNonSgdPct: cur == null ? null : cur,
        maxPositionPct: pos == null ? null : pos,
      });
      toast.ok("Saved your targets and limits.");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const addItem = (preset?: Partial<Hypo>) =>
    setItems((prev) => [
      ...prev,
      {
        id: nextId.current++,
        label: "Hypothetical position",
        assetClass: "Equities",
        exposure: "SGD",
        amount: 0,
        funding: "cash",
        fundingCurrency: "USD",
        ...preset,
      },
    ]);
  const patchItem = (id: number, change: Partial<Hypo>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...change } : it)));

  const tableClasses = [...new Set([...plan.lines.map((l) => l.label), ...Object.keys(targets)])];

  return (
    <div>
      <p className="notice">
        This is descriptive analysis using your own data and the limits and targets you set. It does not recommend
        buying or selling anything. It is not investment advice, and it can't see your risk tolerance, tax or
        plans. Talk to a licensed adviser before acting.
      </p>

      <div className="row" style={{ marginBottom: "1rem" }}>
        <label className="field" style={{ minWidth: 260 }}>
          <span>Currency and what-if analysis covers</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="investments">Investments and retirement holdings</option>
            <option value="all">All assets (adds deposits)</option>
          </select>
        </label>
      </div>

      {/* A. Currency exposure */}
      <section className="card">
        <h3>Currency exposure</h3>
        <p className="muted">
          Not in SGD: <strong>{pct(nonSgd)}</strong>
          {settings.maxNonSgdPct != null && (
            <>
              {" "}
              · your limit {pct(settings.maxNonSgdPct, 0)}:{" "}
              <strong className={nonSgd > settings.maxNonSgdPct ? "loss" : "gain"}>
                {nonSgd > settings.maxNonSgdPct ? "above" : "within"}
              </strong>
            </>
          )}
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">Value (SGD)</th>
                <th className="num">Share</th>
                <th style={{ width: "40%" }} />
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td className="num">{format.money(c.value)}</td>
                  <td className="num">{pct(c.pct)}</td>
                  <td>
                    <div className="bar">
                      <span style={{ width: `${Math.max(0, Math.min(100, c.pct))}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: "0.5rem" }}>
          Currency here is what each line is quoted in. An SGD-hedged fund shows as SGD, and an SGD-listed ETF that
          tracks a USD price (such as a gold ETF) also shows as SGD, so your real exposure to USD can be higher than
          this table shows.
        </p>
      </section>

      {/* B. Net exposure and FX sensitivity */}
      <section className="card">
        <h3>Net currency exposure and what a move would do</h3>
        <p className="muted">
          All assets less all debts, by currency. Each move column is the change in your net worth (SGD) if that
          currency rises or falls against SGD by that much. A negative net, such as a debt in CHF, gains when that
          currency falls.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">Assets</th>
                <th className="num">Debts</th>
                <th className="num">Net</th>
                {MOVES.map((m) => (
                  <th key={m} className="num">{m > 0 ? "+" : ""}{m}%</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {net
                .filter((n) => n.currency !== "SGD")
                .map((n) => (
                  <tr key={n.currency}>
                    <td>{n.currency}</td>
                    <td className="num">{format.money(n.assets)}</td>
                    <td className="num">{format.money(-n.debts)}</td>
                    <td className="num">{format.money(n.net)}</td>
                    {MOVES.map((m) => {
                      const v = (n.net * m) / 100;
                      return (
                        <td key={m} className={`num ${v < 0 ? "loss" : "gain"}`}>
                          {format.money(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* C. Concentration */}
      <section className="card">
        <h3>Concentration</h3>
        <p className="muted">
          Top 5 holdings are <strong>{pct(top5Pct)}</strong> of invested assets (cash and net-short lines left out).
          {posLimit != null && (
            <>
              {" "}
              Your single-holding limit is {pct(posLimit, 0)}:{" "}
              {overPos.length === 0 ? (
                <strong className="gain">none above it</strong>
              ) : (
                <strong className="loss">{overPos.map((t) => `${t.name} ${pct((t.value / model.investedTotal) * 100)}`).join(", ")}</strong>
              )}
              .
            </>
          )}
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Holding</th>
                <th>Held at</th>
                <th className="num">Value (SGD)</th>
                <th className="num">Share of invested</th>
              </tr>
            </thead>
            <tbody>
              {top5.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.where.join(", ")}</td>
                  <td className="num">{format.money(t.value)}</td>
                  <td className="num">{format.share(t.value, model.investedTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* D. Loans due soon against cash */}
      <section className="card">
        <h3>Cash against loans due soon</h3>
        {cover.due.length === 0 ? (
          <p className="muted">No loan has a due or maturity date in the next 30 days.</p>
        ) : (
          <p>
            Due within 30 days: <strong>SGD {format.money(cover.dueTotal)}</strong> ({cover.due.map((d) => d.name).join(", ")}).
            Cash you hold (deposits plus cash inside portfolios): <strong>SGD {format.money(cover.cash)}</strong>
            {cover.ratio != null && (
              <>
                , which is <strong>{cover.ratio.toFixed(1)}x</strong> the amount due.
              </>
            )}
          </p>
        )}
        <p className="muted small">
          Cash held in a foreign currency is counted at today's SGD value. Whether a loan renews or must be repaid is
          for you to confirm with the lender.
        </p>
      </section>

      {/* E. Targets and rebalance */}
      <section className="card">
        <h3>Your targets and the gap</h3>
        <p className="muted">
          Set the share of your invested assets you want in each class. The table shows the gap and the amount that
          would close it. The targets are yours, not a suggestion.
        </p>
        <div className="form">
          <label className="field">
            <span>Alert if non-SGD share is above (%)</span>
            <input value={maxNonSgd} onChange={(e) => setMaxNonSgd(e.target.value)} placeholder="e.g. 40" inputMode="decimal" />
          </label>
          <label className="field">
            <span>Alert if one holding is above (%)</span>
            <input value={maxPos} onChange={(e) => setMaxPos(e.target.value)} placeholder="e.g. 10" inputMode="decimal" />
          </label>
          <label className="field">
            <span>New money to add (SGD)</span>
            <input value={newMoney} onChange={(e) => setNewMoney(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Class</th>
                <th className="num">Now (SGD)</th>
                <th className="num">Now %</th>
                <th className="num">Your target %</th>
                <th className="num">Gap</th>
                <th className="num">Amount to reach target (SGD)</th>
              </tr>
            </thead>
            <tbody>
              {tableClasses.map((label) => {
                const l = plan.lines.find((x) => x.label === label) ?? {
                  label,
                  value: 0,
                  pct: 0,
                  target: null,
                  targetAmount: null,
                  move: null,
                };
                const gap = l.target == null ? null : l.pct - l.target;
                return (
                  <tr key={label}>
                    <td>{label}</td>
                    <td className="num">{format.money(l.value)}</td>
                    <td className="num">{pct(l.pct)}</td>
                    <td className="num">
                      <input
                        style={{ width: 80, textAlign: "right" }}
                        value={targets[label] ?? ""}
                        onChange={(e) => setTargets((t) => ({ ...t, [label]: e.target.value }))}
                        aria-label={`Target percent for ${label}`}
                        inputMode="decimal"
                      />
                    </td>
                    <td className="num">{gap == null ? "–" : signedPp(gap)}</td>
                    <td className={`num ${l.move == null ? "" : l.move < 0 ? "loss" : "gain"}`}>
                      {l.move == null ? "–" : `${l.move > 0 ? "+" : ""}${format.money(l.move)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ marginTop: "0.5rem" }}>
          Targets add up to <strong className={Math.abs(plan.targetSum - 100) < 0.05 ? "gain" : "loss"}>{pct(plan.targetSum)}</strong>
          {Math.abs(plan.targetSum - 100) >= 0.05 && plan.targetSum > 0 ? " (they should total 100%)" : ""}. A plus is an
          amount that would move you up to the target, a minus down to it. Selling can trigger tax and costs that this
          table ignores. Total invested now: SGD {format.money(plan.total)}.
        </p>
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <input
            style={{ width: 200 }}
            value={extraClass}
            onChange={(e) => setExtraClass(e.target.value)}
            placeholder="Add a class, e.g. Bonds"
            aria-label="Add a class"
          />
          <button
            className="btn small ghost"
            onClick={() => {
              const c = extraClass.trim();
              if (c) setTargets((t) => (c in t ? t : { ...t, [c]: "" }));
              setExtraClass("");
            }}
          >
            Add
          </button>
          <button className="btn primary small" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save targets and limits"}
          </button>
        </div>
      </section>

      {/* F. What-if */}
      <section className="card">
        <h3>What if I added a position?</h3>
        <p className="muted">
          Try a hypothetical position and see how the currency and class shares would change. Nothing is saved or
          traded. For a position that tracks a foreign price, set "Really moves with" to that currency. For example, an
          SGD-listed gold ETF that tracks the USD gold price moves with USD.
        </p>
        <div className="actions" style={{ marginTop: 0, marginBottom: "0.75rem" }}>
          <button
            className="btn small"
            onClick={() =>
              addItem({
                label: "SGD-listed gold ETF (the GLS idea in your notes)",
                assetClass: "Gold",
                exposure: "USD",
                amount: 50000,
                funding: "cash",
                fundingCurrency: "USD",
              })
            }
          >
            Add gold ETF example
          </button>
          <button className="btn small ghost" onClick={() => addItem()}>
            Add blank position
          </button>
          {items.length > 0 && (
            <button className="btn small ghost" onClick={() => setItems([])}>
              Clear
            </button>
          )}
        </div>

        {items.map((it) => (
          <div key={it.id} className="table-card">
            <div className="form" style={{ margin: 0 }}>
              <label className="field">
                <span>Label</span>
                <input value={it.label} onChange={(e) => patchItem(it.id, { label: e.target.value })} maxLength={80} />
              </label>
              <label className="field">
                <span>Class</span>
                <input list="risk-classes" value={it.assetClass} onChange={(e) => patchItem(it.id, { assetClass: e.target.value })} />
              </label>
              <label className="field">
                <span>Amount (SGD)</span>
                <input
                  value={it.amount === 0 ? "" : String(it.amount)}
                  onChange={(e) => patchItem(it.id, { amount: num(e.target.value) ?? 0 })}
                  inputMode="decimal"
                  placeholder="e.g. 50000"
                />
              </label>
              <label className="field">
                <span>Really moves with</span>
                <select value={it.exposure} onChange={(e) => patchItem(it.id, { exposure: e.target.value })}>
                  {currencyOptions.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Paid from</span>
                <select value={it.funding} onChange={(e) => patchItem(it.id, { funding: e.target.value as Hypo["funding"] })}>
                  <option value="cash">Cash I already hold</option>
                  <option value="new">New money</option>
                </select>
              </label>
              {it.funding === "cash" && (
                <label className="field">
                  <span>Cash currency</span>
                  <select value={it.fundingCurrency} onChange={(e) => patchItem(it.id, { fundingCurrency: e.target.value })}>
                    {currencyOptions.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="field">
                <span>&nbsp;</span>
                <button className="btn small ghost" onClick={() => setItems((p) => p.filter((x) => x.id !== it.id))}>
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}
        <datalist id="risk-classes">
          {classOptions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        {items.some((i) => i.amount > 0) && (
          <div className="grid" style={{ marginTop: "1rem" }}>
            {[
              { title: "By currency", rows: cmpCurrency },
              { title: "By class", rows: cmpClass },
            ].map((t) => (
              <div key={t.title} className="scroll">
                <h3 style={{ fontSize: "0.95rem", marginBottom: "0.5rem" }}>{t.title}: before and after</h3>
                <table>
                  <thead>
                    <tr>
                      <th>{t.title.replace("By ", "")}</th>
                      <th className="num">Before</th>
                      <th className="num">After</th>
                      <th className="num">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        <td className="num">{pct(r.beforePct)}</td>
                        <td className="num">{pct(r.afterPct)}</td>
                        <td className={`num ${Math.abs(r.change) < 0.05 ? "" : r.change < 0 ? "loss" : "gain"}`}>{signedPp(r.change)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { AllocationDonut } from "./components/AllocationDonut";
import { DataManagePanel } from "./components/DataManagePanel";
import { ImportPanel } from "./components/ImportPanel";
import { LoansPanel } from "./components/LoansPanel";
import { LoginPage } from "./components/LoginPage";
import { PdfImportPanel } from "./components/PdfImportPanel";
import { RiskPanel } from "./components/RiskPanel";
import { SavingsPanel } from "./components/SavingsPanel";
import { ApiError, api, type SessionInfo } from "./lib/api";
import { format } from "./lib/format";
import { buildPortfolioModel } from "./lib/portfolioModel";
import { useOverview } from "./lib/useOverview";

type Tab = "overview" | "savings" | "loans" | "investments" | "risk" | "import";
type SortKey = "broker" | "name" | "assetClass" | "currency" | "sgd" | "plPct";

const SOON_DAYS = 14;

function SetupNotice() {
  return (
    <div className="login">
      <div className="login-card">
        <h1>Almost ready</h1>
        <p className="muted" style={{ margin: "0.5rem 0 1rem" }}>
          No database is connected to this project yet. In Vercel, open this project, go to Storage, create or connect a
          Postgres database (Supabase or Neon), then redeploy. The tables are created automatically on the first visit.
        </p>
      </div>
    </div>
  );
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const { data, error, loading, refresh } = useOverview();
  const model = useMemo(() => (data ? buildPortfolioModel(data) : null), [data]);
  const [tab, setTab] = useState<Tab | null>(null);

  const [broker, setBroker] = useState("__all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sgd", dir: -1 });

  // Start on Import when there is nothing yet.
  useEffect(() => {
    if (data && tab === null) setTab(data.positions.length === 0 ? "import" : "overview");
  }, [data, tab]);

  const rows = useMemo(() => {
    if (!model) return [];
    const r = model.holdings.filter(
      (p) =>
        (broker === "__all" || p.broker === broker) &&
        (p.name + " " + p.symbol).toLowerCase().includes(q.toLowerCase()),
    );
    return [...r].sort((a, b) => {
      const x = a[sort.key],
        y = b[sort.key];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir;
    });
  }, [model, broker, q, sort]);

  const sortBy = (key: SortKey) =>
    setSort((s) => ({
      key,
      dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" || key === "broker" ? 1 : -1,
    }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  const header = (
    <header className="header">
      <h1 className="brand">Wealth Portfolio Tracker</h1>
      {model?.asOf.latest && <span className="asof">Latest data {format.date(model.asOf.latest)} · SGD</span>}
      <div className="header-right">
        <button className="btn small" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );

  if (loading && !data) {
    return (
      <>
        {header}
        <main className="main">
          <p className="muted">Loading…</p>
        </main>
      </>
    );
  }
  if (error || !data || !model) {
    return (
      <>
        {header}
        <main className="main">
          <section className="card state">
            <h2>Could not load your portfolio</h2>
            <p>{error?.message ?? "Something went wrong."}</p>
            <button className="btn" onClick={() => void refresh()}>
              Try again
            </button>
          </section>
        </main>
      </>
    );
  }

  const empty = data.positions.length === 0;
  const { totals, groups, top, concentration, missingFx, loanRows, asOf } = model;
  const dueSoon = loanRows.filter((l) => l.maturityDate && format.daysUntil(l.maturityDate) <= SOON_DAYS);
  const active: Tab = tab ?? "overview";

  const emptyNote = (
    <section className="card state">
      <h2>Nothing here yet</h2>
      <p>Add your first data on the Import tab.</p>
    </section>
  );

  const overview = (
    <>
      <div className="kpis">
        <div className="kpi strong">
          <span className="kpi-label">Net worth</span>
          <span className="kpi-value">{format.money(totals.net)}</span>
          <span className="kpi-sub">assets less debts, SGD</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Total assets</span>
          <span className="kpi-value">{format.money(totals.assets)}</span>
          <span className="kpi-sub">SGD</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Debts</span>
          <span className="kpi-value">{format.money(-totals.owed)}</span>
          <span className="kpi-sub">{format.pct(totals.owedToAssets)} of assets</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Investments</span>
          <span className="kpi-value">{format.money(totals.investments)}</span>
          <span className="kpi-sub">SGD</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Savings</span>
          <span className="kpi-value">{format.money(totals.savings)}</span>
          <span className="kpi-sub">deposits, SGD</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Retirement</span>
          <span className="kpi-value">{format.money(totals.retirement)}</span>
          <span className="kpi-sub">SRS / CPFIS, SGD</span>
        </div>
      </div>

      <p className="muted" style={{ marginBottom: "1rem" }}>
        Data dates: investments {format.date(asOf.investments)} · savings {format.date(asOf.savings)} · retirement{" "}
        {format.date(asOf.retirement)} · loans {format.date(asOf.loans)}
      </p>

      {(dueSoon.length > 0 || concentration.length > 0 || missingFx.length > 0) && (
        <section className="flags">
          <h3>Check these</h3>
          <ul>
            {dueSoon.map((l) => {
              const days = format.daysUntil(l.maturityDate!);
              return (
                <li key={l.key}>
                  {l.name} is due {days <= 0 ? "now" : `in ${days} day(s)`} ({format.date(l.maturityDate)}).
                </li>
              );
            })}
            {missingFx.length > 0 && (
              <li>
                No exchange rate for {missingFx.join(", ")}: those lines are left out of the totals. Add rates on the
                Import tab.
              </li>
            )}
            {concentration.map((p) => (
              <li key={p.name}>
                {p.name} is {format.share(p.value, model.investedTotal)} of your invested assets (over 20%).
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid">
        <AllocationDonut title="Assets by type" slices={groups.byType} />
        <AllocationDonut title="Assets by class" slices={groups.byClass} />
        <AllocationDonut title="Assets by currency" slices={groups.byCurrency} />
        <AllocationDonut title="Assets by bank / broker" slices={groups.byBroker} />
      </div>

      <section className="card">
        <h3>Top holdings</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Holding</th>
                <th>Held at</th>
                <th className="num">Value (SGD)</th>
                <th className="num">% of invested</th>
              </tr>
            </thead>
            <tbody>
              {top.slice(0, 10).map((p, i) => (
                <tr key={p.name}>
                  <td>{i + 1}</td>
                  <td>{p.name}</td>
                  <td>{p.where.join(", ")}</td>
                  <td className="num">{format.money(p.value)}</td>
                  <td className="num">{format.share(p.value, model.investedTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );

  const investments = (
    <section className="card">
      <div className="filters">
        <select value={broker} onChange={(e) => setBroker(e.target.value)} aria-label="Broker">
          <option value="__all">All brokers</option>
          {[...new Set(model.holdings.map((l) => l.broker))].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Search name or symbol"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search investments"
        />
        <span className="muted">
          {rows.length} of {model.holdings.length} lines
        </span>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th><button className="sort" onClick={() => sortBy("broker")}>Broker{arrow("broker")}</button></th>
              <th><button className="sort" onClick={() => sortBy("name")}>Holding{arrow("name")}</button></th>
              <th><button className="sort" onClick={() => sortBy("assetClass")}>Class{arrow("assetClass")}</button></th>
              <th><button className="sort" onClick={() => sortBy("currency")}>Ccy{arrow("currency")}</button></th>
              <th className="num"><button className="sort" onClick={() => sortBy("sgd")}>Value (SGD){arrow("sgd")}</button></th>
              <th className="num">% of investments</th>
              <th className="num"><button className="sort" onClick={() => sortBy("plPct")}>P/L %{arrow("plPct")}</button></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={`${p.broker}|${p.accountLabel}|${p.symbol || p.name}|${i}`}>
                <td>{p.broker}</td>
                <td>
                  {p.name} {p.symbol && <span className="mono">{p.symbol}</span>}
                </td>
                <td>{p.assetClass}</td>
                <td>{p.currency}</td>
                <td className="num">{p.sgd == null ? "no FX" : format.money(p.sgd)}</td>
                <td className="num">{p.sgd == null ? "–" : format.share(p.sgd, totals.investments)}</td>
                <td className={`num ${p.plPct == null ? "" : p.plPct < 0 ? "loss" : "gain"}`}>
                  {format.signedPct(p.plPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  const TABS: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "savings", label: "Savings" },
    { id: "loans", label: "Loans" },
    { id: "investments", label: "Investments" },
    { id: "risk", label: "Risk & rebalance" },
    { id: "import", label: "Import" },
  ];

  return (
    <>
      {header}
      <main className="main">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              className="tab"
              role="tab"
              aria-selected={active === t.id}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {active === "overview" && (empty ? emptyNote : overview)}
        {active === "savings" && <SavingsPanel model={model} />}
        {active === "loans" && <LoansPanel model={model} />}
        {active === "investments" && (empty ? emptyNote : investments)}
        {active === "risk" &&
          (empty ? (
            emptyNote
          ) : (
            <RiskPanel model={model} settings={data.settings} onSaved={() => void refresh()} />
          ))}
        {active === "import" && (
          <>
            <PdfImportPanel onChanged={() => void refresh()} />
            <ImportPanel onChanged={() => void refresh()} />
            <DataManagePanel
              snapshots={data.snapshots}
              fx={data.fx}
              currencies={model.currencies}
              onChanged={() => void refresh()}
            />
          </>
        )}
      </main>
    </>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = () => {
    api
      .session()
      .then((s) => {
        setSession(s);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e : new ApiError("Could not reach the server", 0)));
  };
  useEffect(load, []);

  if (error?.code === "DATABASE_NOT_CONFIGURED") return <SetupNotice />;
  if (error) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>Something went wrong</h1>
          <p className="muted" style={{ margin: "0.5rem 0 1rem" }}>
            {error.message}
          </p>
          <button className="btn" onClick={load}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!session) return <p className="muted" style={{ padding: "2rem" }}>Loading…</p>;
  if (!session.user) return <LoginPage canRegister={session.canRegister} onDone={load} />;

  return (
    <Dashboard
      onSignOut={async () => {
        await api.logout().catch(() => undefined);
        setSession({ user: null, canRegister: false });
      }}
    />
  );
}

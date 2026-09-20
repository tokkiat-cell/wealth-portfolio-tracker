import { useEffect, useState } from "react";
import { ReviewImport } from "./ReviewImport";
import { api } from "../lib/api";
import type { ExtractedStatement } from "../../shared/schema";

interface Props {
  onChanged: () => void;
}

export function IbkrPanel({ onChanged }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState<ExtractedStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    api
      .ibkrStatus()
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(null));
  }, []);

  const fetchNow = async () => {
    setError(null);
    setResult(null);
    setFetching(true);
    try {
      setResult(await api.ibkrFetch());
      setRun((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fetch from IBKR");
    } finally {
      setFetching(false);
    }
  };

  return (
    <section className="card">
      <h3>Fetch from Interactive Brokers</h3>
      <p className="muted">
        Pulls your latest IBKR positions and cash through a read-only Flex Query. You review them before anything is
        saved, and importing again on the same date replaces that day's snapshot.
      </p>
      <p className="notice" style={{ marginTop: "0.5rem" }}>
        Privacy: the report goes from IBKR to this app's server and your browser. It is not sent to any AI. The Flex
        token can only read reports, it cannot trade or move money, and it is kept in Vercel, not in this app.
      </p>

      {configured === false && (
        <p className="notice error">IBKR is not set up yet. Follow the steps below, then redeploy.</p>
      )}

      <div className="actions">
        <button className="btn primary" onClick={fetchNow} disabled={fetching || configured === false}>
          {fetching ? "Fetching…" : "Fetch latest from IBKR"}
        </button>
        {fetching && <span className="muted">IBKR prepares the report first. This can take up to a minute.</span>}
      </div>
      {error && <p className="notice error">{error}</p>}

      {result && (
        <ReviewImport
          key={run}
          result={result}
          initialBroker="IBKR"
          source="IBKR Flex Query"
          from="from IBKR"
          flaggedBy="The fetch flagged"
          footnote="Options are netted per underlying, with short legs negative. Check the totals against your IBKR statement before importing."
          onImported={() => {
            setResult(null);
            onChanged();
          }}
          onDiscard={() => setResult(null)}
        />
      )}

      <details open={configured === false}>
        <summary>How to set it up (once)</summary>
        <ol>
          <li>
            In IBKR Client Portal open Performance &amp; Reports, then Flex Queries, and create an <strong>Activity Flex
            Query</strong>. Menu names can differ slightly.
          </li>
          <li>
            Add these sections. <strong>Open Positions</strong> (summary level) with: Currency, FX Rate to Base, Asset
            Class, Sub Category, Symbol, Description, ISIN, Multiplier, Underlying Symbol, Report Date, Quantity, Mark
            Price, Position Value, Cost Basis Price, Cost Basis Money, FIFO Unrealized P/L. <strong>Cash Report</strong>{" "}
            with: Currency, FX Rate to Base, Ending Cash. <strong>Account Information</strong> with: Account ID, Currency.
          </li>
          <li>
            Set the format to <strong>XML</strong> and the period to <strong>Last Business Day</strong>. Save it and note
            the Query ID.
          </li>
          <li>
            In Client Portal, under Flex Web Service, enable it and create a <strong>token</strong>. Leave the IP
            restriction off, because Vercel's addresses change. Choose an expiry, up to one year.
          </li>
          <li>
            In Vercel, open this project, then Settings, then Environment Variables. Add <code>IBKR_FLEX_TOKEN</code> and{" "}
            <code>IBKR_FLEX_QUERY_ID</code>, then redeploy.
          </li>
        </ol>
        <p className="muted">
          IBKR limits each token to about one request a second and ten a minute. If the token expires, create a new one
          and update Vercel.
        </p>
      </details>
    </section>
  );
}

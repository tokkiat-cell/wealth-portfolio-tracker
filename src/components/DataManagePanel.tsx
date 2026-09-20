import { useMemo, useState } from "react";
import { z } from "zod";
import { api } from "../lib/api";
import { format } from "../lib/format";
import { toast } from "../lib/toast";
import { importSchema, type BackupFile, type SnapshotRow } from "../../shared/schema";

interface Props {
  snapshots: SnapshotRow[];
  fx: Record<string, number>;
  currencies: string[]; // currencies present in the loaded data
  onChanged: () => void;
}

const backupSchema = z.object({
  app: z.literal("wealth-portfolio-tracker"),
  version: z.literal(1),
  snapshots: z.array(importSchema),
  fx: z.record(z.number().positive()).default({}),
});

export function DataManagePanel({ snapshots, fx, currencies, onChanged }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);

  const list = useMemo(
    () => [...new Set([...currencies, ...Object.keys(fx), ...Object.keys(drafts)])].filter((c) => c !== "SGD").sort(),
    [currencies, fx, drafts],
  );

  const save = async (currency: string) => {
    const rate = Number(drafts[currency] ?? fx[currency] ?? "");
    try {
      await api.saveFx(currency, rate);
      setDrafts((d) => {
        const { [currency]: _gone, ...rest } = d;
        return rest;
      });
      toast.ok(`Saved ${currency} rate.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the rate");
    }
  };

  const addCurrency = () => {
    const c = extra.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c) || c === "SGD") return toast.error("Use a 3-letter code such as USD.");
    setDrafts((d) => ({ ...d, [c]: d[c] ?? "" }));
    setExtra("");
  };

  const remove = async (s: SnapshotRow) => {
    if (
      !window.confirm(
        `Delete ${s.broker}${s.accountLabel ? " " + s.accountLabel : ""} (${s.kind}) as of ${format.date(s.asOf)}? Its ${s.lines} lines will be removed.`,
      )
    )
      return;
    try {
      await api.deleteSnapshot(s.id);
      toast.ok("Snapshot deleted.");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const download = async () => {
    setBusy(true);
    try {
      const backup = await api.backup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `wealth-portfolio-backup-${format.today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the backup");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const parsed = backupSchema.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new Error(`Not a valid backup: ${first?.path.join(".") || "file"} ${first?.message ?? ""}`);
      }
      const data = parsed.data as BackupFile;
      let lines = 0;
      for (const s of data.snapshots) {
        lines += (await api.importSnapshot(s)).inserted;
      }
      for (const [currency, rate] of Object.entries(data.fx)) {
        if (currency !== "SGD") await api.saveFx(currency, rate);
      }
      toast.ok(`Restored ${data.snapshots.length} snapshots (${lines} lines).`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not restore the backup");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <section className="card">
        <h3>Exchange rates</h3>
        <p className="muted">
          SGD per 1 unit. Used for lines that have no SGD value. Enter market rates yourself; nothing is fetched
          automatically.
        </p>
        {list.length === 0 && <p className="muted">No foreign currencies yet.</p>}
        {list.map((c) => (
          <div key={c} className="row" style={{ marginBottom: "0.5rem" }}>
            <span style={{ minWidth: 70 }}>1 {c} =</span>
            <input
              style={{ width: 130 }}
              type="number"
              step="any"
              min="0"
              value={drafts[c] ?? (fx[c] == null ? "" : String(fx[c]))}
              onChange={(e) => setDrafts((d) => ({ ...d, [c]: e.target.value }))}
              aria-label={`${c} to SGD rate`}
            />
            <span className="muted">SGD</span>
            <button className="btn small" onClick={() => save(c)} disabled={!(Number(drafts[c] ?? fx[c]) > 0)}>
              Save
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <input
            style={{ width: 200 }}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="Add currency, e.g. CHF"
            maxLength={3}
            aria-label="Add currency"
          />
          <button className="btn small ghost" onClick={addCurrency}>
            Add
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Imported snapshots</h3>
        {snapshots.length === 0 ? (
          <p className="muted">Nothing imported yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Broker</th>
                  <th>Account</th>
                  <th>Type</th>
                  <th>As of</th>
                  <th className="num">Lines</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>{s.broker}</td>
                    <td>{s.accountLabel || "–"}</td>
                    <td>{{ holding: "Investments", savings: "Savings", retirement: "Retirement", loan: "Loans" }[s.kind]}</td>
                    <td>{format.date(s.asOf)}</td>
                    <td className="num">{s.lines}</td>
                    <td className="muted" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.source}
                    </td>
                    <td>
                      <button className="btn small ghost" onClick={() => remove(s)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Backup</h3>
        <p className="muted">
          Your data lives in your own database. A backup is a JSON file you can keep or restore later. It contains all
          your balances, so store it somewhere private.
        </p>
        <div className="actions">
          <button className="btn" onClick={download} disabled={busy}>
            Download backup (JSON)
          </button>
          <label className="btn">
            Restore from backup
            <input
              type="file"
              accept=".json,application/json"
              hidden
              disabled={busy}
              onChange={(e) => {
                void restore(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </section>
    </div>
  );
}

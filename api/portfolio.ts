import { z } from "zod";
import { DatabaseNotConfigured, ensureSchema, getDb } from "./_lib/db";
import { HttpError, Req, Res, assertSameOrigin, fail, readJson, send } from "./_lib/http";
import { requireUser } from "./_lib/session";
import { fxSchema, importSchema, settingsSchema } from "../shared/schema";
import type { BackupFile, Kind, Overview, PositionRow, SnapshotRow } from "../shared/schema";

const num = (v: string | null): number | null => (v == null ? null : Number(v));

type SnapshotDb = {
  id: number;
  broker: string;
  account_label: string;
  kind: Kind;
  as_of: string;
  source: string;
  imported_at: Date;
};

type PositionDb = {
  snapshot_id: number;
  name: string;
  symbol: string;
  isin: string;
  asset_class: string;
  currency: string;
  quantity: string | null;
  price: string | null;
  value_local: string | null;
  value_sgd: string | null;
  pl_pct: string | null;
  rate_pct: string | null;
  maturity_date: string | null;
  monthly_payment: string | null;
  note: string;
};

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import") }).merge(importSchema),
  z.object({ action: z.literal("deleteSnapshot"), id: z.number().int().positive() }),
  z.object({ action: z.literal("saveFx") }).merge(fxSchema),
  z.object({ action: z.literal("saveSettings") }).merge(settingsSchema),
]);

function toRow(p: PositionDb, s: SnapshotDb): PositionRow {
  return {
    name: p.name,
    symbol: p.symbol,
    isin: p.isin,
    assetClass: p.asset_class,
    currency: p.currency,
    quantity: num(p.quantity),
    price: num(p.price),
    valueLocal: num(p.value_local),
    valueSgd: num(p.value_sgd),
    plPct: num(p.pl_pct),
    ratePct: num(p.rate_pct),
    maturityDate: p.maturity_date,
    monthlyPayment: num(p.monthly_payment),
    note: p.note,
    broker: s.broker,
    accountLabel: s.account_label,
    kind: s.kind,
    asOf: s.as_of,
  };
}

export default async function handler(req: Req, res: Res) {
  try {
    await ensureSchema();
    const sql = getDb();
    const user = await requireUser(req);

    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://localhost");
      const wantAll = url.searchParams.get("all") === "1";

      const snaps = await sql<SnapshotDb[]>`
        SELECT id, broker, account_label, kind, as_of::text AS as_of, source, imported_at
        FROM wpt.snapshots WHERE user_id = ${user.id}`;

      // The figures use the latest snapshot per broker, account and type. A backup wants them all.
      const latest = new Map<string, SnapshotDb>();
      for (const s of snaps) {
        const key = `${s.broker}|${s.account_label}|${s.kind}`;
        const cur = latest.get(key);
        if (
          !cur ||
          s.as_of > cur.as_of ||
          (s.as_of === cur.as_of && new Date(s.imported_at) > new Date(cur.imported_at))
        ) {
          latest.set(key, s);
        }
      }
      const chosen = wantAll ? snaps : [...latest.values()];
      const ids = chosen.map((s) => s.id);

      const positions = ids.length
        ? await sql<PositionDb[]>`
            SELECT snapshot_id, name, symbol, isin, asset_class, currency, quantity, price,
                   value_local, value_sgd, pl_pct, rate_pct, maturity_date::text AS maturity_date,
                   monthly_payment, note
            FROM wpt.positions
            WHERE snapshot_id IN ${sql(ids)} ORDER BY id`
        : [];

      const fxRows = await sql<{ currency: string; rate_to_sgd: string }[]>`
        SELECT currency, rate_to_sgd FROM wpt.fx_rates WHERE user_id = ${user.id}`;
      const fx: Record<string, number> = {};
      for (const r of fxRows) fx[r.currency] = Number(r.rate_to_sgd);

      const byId = new Map(chosen.map((s) => [s.id, s]));

      if (wantAll) {
        const backup: BackupFile = {
          app: "wealth-portfolio-tracker",
          version: 1,
          snapshots: chosen.map((s) => ({
            broker: s.broker,
            accountLabel: s.account_label,
            kind: s.kind,
            asOf: s.as_of,
            source: s.source,
            positions: positions
              .filter((p) => p.snapshot_id === s.id)
              .map((p) => {
                const r = toRow(p, s);
                return {
                  name: r.name,
                  symbol: r.symbol,
                  isin: r.isin,
                  assetClass: r.assetClass,
                  currency: r.currency,
                  quantity: r.quantity,
                  price: r.price,
                  valueLocal: r.valueLocal,
                  valueSgd: r.valueSgd,
                  plPct: r.plPct,
                  ratePct: r.ratePct,
                  maturityDate: r.maturityDate,
                  monthlyPayment: r.monthlyPayment,
                  note: r.note,
                };
              }),
          })),
          fx,
        };
        return send(res, 200, backup);
      }

      // Line counts for every snapshot (also the ones not used in the figures).
      const counts = await sql<{ snapshot_id: number; n: number }[]>`
        SELECT p.snapshot_id, count(*)::int AS n FROM wpt.positions p
        JOIN wpt.snapshots s ON s.id = p.snapshot_id
        WHERE s.user_id = ${user.id} GROUP BY p.snapshot_id`;
      const lineCount = new Map(counts.map((c) => [c.snapshot_id, c.n]));

      const settingsRows = await sql<{ data: unknown }[]>`
        SELECT data FROM wpt.settings WHERE user_id = ${user.id}`;
      const settings = settingsSchema.safeParse(settingsRows[0]?.data ?? {});

      const overview: Overview = {
        settings: settings.success ? settings.data : settingsSchema.parse({}),
        positions: positions.map((p) => toRow(p, byId.get(p.snapshot_id)!)),
        snapshots: snaps
          .map(
            (s): SnapshotRow => ({
              id: s.id,
              broker: s.broker,
              accountLabel: s.account_label,
              kind: s.kind,
              asOf: s.as_of,
              source: s.source,
              lines: lineCount.get(s.id) ?? 0,
            }),
          )
          .sort((a, b) => (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : b.id - a.id)),
        fx,
      };
      return send(res, 200, overview);
    }

    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    assertSameOrigin(req);

    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(res, 400, `${first?.path.join(".") || "input"}: ${first?.message ?? "invalid"}`);
    }
    const body = parsed.data;

    if (body.action === "deleteSnapshot") {
      const deleted = await sql`DELETE FROM wpt.snapshots WHERE id = ${body.id} AND user_id = ${user.id}`;
      return send(res, 200, { deleted: deleted.count });
    }

    if (body.action === "saveFx") {
      await sql`
        INSERT INTO wpt.fx_rates (user_id, currency, rate_to_sgd)
        VALUES (${user.id}, ${body.currency}, ${body.rate})
        ON CONFLICT (user_id, currency) DO UPDATE SET rate_to_sgd = EXCLUDED.rate_to_sgd`;
      return send(res, 200, { currency: body.currency, rate: body.rate });
    }

    if (body.action === "saveSettings") {
      const data = { targets: body.targets, maxNonSgdPct: body.maxNonSgdPct, maxPositionPct: body.maxPositionPct };
      await sql`
        INSERT INTO wpt.settings (user_id, data)
        VALUES (${user.id}, ${sql.json(data as unknown as Parameters<typeof sql.json>[0])})
        ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
      return send(res, 200, data);
    }

    // import: re-importing the same broker + account + type + date replaces that snapshot.
    const result = await sql.begin(async (tx) => {
      await tx`
        DELETE FROM wpt.snapshots
        WHERE user_id = ${user.id} AND broker = ${body.broker} AND account_label = ${body.accountLabel}
          AND kind = ${body.kind} AND as_of = ${body.asOf}::date`;
      const [snap] = await tx<{ id: number }[]>`
        INSERT INTO wpt.snapshots (user_id, broker, account_label, kind, as_of, source)
        VALUES (${user.id}, ${body.broker}, ${body.accountLabel}, ${body.kind}, ${body.asOf}::date, ${body.source})
        RETURNING id`;
      const rows = body.positions.map((p) => ({
        snapshot_id: snap.id,
        name: p.name,
        symbol: p.symbol,
        isin: p.isin,
        asset_class: p.assetClass,
        currency: p.currency.toUpperCase(),
        quantity: p.quantity,
        price: p.price,
        value_local: p.valueLocal,
        value_sgd: p.valueSgd,
        pl_pct: p.plPct,
        rate_pct: p.ratePct,
        maturity_date: p.maturityDate,
        monthly_payment: p.monthlyPayment,
        note: p.note,
      }));
      for (let i = 0; i < rows.length; i += 300) {
        await tx`INSERT INTO wpt.positions ${tx(rows.slice(i, i + 300))}`;
      }
      return { snapshotId: snap.id, inserted: rows.length };
    });
    return send(res, 200, result);
  } catch (error) {
    if (error instanceof DatabaseNotConfigured) {
      return fail(res, 503, error.message, "DATABASE_NOT_CONFIGURED");
    }
    if (error instanceof HttpError) return fail(res, error.status, error.message, error.code);
    console.error("portfolio error:", error);
    return fail(res, 500, "Something went wrong.");
  }
}

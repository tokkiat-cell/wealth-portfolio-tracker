import postgres from "postgres";
import { randomBytes } from "crypto";
import { HttpError } from "./http";

// Tables live in their own schema ("wpt") and have row level security switched on.
// On Supabase this keeps them out of the public API even if a key ever leaks.

let client: ReturnType<typeof postgres> | null = null;

export class DatabaseNotConfigured extends Error {
  constructor() {
    super("No database is connected to this project yet.");
    this.name = "DatabaseNotConfigured";
  }
}

let lastUsed = 0;
const IDLE_RECYCLE_MS = 12_000;

function dropClient() {
  const old = client;
  client = null;
  if (old) void old.end({ timeout: 0 }).catch(() => undefined);
}

// Runs database work with a time limit. A connection that died while the server instance was frozen
// can hang forever, so on a timeout the connection is dropped and the next request opens a new one.
export async function guardDb<T>(work: () => Promise<T>, ms = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          dropClient();
          reject(new HttpError(503, "The database was slow to answer. Try again in a moment.", "DATABASE_SLOW"));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getDb() {
  // A connection left idle while the instance was frozen is often dead, so use a fresh one.
  const now = Date.now();
  if (client && now - lastUsed > IDLE_RECYCLE_MS) dropClient();
  lastUsed = now;
  if (client) return client;
  const raw = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!raw) throw new DatabaseNotConfigured();
  // The Supabase integration adds parameters that a plain Postgres client rejects.
  const url = new URL(raw);
  url.searchParams.delete("supa");
  url.searchParams.delete("sslmode");
  client = postgres(url.toString(), {
    ssl: "require",
    prepare: false, // works with pooled connections
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  return client;
}

const DDL = `
CREATE SCHEMA IF NOT EXISTS wpt;

CREATE TABLE IF NOT EXISTS wpt.app_secret (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS wpt.users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpt.login_attempts (
  id serial PRIMARY KEY,
  email text NOT NULL,
  success boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wpt.snapshots (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES wpt.users(id) ON DELETE CASCADE,
  broker text NOT NULL,
  account_label text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('holding', 'savings', 'retirement', 'loan', 'property', 'cpf')),
  as_of date NOT NULL,
  source text NOT NULL DEFAULT '',
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, broker, account_label, kind, as_of)
);

CREATE TABLE IF NOT EXISTS wpt.positions (
  id serial PRIMARY KEY,
  snapshot_id integer NOT NULL REFERENCES wpt.snapshots(id) ON DELETE CASCADE,
  name text NOT NULL,
  symbol text NOT NULL DEFAULT '',
  isin text NOT NULL DEFAULT '',
  asset_class text NOT NULL,
  currency text NOT NULL,
  quantity numeric(24,6),
  price numeric(24,6),
  value_local numeric(24,4),
  value_sgd numeric(24,4),
  pl_pct numeric(12,6),
  rate_pct numeric(8,4),
  maturity_date date,
  monthly_payment numeric(24,4),
  note text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS wpt.fx_rates (
  user_id integer NOT NULL REFERENCES wpt.users(id) ON DELETE CASCADE,
  currency text NOT NULL,
  rate_to_sgd numeric(18,8) NOT NULL,
  PRIMARY KEY (user_id, currency)
);

CREATE TABLE IF NOT EXISTS wpt.settings (
  user_id integer PRIMARY KEY REFERENCES wpt.users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshots_user_idx ON wpt.snapshots (user_id);
CREATE INDEX IF NOT EXISTS positions_snapshot_idx ON wpt.positions (snapshot_id);
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON wpt.login_attempts (email, attempted_at);

ALTER TABLE wpt.app_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE wpt.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE wpt.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wpt.snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE wpt.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wpt.fx_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE wpt.settings ENABLE ROW LEVEL SECURITY;
`;

const ADD_KINDS = `
ALTER TABLE wpt.snapshots DROP CONSTRAINT IF EXISTS snapshots_kind_check;
ALTER TABLE wpt.snapshots ADD CONSTRAINT snapshots_kind_check
  CHECK (kind IN ('holding', 'savings', 'retirement', 'loan', 'property', 'cpf'));
`;

let schemaOk = false;
let pending: Promise<void> | null = null;

// Creates the tables the first time any request arrives. The setup script takes exclusive table locks
// and needs many round trips, so it only runs when the newest table is missing, and it gives up
// on a lock after 10 seconds instead of hanging every request behind it. A stuck connection also gives up
// after 15 seconds, so one bad connection cannot hold every later request.
export function ensureSchema(): Promise<void> {
  if (schemaOk) return Promise.resolve();
  if (!pending) {
    pending = guardDb(async () => {
      const sql = getDb();
      const [{ ok, kindsOk }] = await sql<{ ok: boolean; kindsOk: boolean }[]>`
        SELECT (to_regclass('wpt.settings') IS NOT NULL AND to_regclass('wpt.positions') IS NOT NULL) AS ok,
               COALESCE((SELECT pg_get_constraintdef(oid) LIKE '%cpf%' FROM pg_constraint
                         WHERE conname = 'snapshots_kind_check' AND conrelid = to_regclass('wpt.snapshots')), true) AS "kindsOk"`;
      if (!ok) {
        await sql.unsafe(`SET LOCAL lock_timeout = '10s'; ${DDL}`);
        return;
      }
      // A database created before property and CPF existed only allows the first four types.
      if (!kindsOk) await sql.unsafe(`SET LOCAL lock_timeout = '10s'; ${ADD_KINDS}`);
    }, 15_000)
      .then(() => {
        schemaOk = true;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

let cachedSecret: string | null = null;

// The signing key for session cookies is created once and kept in the database,
// so there is nothing to paste into Vercel's settings.
export async function getSigningSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const sql = getDb();
  await sql`INSERT INTO wpt.app_secret (id, value) VALUES (1, ${randomBytes(48).toString("hex")}) ON CONFLICT (id) DO NOTHING`;
  const rows = await sql<{ value: string }[]>`SELECT value FROM wpt.app_secret WHERE id = 1`;
  cachedSecret = rows[0].value;
  return cachedSecret;
}

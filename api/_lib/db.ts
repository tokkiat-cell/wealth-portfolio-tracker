import postgres from "postgres";
import { randomBytes } from "crypto";

// Tables live in their own schema ("wpt") and have row level security switched on.
// On Supabase this keeps them out of the public API even if a key ever leaks.

let client: ReturnType<typeof postgres> | null = null;

export class DatabaseNotConfigured extends Error {
  constructor() {
    super("No database is connected to this project yet.");
    this.name = "DatabaseNotConfigured";
  }
}

export function getDb() {
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
  kind text NOT NULL CHECK (kind IN ('holding', 'savings', 'retirement', 'loan')),
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

let ready: Promise<void> | null = null;

// Creates the tables the first time any request arrives. Safe to run repeatedly.
export function ensureSchema(): Promise<void> {
  if (!ready) {
    ready = getDb()
      .unsafe(DDL)
      .then(() => undefined)
      .catch((err) => {
        ready = null;
        throw err;
      });
  }
  return ready;
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

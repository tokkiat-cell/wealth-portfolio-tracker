# Wealth Portfolio Tracker

One place for your net worth, savings, loans, retirement accounts and investments across banks and brokers.

- Import CSV files, Obsidian notes (markdown tables), pasted tables, or PDF statements.
- Overview, Savings, Loans and Investments tabs. Loans show rate, maturity and estimated interest.
- Single owner: the first account created is the only one that can ever exist.
- Runs on Vercel: a Vite/React front end, serverless functions in `api/`, and a Postgres database.

No personal data lives in this repository. Your balances are stored in your own database.

## Set up on Vercel

1. **Import the repo.** Vercel > Add New > Project > pick this repo. The Vite preset is detected. Deploy.
2. **Add a database.** In the project, open Storage > Create Database (Supabase or Neon) and connect it to this project. That adds `POSTGRES_URL`. Redeploy once. The tables are created on the first visit, inside their own schema (`wpt`) with row level security on.
3. **PDF reading (optional).** Create a key at https://aistudio.google.com/apikey and add it as `GEMINI_API_KEY` in Settings > Environment Variables. Optional: `GEMINI_MODEL` (default `gemini-flash-latest`).
4. **Open the site and create the owner account.** Registration closes as soon as one account exists.
5. **Restore your data.** Import tab > Backup > Restore from backup, and pick your backup JSON.

The session key is generated once and kept in the database, so there is no secret to paste for sign-in.

## How it is built

| Path | What |
|---|---|
| `api/auth.ts` | sign in, sign out, owner-only registration, sign-in rate limit |
| `api/portfolio.ts` | overview, import, delete a snapshot, exchange rates, backup export |
| `api/pdf-extract.ts` | sends a PDF to Gemini and returns the lines for review (nothing is saved) |
| `api/_lib/` | database, sessions, request helpers |
| `shared/schema.ts` | validation shared by the browser and the functions |
| `src/` | the React app |

Passwords are hashed with scrypt. Session cookies are HttpOnly, Secure and SameSite=Lax, signed with HMAC.

## Privacy notes

- A PDF you import is sent to Google's Gemini API. Statements contain personal details, so use CSV or an Obsidian note if you would rather not send one.
- Backups contain all your balances. Keep them private.
- This tool records and reports. It is not investment advice.

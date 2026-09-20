import type { PositionInput } from "../../shared/schema";

// Turns CSV files, Obsidian markdown tables and pasted text into position lines.
// Everything runs in the browser; only the final lines are sent to the server.

export type Kind = "holding" | "loan" | "savings" | "retirement";

type Field = { key: string; label: string; re: RegExp[]; not?: RegExp };

export type Table = {
  title: string;
  headers: string[];
  rows: string[][];
  note: string;
  classHint: string | null;
  kindHint: Kind | null;
};

export type BuildOptions = {
  kind: Kind;
  classChoice: string; // "auto" or a class name
  classHint: string | null;
  valueIsSgd: boolean;
  plFraction: boolean;
};

export const CLASSES = ["Equities", "REITs", "Funds", "Fixed Income", "Cash", "Savings", "Other"];

// Order matters: a header is claimed by the first field that matches it.
const FIELDS: Field[] = [
  { key: "valueSGD", label: "Value in SGD", re: [/(value|amount|mkt|market|outstanding|balance|principal).*sgd|sgd.*(value|amount|mkt|market|outstanding|balance|principal)|sgd equiv/i] },
  { key: "value", label: "Market value / amount", re: [/^(market value|mkt value|value|position value|amount|current value|market val|net mkt value)$/i, /market ?val|mkt ?val|value|amount|outstanding|balance|principal/i] },
  { key: "plPct", label: "Unrealised P/L %", re: [/(p\/?l|pnl|gain|return|profit).*%|%.*(p\/?l|pnl|gain|return|profit)|unreali[sz]ed.*%/i] },
  { key: "pl", label: "Unrealised P/L", re: [/unreali[sz]ed|p\/?l|pnl|gain|profit/i] },
  { key: "unitCost", label: "Average cost per unit", re: [/avg|average|unit cost|cost price|purchase price|entry price/i] },
  { key: "cost", label: "Total cost", re: [/^(cost basis|total cost|cost|book cost|book value|cost value)$/i, /cost basis|total cost|book/i] },
  { key: "price", label: "Price", re: [/^(price|last price|market price|close price|current price|mkt price|close|last)$/i, /(market|current|last|close)[ _]?price|price/i], not: /avg|average|cost|purchase|entry/i },
  { key: "quantity", label: "Quantity", re: [/^(quantity|qty|units|shares|position|nominal|quantity net)$/i, /quantity|qty|units|shares|nominal/i], not: /unsettled/i },
  { key: "symbol", label: "Symbol / code", re: [/^(ticker|symbol|stock code|code|security code|instrument code|counter)$/i, /ticker|symbol|code/i] },
  { key: "isin", label: "ISIN", re: [/isin/i] },
  { key: "name", label: "Name", re: [/^(name|security name|instrument name|description|stock name|security|instrument|product name|product|loan|facility|liability|holding|fund)$/i, /name|descr|instrument|product|loan|facility/i] },
  { key: "assetClass", label: "Asset class", re: [/asset ?(class|category|type)|sec(urity)? ?type|product ?type|category|^type$/i] },
  { key: "currency", label: "Currency", re: [/^(currency|ccy|curr|trading currency)$/i, /currency|ccy/i] },
  { key: "account", label: "Account", re: [/account|acct|portfolio/i], not: /%/ },
  { key: "ratePct", label: "Interest rate %", re: [/rate|interest/i], not: /exchange|fx/i },
  { key: "maturity", label: "Maturity / end date", re: [/maturity|end date|due date|expiry/i] },
  { key: "monthly", label: "Monthly payment", re: [/monthly|instal?ment|repayment/i] },
];

const DISPLAY_ORDER = ["name", "symbol", "isin", "assetClass", "currency", "quantity", "price", "value", "valueSGD", "unitCost", "cost", "pl", "plPct", "account", "ratePct", "maturity", "monthly"];
export const DISPLAY_FIELDS: Field[] = DISPLAY_ORDER.map((k) => FIELDS.find((f) => f.key === k)!);

const ALL_ALIASES = FIELDS.flatMap((f) => f.re);

// ---------- numbers and dates ----------
function parseNum(v: string | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === "-" || s === "--" || /^n\/?a$/i.test(s)) return null;
  const k = s.replace(/[^\d.\-()]/g, "");
  if (!/\d/.test(k)) return null;
  const neg = k.includes("-") || (k.startsWith("(") && k.endsWith(")"));
  const n = parseFloat(k.replace(/[()\-]/g, ""));
  return isNaN(n) ? null : neg ? -n : n;
}

function parsePct(v: string | null | undefined, isFraction: boolean): number | null {
  const n = parseNum(v);
  if (n == null) return null;
  if (/%/.test(String(v))) return n / 100;
  return isFraction ? n : n / 100;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: string | number, m: string | number, d: string | number): string | null {
  let yy = +y;
  const mm = +m,
    dd = +d;
  if (yy < 100) yy += 2000;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// Day-first (Singapore) for numeric dates.
function parseDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]+(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return iso(m[3], m[2], m[1]);
  m = s.match(/(\d{4})(\d{2})(\d{2})/);
  if (m) return iso(m[1], m[2], m[3]);
  return null;
}

// ---------- delimited text (CSV, TSV) ----------
function detectDelim(text: string): string {
  const head = text.slice(0, 2000);
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (const c of head) {
    if (c === '"') q = !q;
    else if (!q && c in counts) counts[c]++;
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ",";
}

function parseDelimited(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delim = detectDelim(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      inQ = true;
      cell = "";
    } else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

function headerScore(cells: string[]): number {
  return cells.reduce(
    (n, c) => n + (c && !/^[\d.,\-()%\s]+$/.test(c) && ALL_ALIASES.some((re) => re.test(c)) ? 1 : 0),
    0,
  );
}

// Handles preamble lines above the header and IBKR-style sectioned statements.
function tableFromRows(all: string[][], title: string): Table {
  const ibkr = all.findIndex((r) => r[1] === "Header" && /^open positions$/i.test(r[0]));
  if (ibkr >= 0) {
    return {
      title,
      headers: all[ibkr].slice(2).map((s) => s.trim()),
      rows: all
        .filter((r) => /^open positions$/i.test(r[0]) && r[1] === "Data" && r[2] !== "Lot")
        .map((r) => r.slice(2)),
      note: 'Detected an IBKR statement: using the "Open Positions" section.',
      classHint: null,
      kindHint: null,
    };
  }
  let best = 0,
    bestScore = -1;
  all.slice(0, 40).forEach((r, i) => {
    const s = headerScore(r.map((c) => String(c).trim()));
    if (s > bestScore) {
      best = i;
      bestScore = s;
    }
  });
  if (bestScore < 2) best = 0;
  return {
    title,
    headers: all[best].map((s) => String(s).trim()),
    rows: all.slice(best + 1),
    note: best > 0 ? `Skipped ${best} line(s) above the header row.` : "",
    classHint: null,
    kindHint: null,
  };
}

// ---------- Obsidian / markdown tables ----------
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cleanCell(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\\\|/g, "|")
    .trim();
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map(cleanCell);
}

function markdownTables(text: string, fallbackTitle: string): Table[] {
  const lines = text.split(/\r?\n/);
  const out: Table[] = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) {
      heading = cleanCell(h[1]);
      continue;
    }
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      const headers = splitRow(lines[i]);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      out.push({
        title: heading || fallbackTitle,
        headers,
        rows,
        note: "",
        classHint: null,
        kindHint: null,
      });
      i = j - 1;
    }
  }
  return out;
}

// ---------- hints ----------
function hintsFrom(text: string): { classHint: string | null; kindHint: Kind | null } {
  const t = text.toLowerCase();
  if (/loan|leverage|borrow|lombard|mortgage|instal|credit card/.test(t)) return { classHint: null, kindHint: "loan" };
  if (/\bsrs\b|cpfis|retirement/.test(t)) return { classHint: null, kindHint: "retirement" };
  if (/deposit|saving|current account|bonus\$aver|multiplier/.test(t)) return { classHint: "Savings", kindHint: "savings" };
  if (/reit/.test(t)) return { classHint: "REITs", kindHint: null };
  if (/fixed income|structured|bond|\bnotes?\b/.test(t)) return { classHint: "Fixed Income", kindHint: null };
  if (/\bfunds?\b/.test(t)) return { classHint: "Funds", kindHint: null };
  if (/equit|stock|share/.test(t)) return { classHint: "Equities", kindHint: null };
  if (/\bcash\b/.test(t)) return { classHint: "Cash", kindHint: null };
  return { classHint: null, kindHint: null };
}

function classify(text: string, name: string): string {
  const t = text.toLowerCase(),
    n = name.toLowerCase();
  if (/^cash|deposit|currency balance/.test(t)) return "Cash";
  if (/reit|real estate investment/.test(t) || /\breit\b/.test(n)) return "REITs";
  if (/bond|fixed|debenture|bill|structured|treasury|\bnote/.test(t) || /\bnote\b|structured|\bbond\b/.test(n)) return "Fixed Income";
  if (/fund|unit trust|mutual|sicav|ucits/.test(t)) return "Funds";
  if (/option|warrant|future|crypto|forex|cfd/.test(t)) return "Other";
  return "Equities";
}

// ---------- entry point ----------
function parseAny(rawText: string, fileName: string): { tables: Table[]; asOf: string | null } {
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const base = fileName.replace(/\.[^.]+$/, "") || "Pasted text";

  let asOf: string | null = null;
  let body = text;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    const updated = fm[1].match(/^updated:\s*(.+)$/m);
    if (updated) asOf = parseDate(updated[1]);
  }
  const asOfLine = body.match(/\bas[\s-]?of\b[:*\s]*([^\n|]+)/i);
  if (asOfLine) asOf = parseDate(asOfLine[1]) ?? asOf;
  asOf = asOf ?? parseDate(fileName);

  const looksMarkdown = /^\s*\|.*\|\s*$/m.test(body) && /^\s*\|?\s*:?-{3,}/m.test(body);
  let tables: Table[];
  if (looksMarkdown) {
    tables = markdownTables(body, base);
  } else {
    const rows = parseDelimited(body);
    tables = rows.length > 1 ? [tableFromRows(rows, base)] : [];
  }
  tables = tables.map((t) => {
    const h = hintsFrom(`${t.title} ${base}`);
    return { ...t, classHint: h.classHint, kindHint: h.kindHint };
  });
  return { tables, asOf };
}

// Picks a header for each field. Deterministic, so no saved choices are needed.
function autoMap(table: Table): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of FIELDS) {
    map[f.key] = "";
    outer: for (const re of f.re) {
      for (const h of table.headers) {
        if (!h || used.has(h) || !re.test(h) || (f.not && f.not.test(h))) continue;
        map[f.key] = h;
        used.add(h);
        break outer;
      }
    }
  }
  // Account lists often have no name column: use the account column as the name.
  if (!map.name && !map.symbol && map.account) {
    map.name = map.account;
    map.account = "";
  }
  // A "P/L" column full of percentages is a percentage column.
  if (map.pl && !map.plPct) {
    const i = table.headers.indexOf(map.pl);
    const cells = table.rows.map((r) => (r[i] ?? "").trim()).filter(Boolean);
    if (cells.length > 0 && cells.filter((c) => c.includes("%")).length / cells.length > 0.5) {
      map.plPct = map.pl;
      map.pl = "";
    }
  }
  return map;
}

function isUsable(map: Record<string, string>): boolean {
  const hasName = !!(map.name || map.symbol);
  const hasValue = !!(map.value || map.valueSGD || (map.quantity && map.price));
  return hasName && hasValue;
}

function buildRows(
  table: Table,
  map: Record<string, string>,
  o: BuildOptions,
): { rows: PositionInput[]; skipped: string[] } {
  const idx: Record<string, number> = {};
  for (const f of FIELDS) idx[f.key] = map[f.key] ? table.headers.indexOf(map[f.key]) : -1;
  const rows: PositionInput[] = [];
  const skipped: string[] = [];

  for (const r of table.rows) {
    const g = (k: string) => (idx[k] >= 0 ? String(r[idx[k]] ?? "").trim() : "");
    const name = g("name"),
      symbol = g("symbol");
    if (!name && !symbol) continue;
    if (/^(total|sub-?total|grand total)\b/i.test(name || symbol)) continue;

    const ccyRaw = g("currency");
    const currency = /^[A-Za-z]{3}$/.test(ccyRaw) ? ccyRaw.toUpperCase() : "SGD";
    const qty = parseNum(g("quantity"));
    const price = parseNum(g("price"));
    let value = parseNum(g("value"));
    let valueSgd = parseNum(g("valueSGD"));
    if (value == null && qty != null && price != null) value = qty * price;
    if (value != null && o.valueIsSgd && valueSgd == null) valueSgd = value;
    if (value == null && valueSgd == null) {
      skipped.push(name || symbol);
      continue;
    }

    let cost = parseNum(g("cost"));
    const unit = parseNum(g("unitCost"));
    if (cost == null && unit != null && qty != null) cost = unit * qty;
    const pl = parseNum(g("pl"));
    let plPct = parsePct(g("plPct"), o.plFraction);
    if (plPct == null && pl != null && value != null && value - pl !== 0) plPct = pl / (value - pl);
    if (plPct == null && cost && value != null) plPct = value / cost - 1;

    const loan = o.kind === "loan";
    const fix = (v: number | null) => (v == null ? null : loan ? -Math.abs(v) : v);

    const label = `${name} ${g("assetClass")}`.toLowerCase();
    let assetClass: string;
    if (loan) {
      assetClass = /credit card|mastercard|visa/.test(label)
        ? "Credit card"
        : /instal/.test(label)
          ? "Instalment plan"
          : /mortgage|housing/.test(label)
            ? "Mortgage"
            : "Loans";
    } else if (o.classChoice !== "auto") assetClass = o.classChoice;
    else if (o.kind === "savings") assetClass = "Savings";
    else if (g("assetClass")) assetClass = classify(g("assetClass"), name);
    else if (o.classHint) assetClass = o.classHint;
    else assetClass = classify("", name || symbol);

    const rate = parseNum(g("ratePct"));
    const monthly = parseNum(g("monthly"));

    rows.push({
      name: name || symbol,
      symbol,
      isin: g("isin"),
      assetClass,
      currency,
      quantity: qty,
      price,
      valueLocal: fix(value),
      valueSgd: fix(valueSgd),
      plPct: loan ? null : plPct,
      ratePct: rate != null && rate >= 0 ? rate : null,
      maturityDate: parseDate(g("maturity")),
      monthlyPayment: monthly == null ? null : Math.abs(monthly),
      note: "",
    });
  }
  return { rows, skipped };
}

export const importParsing = {
  parseAny,
  autoMap,
  isUsable,
  buildRows,
  parseDate,
};

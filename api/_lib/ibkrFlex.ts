import { positionSchema } from "../../shared/schema";
import type { ExtractedSection, ExtractedStatement, PositionInput } from "../../shared/schema";
import { HttpError } from "./http";

// Interactive Brokers Flex Web Service: a read-only report you set up once in Client Portal.
// A token (IBKR_FLEX_TOKEN) plus the query id (IBKR_FLEX_QUERY_ID) fetch it. It cannot trade or move money.
// The token is only ever sent to an interactivebrokers.com host and is never logged or returned.

const SEND_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest";
const DEFAULT_GET_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement";
const USER_AGENT = "WealthPortfolioTracker/1.0";
const MAX_XML = 8 * 1024 * 1024;

export const flexConfigured = () => Boolean(process.env.IBKR_FLEX_TOKEN && process.env.IBKR_FLEX_QUERY_ID);

// Codes IBKR documents as "try again shortly".
const RETRY_CODES = new Set(["1001", "1004", "1005", "1006", "1007", "1008", "1009", "1018", "1019", "1021"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
    const text = await r.text();
    if (text.length > MAX_XML) throw new HttpError(502, "IBKR's report was larger than expected.");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // The message is fixed on purpose: a network error can quote the URL, which contains the token.
    throw new HttpError(504, "Could not reach IBKR. Try again in a minute.", "IBKR_BUSY");
  } finally {
    clearTimeout(timer);
  }
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]?.trim() ?? null;

function statusOf(xml: string) {
  return {
    status: tag(xml, "Status"),
    ref: tag(xml, "ReferenceCode"),
    url: tag(xml, "Url"),
    code: tag(xml, "ErrorCode"),
    message: tag(xml, "ErrorMessage"),
  };
}

// The token may only go to IBKR's own hosts.
function trustedGetUrl(url: string | null): string {
  try {
    const u = new URL(url ?? "");
    if (u.protocol === "https:" && /(^|\.)interactivebrokers\.com$/i.test(u.hostname)) return `${u.origin}${u.pathname}`;
  } catch {
    // fall through to the default
  }
  return DEFAULT_GET_URL;
}

const ibkrError = (code: string | null, message: string | null) => {
  const hint =
    code === "1012" || code === "1015"
      ? " Create a new token in IBKR Client Portal and update IBKR_FLEX_TOKEN in Vercel."
      : code === "1014" || code === "1020"
        ? " Check IBKR_FLEX_QUERY_ID in Vercel."
        : code === "1013"
          ? " The token has an IP restriction. Remove it in Client Portal (Vercel's addresses change)."
          : "";
  return new HttpError(502, `IBKR said: ${message ?? "the request failed"}${code ? ` (code ${code})` : ""}.${hint}`, "IBKR_FAILED");
};

// SendRequest, then GetStatement until the report is ready (about a minute at most).
export async function fetchFlexXml(): Promise<string> {
  const token = process.env.IBKR_FLEX_TOKEN;
  const queryId = process.env.IBKR_FLEX_QUERY_ID;
  if (!token || !queryId) {
    throw new HttpError(
      503,
      "IBKR is not set up. Add IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID in Vercel's project settings.",
      "IBKR_NOT_CONFIGURED",
    );
  }
  const deadline = Date.now() + 54_000;
  const left = () => deadline - Date.now();

  let sent = statusOf("");
  for (;;) {
    const xml = await httpGet(
      `${SEND_URL}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`,
      Math.min(15_000, left()),
    );
    sent = statusOf(xml);
    if (sent.status === "Success" && sent.ref) break;
    if (sent.code && RETRY_CODES.has(sent.code) && left() > 15_000) {
      await sleep(sent.code === "1018" ? 10_000 : 4_000);
      continue;
    }
    throw ibkrError(sent.code, sent.message);
  }

  const ref = sent.ref;
  if (!ref) throw ibkrError(sent.code, sent.message);
  const getUrl = trustedGetUrl(sent.url);
  await sleep(2_000);
  for (;;) {
    if (left() < 6_000) {
      throw new HttpError(504, "IBKR is still preparing the report. Try again in a minute.", "IBKR_BUSY");
    }
    const xml = await httpGet(
      `${getUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(ref)}&v=3`,
      Math.min(20_000, left()),
    );
    if (xml.includes("<FlexQueryResponse")) return xml;
    const s = statusOf(xml);
    if (s.code && RETRY_CODES.has(s.code)) {
      await sleep(s.code === "1018" ? 10_000 : 4_000);
      continue;
    }
    throw ibkrError(s.code, s.message);
  }
}

// ---------- parsing ----------

type Attrs = Record<string, string>;

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

// Flex reports are elements with only attributes, so a small reader is enough.
function elements(xml: string, name: string): Attrs[] {
  const out: Attrs[] = [];
  const re = new RegExp(`<${name}\\s([^>]*?)/?>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs: Attrs = {};
    const are = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
    for (let a = are.exec(m[1]); a; a = are.exec(m[1])) attrs[a[1]] = decode(a[2]);
    out.push(attrs);
  }
  return out;
}

const num = (s: string | undefined): number | null => {
  if (s == null || s.trim() === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

const round = (n: number | null, dp: number) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);

// 20260918, 2026-09-18 and 20260918;153000 all become 2026-09-18.
function isoDate(s: string | undefined): string | null {
  const m = (s ?? "").match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function assetClass(p: Attrs): string {
  const cat = (p.assetCategory || "").toUpperCase();
  const text = `${p.description ?? ""} ${p.subCategory ?? ""}`;
  if (cat === "OPT" || cat === "FOP") return "Options";
  if (cat === "FUT") return "Futures";
  if (cat === "BOND") return "Fixed Income";
  if (cat === "FUND") return "Funds";
  if (cat === "CASH") return "Cash";
  if (/\b(gold|bullion)\b/i.test(text)) return "Gold";
  if (cat === "STK" || cat === "") return /\bREIT\b/i.test(text) ? "REITs" : "Equities";
  return "Other";
}

function parseStatement(block: string, single: boolean, notes: string[]) {
  const head: Attrs = elements(block.slice(0, block.indexOf(">") + 1), "FlexStatement")[0] ?? {};
  const accountId = head.accountId || elements(block, "AccountInformation")[0]?.accountId || "";
  const accountLabel = single || !accountId ? "" : `...${accountId.slice(-4)}`;
  const info = elements(block, "AccountInformation")[0];

  const lod = (a: Attrs) => (a.levelOfDetail || "").toUpperCase();
  const open = elements(block, "OpenPosition").filter((a) => lod(a) !== "LOT" && lod(a) !== "EXECUTION");
  const cash = elements(block, "CashReportCurrency").filter((a) => a.currency && !/^BASE/i.test(a.currency));

  // Base currency: from Account Information, else the currency whose rate to base is exactly 1.
  let base: string | null = info?.currency?.toUpperCase() || null;
  if (!base) {
    base = [...open, ...cash].find((a) => num(a.fxRateToBase) === 1 && a.currency)?.currency.toUpperCase() ?? null;
  }
  // SGD per one unit of the base currency, using IBKR's own rate so the account ties out to its statement.
  let sgdPerBase: number | null = base === "SGD" ? 1 : null;
  if (base && base !== "SGD") {
    const rate = num([...cash, ...open].find((a) => a.currency?.toUpperCase() === "SGD" && num(a.fxRateToBase))?.fxRateToBase);
    if (rate) sgdPerBase = 1 / rate;
  }
  if (base && base !== "SGD" && sgdPerBase == null) {
    notes.push(`The account's base currency is ${base}, and the report has no SGD line to take IBKR's rate from, so this app's own ${base} exchange rate is used.`);
  }

  const toSgd = (value: number | null, currency: string, fxToBase: number | null) => {
    if (value == null) return null;
    if (currency === "SGD") return round(value, 2);
    const fx = fxToBase ?? (currency === base ? 1 : null);
    return fx != null && sgdPerBase != null ? round(value * fx * sgdPerBase, 2) : null;
  };

  let skipped = 0;
  const candidates: unknown[] = [];

  // Options are netted per underlying (short legs are negative), as in the rest of this portfolio.
  const optionGroups = new Map<string, { und: string; currency: string; fx: number | null; value: number; pnl: number; legs: string[] }>();

  for (const p of open) {
    const currency = (p.currency || "").toUpperCase();
    const qty = num(p.position ?? p.quantity);
    const mark = num(p.markPrice);
    const mult = num(p.multiplier) ?? 1;
    const value = num(p.positionValue) ?? (qty != null && mark != null ? qty * mark * mult : null);
    if (value == null || currency.length !== 3) {
      skipped++;
      continue;
    }
    const fx = num(p.fxRateToBase);
    const cls = assetClass(p);

    if (cls === "Options") {
      const und = p.underlyingSymbol || (p.symbol || "").split(/\s+/)[0] || "Options";
      const key = `${und}|${currency}`;
      const g = optionGroups.get(key) ?? { und, currency, fx, value: 0, pnl: 0, legs: [] };
      g.value += value;
      g.pnl += num(p.fifoPnlUnrealized) ?? 0;
      const desc = (p.description || p.symbol || "option").trim();
      g.legs.push(`${desc} ${qty != null && qty < 0 ? "short" : "long"}${qty != null && Math.abs(qty) > 1 ? ` x${Math.abs(qty)}` : ""}`);
      optionGroups.set(key, g);
      continue;
    }

    const costPrice = num(p.costBasisPrice);
    const costMoney = num(p.costBasisMoney);
    const pnl = num(p.fifoPnlUnrealized);
    const plPct =
      costPrice && mark != null && costPrice > 0
        ? mark / costPrice - 1
        : costMoney && pnl != null && costMoney !== 0
          ? pnl / Math.abs(costMoney)
          : null;

    candidates.push({
      name: (p.description || p.symbol || "Unnamed").trim(),
      symbol: (p.symbol || "").slice(0, 40),
      isin: (p.isin || "").slice(0, 20),
      assetClass: cls,
      currency,
      quantity: round(qty, 6),
      price: round(mark, 6),
      valueLocal: round(value, 2),
      valueSgd: toSgd(value, currency, fx),
      plPct: plPct == null ? null : round(plPct, 6),
      ratePct: null,
      maturityDate: null,
      monthlyPayment: null,
      note: `Flex Query${p.reportDate ? `, ${isoDate(p.reportDate) ?? p.reportDate}` : ""}`,
    });
  }

  for (const g of optionGroups.values()) {
    candidates.push({
      name: `${g.und} options (net)`,
      symbol: "",
      isin: "",
      assetClass: "Options",
      currency: g.currency,
      quantity: null,
      price: null,
      valueLocal: round(g.value, 2),
      valueSgd: toSgd(g.value, g.currency, g.fx),
      plPct: null,
      ratePct: null,
      maturityDate: null,
      monthlyPayment: null,
      note: `${g.legs.join("; ")}. Unrealised ${g.pnl >= 0 ? "+" : ""}${Math.round(g.pnl)}`.slice(0, 500),
    });
  }

  for (const c of cash) {
    const currency = c.currency.toUpperCase();
    const value = num(c.endingCash) ?? num(c.endingSettledCash);
    if (value == null || Math.abs(value) < 0.005 || currency.length !== 3) continue;
    candidates.push({
      name: `Cash (${currency})`,
      symbol: "",
      isin: "",
      assetClass: "Cash",
      currency,
      quantity: null,
      price: null,
      valueLocal: round(value, 2),
      valueSgd: toSgd(value, currency, num(c.fxRateToBase)),
      plPct: null,
      ratePct: null,
      maturityDate: null,
      monthlyPayment: null,
      note: `IBKR cash in ${currency}${value < 0 ? " (negative: borrowed on margin)" : ""}`,
    });
  }

  const positions: PositionInput[] = [];
  for (const c of candidates) {
    const check = positionSchema.safeParse(c);
    if (check.success) positions.push(check.data);
    else skipped++;
  }

  // Newest position date, else the statement's end date.
  const dates = open.map((a) => isoDate(a.reportDate)).filter((d): d is string => Boolean(d));
  const asOf = dates.sort().at(-1) ?? isoDate(head.toDate) ?? isoDate(head.whenGenerated) ?? null;
  return { section: { kind: "holding", accountLabel, positions } as ExtractedSection, asOf, skipped, openCount: open.length, cashCount: cash.length };
}

export function parseFlex(xml: string): ExtractedStatement {
  const blocks = xml.match(/<FlexStatement\s[\s\S]*?<\/FlexStatement>/g) ?? [];
  if (blocks.length === 0) {
    throw new HttpError(
      422,
      "The report has no statements. In the Flex Query, choose XML format and include Open Positions and Cash Report.",
      "IBKR_EMPTY",
    );
  }
  const notes: string[] = [];
  const sections: ExtractedSection[] = [];
  let skipped = 0;
  let statementDate: string | null = null;
  let sawOpen = false;
  let sawCash = false;
  for (const block of blocks) {
    const r = parseStatement(block, blocks.length === 1, notes);
    skipped += r.skipped;
    sawOpen ||= r.openCount > 0;
    sawCash ||= r.cashCount > 0;
    if (r.asOf && (!statementDate || r.asOf > statementDate)) statementDate = r.asOf;
    if (r.section.positions.length > 0) sections.push(r.section);
  }
  if (!sawOpen) notes.push("No open positions were in the report. Add the Open Positions section to the Flex Query if you hold any.");
  if (!sawCash) notes.push("No cash balances were in the report. Add the Cash Report section to the Flex Query.");
  if (sections.length === 0) {
    throw new HttpError(422, "The report had no usable positions or cash. Check the sections and fields in the Flex Query.", "IBKR_EMPTY");
  }
  return { institution: "Interactive Brokers", statementDate, sections, skipped, notes: [...new Set(notes)] };
}

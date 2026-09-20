import { z } from "zod";
import { askClaudeAboutPdf } from "./_lib/anthropic";
import { DatabaseNotConfigured, ensureSchema } from "./_lib/db";
import { HttpError, Req, Res, assertSameOrigin, fail, readBody, send } from "./_lib/http";
import { requireUser } from "./_lib/session";
import { MAX_PDF_BYTES, kindSchema, positionSchema } from "../shared/schema";
import type { ExtractedSection, ExtractedStatement } from "../shared/schema";

// Reads a bank or broker statement PDF with Anthropic's Claude API (the same ANTHROPIC_API_KEY as the chat).
// Nothing is saved here: the browser shows the result and the user confirms the import.

const INSTRUCTIONS = `You extract balances from Singapore bank and broker statements (DBS, POSB, UOB, Standard Chartered, Moomoo, Tiger Brokers, IBKR and similar). Reply with ONE JSON object and nothing else.

Shape:
{"institution": string, "statementDate": "YYYY-MM-DD" or null,
 "sections": [{"kind": "holding" | "savings" | "retirement" | "loan" | "cpf", "accountLabel": string,
   "lines": [{"name": string, "symbol": string, "isin": string, "assetClass": string, "currency": "SGD",
     "quantity": number or null, "price": number or null, "valueLocal": number or null, "valueSgd": number or null,
     "plPct": number or null, "ratePct": number or null, "maturityDate": "YYYY-MM-DD" or null,
     "monthlyPayment": number or null, "note": string}]}],
 "notes": [string]}

Rules:
- Only balances, holdings and liabilities. No transactions, no marketing text, no terms.
- Leave out personal details: names, addresses, phone numbers, relationship managers. Mask every account or card number to its last 4 characters, like "...1234". accountLabel is the masked account or portfolio.
- kind "savings" = deposit, current, savings, multiplier and settlement cash accounts. kind "holding" = an investment portfolio (stocks, ETFs, REITs, funds, bonds, structured notes) plus the cash held inside it. kind "retirement" = SRS and CPFIS accounts, with their cash balance as a line whose assetClass is "Cash". kind "loan" = loans, mortgages, credit card balances and instalment plans. kind "cpf" = CPF balance statements: one line per account, named like "Ordinary Account (OA)", "Special Account (SA)", "MediSave Account (MA)" or "Retirement Account (RA)", with assetClass "CPF". Never put the CPF or NRIC number in the output.
- One line per position, or per account and currency for deposits. For a deposit in a foreign currency put the balance in valueLocal and the statement's SGD equivalent in valueSgd.
- valueSgd is the SGD value printed on the statement. For an SGD line, valueSgd equals valueLocal. Numbers are plain numbers with no commas or currency symbols.
- Loans: values are NEGATIVE. ratePct is a percentage number (1.51 for 1.51%). maturityDate is the end of the current loan period, or the last instalment if stated. monthlyPayment is positive if stated. For a credit card use the new balance and put the minimum payment and due date in note. For an instalment plan use the remaining amount still to be billed.
- assetClass must be one of: Equities, REITs, Funds, Fixed Income, Cash, Savings, Loans, Credit card, Instalment plan, Mortgage, Other. Use Savings for deposit accounts and REITs for REIT units.
- plPct is unrealised P/L as a fraction of cost (-0.25 means -25%) when the statement shows it, otherwise null.
- Never invent a number. If a value is not printed, leave the field out. Mention anything unclear in notes.
- To keep the reply short, leave out any field whose value would be null or an empty string. Reply with the JSON only: no code fence, no other text.`;

const num = z.preprocess((v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}, z.number().nullable());

const text = (max: number) =>
  z
    .preprocess((v) => (v == null ? "" : String(v)), z.string())
    .transform((s) => s.slice(0, max));

const dateOrNull = z.preprocess(
  (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null),
  z.string().nullable(),
);

const lineSchema = z.object({
  name: text(200),
  symbol: text(40).default(""),
  isin: text(20).default(""),
  assetClass: text(40).default("Other"),
  currency: z.preprocess(
    (v) => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : "SGD"),
    z.string(),
  ),
  quantity: num.default(null),
  price: num.default(null),
  valueLocal: num.default(null),
  valueSgd: num.default(null),
  plPct: num.default(null),
  ratePct: num.default(null),
  maturityDate: dateOrNull.default(null),
  monthlyPayment: num.default(null),
  note: text(500).default(""),
});

const modelSchema = z.object({
  institution: text(60).default(""),
  statementDate: dateOrNull.default(null),
  sections: z
    .array(
      z.object({
        kind: kindSchema,
        accountLabel: text(60).default(""),
        lines: z.array(lineSchema).default([]),
      }),
    )
    .default([]),
  notes: z.array(text(300)).default([]),
});

// The JSON object inside the reply, even if it came wrapped in a code fence or a sentence.
const jsonPart = (s: string) => {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
};

const isPdf = (b: Buffer) => b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-";

export default async function handler(req: Req, res: Res) {
  try {
    await ensureSchema();
    await requireUser(req);
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    assertSameOrigin(req);

    const pdf = await readBody(req, MAX_PDF_BYTES);
    if (!isPdf(pdf)) return fail(res, 400, "That file is not a PDF.");

    const raw = await askClaudeAboutPdf({
      system: INSTRUCTIONS,
      prompt: "Extract the balances, holdings and liabilities from this statement as JSON.",
      pdf,
    });
    let json: unknown;
    try {
      json = JSON.parse(jsonPart(raw));
    } catch {
      return fail(res, 422, "The AI reply could not be read. Try again, or use a CSV.");
    }
    const model = modelSchema.safeParse(json);
    if (!model.success) {
      return fail(res, 422, "The AI reply had an unexpected shape. Try again, or use a CSV.");
    }

    // Keep only lines that pass the same checks as a normal import.
    let skipped = 0;
    const sections: ExtractedSection[] = [];
    for (const s of model.data.sections) {
      const positions = [];
      for (const l of s.lines) {
        const signed = (v: number | null) => (v == null ? null : s.kind === "loan" ? -Math.abs(v) : v);
        const candidate = {
          name: l.name.trim(),
          symbol: l.symbol,
          isin: l.isin,
          assetClass:
            s.kind === "loan" && !/loan|card|instal|mortgage/i.test(l.assetClass)
              ? "Loans"
              : l.assetClass || "Other",
          currency: l.currency,
          quantity: l.quantity,
          price: l.price,
          valueLocal: signed(l.valueLocal),
          valueSgd: signed(l.valueSgd ?? (l.currency === "SGD" ? l.valueLocal : null)),
          plPct: l.plPct,
          ratePct: l.ratePct != null && l.ratePct >= 0 ? l.ratePct : null,
          maturityDate: l.maturityDate,
          monthlyPayment: l.monthlyPayment == null ? null : Math.abs(l.monthlyPayment),
          note: l.note,
        };
        const check = positionSchema.safeParse(candidate);
        if (check.success) positions.push(check.data);
        else skipped++;
      }
      if (positions.length > 0) {
        sections.push({ kind: s.kind, accountLabel: s.accountLabel.trim(), positions });
      }
    }

    const result: ExtractedStatement = {
      institution: model.data.institution,
      statementDate: model.data.statementDate,
      sections,
      skipped,
      notes: model.data.notes,
    };
    return send(res, 200, result);
  } catch (error) {
    if (error instanceof DatabaseNotConfigured) {
      return fail(res, 503, error.message, "DATABASE_NOT_CONFIGURED");
    }
    if (error instanceof HttpError) return fail(res, error.status, error.message, error.code);
    console.error("pdf extract error:", error);
    return fail(res, 500, "Could not read that PDF.");
  }
}

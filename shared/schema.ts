import { z } from "zod";

// Shared by the browser and the server functions.

export const MAX_PDF_BYTES = 3.5 * 1024 * 1024;

const money = z.number().finite().min(-1e15).max(1e15);

export const kindSchema = z.enum(["holding", "savings", "retirement", "loan"]);
export type Kind = z.infer<typeof kindSchema>;

export const positionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    symbol: z.string().max(40),
    isin: z.string().max(20),
    assetClass: z.string().min(1).max(40),
    currency: z.string().length(3),
    quantity: money.nullable(),
    price: money.nullable(),
    valueLocal: money.nullable(),
    valueSgd: money.nullable(),
    plPct: z.number().finite().min(-100000).max(100000).nullable(),
    ratePct: z.number().finite().min(0).max(1000).nullable(),
    maturityDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    monthlyPayment: money.nullable(),
    note: z.string().max(500),
  })
  .refine((p) => p.valueLocal != null || p.valueSgd != null, {
    message: "Each line needs a value",
  });
export type PositionInput = z.infer<typeof positionSchema>;

export const importSchema = z.object({
  broker: z.string().trim().min(1).max(40),
  accountLabel: z.string().trim().max(60),
  kind: kindSchema,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  source: z.string().max(200),
  positions: z.array(positionSchema).min(1).max(2000),
});
export type ImportInput = z.infer<typeof importSchema>;

export const fxSchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter code such as USD")
    .refine((c) => c !== "SGD", "SGD is the base currency"),
  rate: z.number().finite().positive().max(1_000_000),
});

// What the browser receives.
export type PositionRow = {
  name: string;
  symbol: string;
  isin: string;
  assetClass: string;
  currency: string;
  quantity: number | null;
  price: number | null;
  valueLocal: number | null;
  valueSgd: number | null;
  plPct: number | null;
  ratePct: number | null;
  maturityDate: string | null;
  monthlyPayment: number | null;
  note: string;
  broker: string;
  accountLabel: string;
  kind: Kind;
  asOf: string;
};

export type SnapshotRow = {
  id: number;
  broker: string;
  accountLabel: string;
  kind: Kind;
  asOf: string;
  source: string;
  lines: number;
};

// The user's own targets and limits, kept in the database so every device sees them.
export const settingsSchema = z.object({
  targets: z.record(z.string().min(1).max(40), z.number().min(0).max(100)).default({}),
  maxNonSgdPct: z.number().min(0).max(100).nullable().default(null),
  maxPositionPct: z.number().min(0).max(100).nullable().default(null),
});
export type Settings = z.infer<typeof settingsSchema>;

export type Overview = {
  positions: PositionRow[];
  snapshots: SnapshotRow[];
  fx: Record<string, number>;
  settings: Settings;
};

export type ExtractedSection = {
  kind: Kind;
  accountLabel: string;
  positions: PositionInput[];
};

export type ExtractedStatement = {
  institution: string;
  statementDate: string | null;
  sections: ExtractedSection[];
  skipped: number;
  notes: string[];
};

export type BackupFile = {
  app: "wealth-portfolio-tracker";
  version: 1;
  snapshots: ImportInput[];
  fx: Record<string, number>;
};

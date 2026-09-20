import { useState } from "react";
import { Dropzone } from "./Dropzone";
import { ReviewImport } from "./ReviewImport";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { MAX_PDF_BYTES, type ExtractedStatement } from "../../shared/schema";

const guessBroker = (institution: string) => {
  const t = institution.toLowerCase();
  if (/\bcpf\b|central provident/.test(t)) return "CPF";
  if (/vickers/.test(t)) return "DBS Vickers";
  if (/dbs|posb/.test(t)) return "DBS";
  if (/standard chartered|scb/.test(t)) return "SCB";
  if (/uob|united overseas/.test(t)) return "UOB";
  if (/moomoo|futu/.test(t)) return "Moomoo";
  if (/interactive|ibkr/.test(t)) return "IBKR";
  return "Other";
};

interface Props {
  onChanged: () => void;
}

export function PdfImportPanel({ onChanged }: Props) {
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<ExtractedStatement | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const read = async (files: File[]) => {
    const file = files[0];
    setError(null);
    setResult(null);
    setFileName(file.name);
    setReading(true);
    try {
      const r = await api.extractPdf(file);
      setResult(r);
      if (r.sections.length === 0) setError("No balances were found in that PDF.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that PDF");
    } finally {
      setReading(false);
    }
  };

  return (
    <section className="card">
      <h3>Import a PDF statement</h3>
      <p className="muted">
        Works with bank and broker statements (DBS, SCB, UOB and similar) and CPF balance statements. Google's Gemini
        reads the PDF and lists the balances, holdings and loans it finds. You review them before anything is saved.
      </p>
      <p className="notice" style={{ marginTop: "0.5rem" }}>
        Privacy: the whole PDF is sent to Google's Gemini API, and statements contain personal details. The AI is told
        to leave names, addresses and transactions out of its answer, and the PDF is not stored here. If you would
        rather not send it, use a CSV or an Obsidian note instead, which stay in your browser.
      </p>

      <Dropzone
        accept=".pdf,application/pdf"
        maxBytes={MAX_PDF_BYTES}
        title="Drop a PDF statement here, or click to choose"
        subtitle="One file, up to 3.5 MB"
        disabled={reading}
        onFiles={read}
        onError={toast.error}
      />

      {reading && <p>Reading {fileName}. This can take up to a minute.</p>}
      {error && <p className="notice error">{error}</p>}

      {result && result.sections.length > 0 && (
        <ReviewImport
          key={fileName}
          result={result}
          initialBroker={guessBroker(result.institution)}
          source={`PDF: ${fileName}`}
          from="from the PDF"
          flaggedBy="The reader flagged"
          footnote="Check these against your statement before importing. Totals here are the sum of the lines the AI read."
          onImported={() => {
            setResult(null);
            setFileName("");
            onChanged();
          }}
          onDiscard={() => setResult(null)}
        />
      )}
    </section>
  );
}

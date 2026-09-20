import { HttpError } from "./http";

// Shared Gemini call for the chat: tries the main model, then backups, and can use Google Search grounding.

export type GeminiContent = { role: "user" | "model"; parts: { text: string }[] };
export type Source = { title: string; url: string };

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
};

// Overload, rate limit, retired model: try the next model.
const SKIP = new Set([404, 429, 500, 502, 503, 504]);

function models(): string[] {
  return [
    ...new Set([
      process.env.GEMINI_MODEL || "gemini-flash-latest",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-flash-lite-latest",
    ]),
  ];
}

async function callModel(
  model: string,
  key: string,
  system: string,
  contents: GeminiContent[],
  search: boolean,
  timeoutMs: number,
): Promise<{ text: string; sources: Source[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          ...(search ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
        }),
      },
    );
    const data = (await r.json().catch(() => ({}))) as GeminiResponse;
    if (r.status === 400 || r.status === 403) {
      throw new HttpError(502, data.error?.message ?? "Gemini rejected the request.", search ? "GEMINI_BAD_REQUEST" : undefined);
    }
    if (SKIP.has(r.status)) {
      throw new HttpError(r.status === 429 ? 429 : 503, data.error?.message ?? "Gemini is busy.", "GEMINI_BUSY");
    }
    if (!r.ok) throw new HttpError(502, data.error?.message ?? "Gemini could not answer.");
    if (data.promptFeedback?.blockReason) throw new HttpError(422, "Gemini declined to answer that.");
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (!text) throw new HttpError(422, "Gemini returned nothing. Try rephrasing.");

    const seen = new Set<string>();
    const sources: Source[] = [];
    for (const c of cand?.groundingMetadata?.groundingChunks ?? []) {
      const url = c.web?.uri;
      if (url && /^https:\/\//i.test(url) && !seen.has(url) && sources.length < 8) {
        seen.add(url);
        sources.push({ title: (c.web?.title || url).slice(0, 120), url });
      }
    }
    return { text, sources };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "The answer took too long.", "GEMINI_BUSY");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function ask(opts: {
  system: string;
  contents: GeminiContent[];
  search: boolean;
}): Promise<{ text: string; sources: Source[]; model: string; searched: boolean }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new HttpError(
      503,
      "The AI needs a Gemini API key. Add GEMINI_API_KEY in Vercel's project settings.",
      "GEMINI_NOT_CONFIGURED",
    );
  }
  const deadline = Date.now() + 54_000;
  let last: HttpError | null = null;
  for (const model of models()) {
    const remaining = deadline - Date.now();
    if (remaining < 10_000) break;
    try {
      try {
        const r = await callModel(model, key, opts.system, opts.contents, opts.search, remaining);
        return { ...r, model, searched: opts.search };
      } catch (error) {
        // If the web-search tool is what was refused, answer without it rather than fail.
        if (opts.search && error instanceof HttpError && error.code === "GEMINI_BAD_REQUEST") {
          const r = await callModel(model, key, opts.system, opts.contents, false, deadline - Date.now());
          return { ...r, model, searched: false };
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof HttpError && error.code === "GEMINI_BUSY") {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw new HttpError(
    503,
    `Google's Gemini is busy right now${last ? ` (${last.message})` : ""}. Wait a minute and try again.`,
    "GEMINI_BUSY",
  );
}

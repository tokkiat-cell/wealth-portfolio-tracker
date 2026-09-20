import { HttpError } from "./http";

export type ChatContent = { role: "user" | "model"; parts: { text: string }[] };
export type Source = { title: string; url: string };

// Anthropic's Claude API (console.anthropic.com). Pay per use with its own key: a Claude.ai subscription
// does not include API access. Only the models listed here can be chosen, so the cost is predictable.

export const CLAUDE_MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5 (recommended)" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (fastest, cheapest)" },
  { id: "claude-opus-5", name: "Claude Opus 5 (most capable, costs more)" },
];

type Block = {
  type?: string;
  text?: string;
  content?: unknown;
  citations?: { url?: string; title?: string }[] | null;
};

type ClaudeResponse = {
  content?: Block[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
};

// Overloaded, rate limited, or a model name this key cannot use: try the next model.
const SKIP = new Set([404, 429, 500, 502, 503, 504, 529]);

// Vercel variable names are case sensitive, so a differently capitalised name is accepted too.
function claudeKey(): string | undefined {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const name = Object.keys(process.env).find((k) => k.toUpperCase() === "ANTHROPIC_API_KEY");
  return name ? process.env[name] : undefined;
}

export const hasClaudeKey = () => Boolean(claudeKey());

async function callModel(
  model: string,
  key: string,
  system: string,
  contents: ChatContent[],
  search: boolean,
  timeoutMs: number,
): Promise<{ text: string; sources: Source[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: contents.map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: c.parts[0].text })),
        ...(search ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } : {}),
      }),
    });
    const data = (await r.json().catch(() => ({}))) as ClaudeResponse;
    const message = data.error?.message;
    if (r.status === 401 || r.status === 403) {
      throw new HttpError(502, "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Vercel.", "CLAUDE_BAD_KEY");
    }
    if (SKIP.has(r.status)) {
      throw new HttpError(r.status === 429 ? 429 : 503, message ?? "Claude is busy.", "CLAUDE_BUSY");
    }
    if (r.status === 400) {
      // A refused web-search tool is retried without it. Other 400s (such as a low credit balance) are shown as they are.
      throw new HttpError(502, message ?? "Anthropic rejected the request.", search ? "CLAUDE_BAD_REQUEST" : undefined);
    }
    if (!r.ok) throw new HttpError(502, message ?? "Claude could not answer.");

    const blocks = data.content ?? [];
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    if (!text) throw new HttpError(422, "Claude returned nothing. Try rephrasing.");

    const seen = new Set<string>();
    const sources: Source[] = [];
    const add = (url?: string, title?: string) => {
      if (url && /^https:\/\//i.test(url) && !seen.has(url) && sources.length < 8) {
        seen.add(url);
        sources.push({ title: (title || url).slice(0, 120), url });
      }
    };
    for (const b of blocks) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const item of b.content as { url?: string; title?: string }[]) add(item.url, item.title);
      }
      for (const c of b.citations ?? []) add(c.url, c.title);
    }
    return { text, sources };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "Claude took too long.", "CLAUDE_BUSY");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Reads a PDF with Claude and returns its raw text answer. Used for statement import, where the answer is JSON.
// Sonnet first for accuracy on the numbers, Haiku as a faster fallback when Sonnet is busy or slow.
export async function askClaudeAboutPdf(opts: { system: string; prompt: string; pdf: Buffer }): Promise<string> {
  const key = claudeKey();
  if (!key) {
    throw new HttpError(
      503,
      "PDF reading needs an Anthropic API key. Add ANTHROPIC_API_KEY in Vercel's project settings.",
      "CLAUDE_NOT_CONFIGURED",
    );
  }
  const data = opts.pdf.toString("base64");
  const deadline = Date.now() + 170_000;
  const errors: string[] = [];
  for (const [i, model] of ["claude-sonnet-5", "claude-haiku-4-5-20251001"].entries()) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break;
    // The first model may use up to 110 seconds, so the fallback still has time.
    const timeoutMs = i === 0 ? Math.min(remaining, 110_000) : remaining;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          system: opts.system,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
                { type: "text", text: opts.prompt },
              ],
            },
          ],
        }),
      });
      const body = (await r.json().catch(() => ({}))) as ClaudeResponse;
      const message = body.error?.message;
      if (r.status === 401 || r.status === 403) {
        throw new HttpError(502, "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Vercel.", "CLAUDE_BAD_KEY");
      }
      if (SKIP.has(r.status)) {
        errors.push(`${model}: ${(message ?? `status ${r.status}`).slice(0, 160)}`);
        continue;
      }
      if (r.status === 400 || r.status === 413) {
        throw new HttpError(
          502,
          `Claude could not read that PDF: ${message ?? "the request was rejected"}. Check that it is not password protected.`,
        );
      }
      if (!r.ok) throw new HttpError(502, message ?? "Claude could not read that PDF.");
      const text = (body.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      if (body.stop_reason === "max_tokens") {
        throw new HttpError(422, "That statement is too long to read in one go. Try a smaller PDF, or use a CSV.");
      }
      if (!text) throw new HttpError(422, "Claude returned nothing. Try again, or use a CSV.");
      return text;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        errors.push(`${model}: took too long`);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(
    503,
    `Claude is busy right now. ${errors.join(" | ")}. Wait a minute and try again.`,
    "CLAUDE_BUSY",
  );
}

export async function askClaude(opts: {
  system: string;
  contents: ChatContent[];
  model: string | null;
  search: boolean;
}): Promise<{ text: string; sources: Source[]; model: string; searched: boolean }> {
  const key = claudeKey();
  if (!key) {
    throw new HttpError(
      503,
      "Claude needs an Anthropic API key. Add ANTHROPIC_API_KEY in Vercel's project settings.",
      "CLAUDE_NOT_CONFIGURED",
    );
  }
  if (opts.model && !CLAUDE_MODELS.some((m) => m.id === opts.model)) {
    throw new HttpError(400, "That Claude model is not offered here.");
  }
  // The chosen model first, then the fastest one as a fallback when it is busy.
  const order = [...new Set([opts.model ?? CLAUDE_MODELS[0].id, "claude-haiku-4-5-20251001"])];
  const deadline = Date.now() + 54_000;
  const errors: string[] = [];
  for (const model of order) {
    const remaining = deadline - Date.now();
    if (remaining < 8_000) break;
    try {
      try {
        const r = await callModel(model, key, opts.system, opts.contents, opts.search, remaining);
        return { ...r, model, searched: opts.search };
      } catch (error) {
        if (opts.search && error instanceof HttpError && error.code === "CLAUDE_BAD_REQUEST") {
          const r = await callModel(model, key, opts.system, opts.contents, false, deadline - Date.now());
          return { ...r, model, searched: false };
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof HttpError && error.code === "CLAUDE_BUSY") {
        errors.push(`${model}: ${error.message.slice(0, 160)}`);
        continue;
      }
      throw error;
    }
  }
  throw new HttpError(
    503,
    `Claude is busy right now. ${errors.join(" | ")}. Wait a minute and try again.`,
    "CLAUDE_BUSY",
  );
}

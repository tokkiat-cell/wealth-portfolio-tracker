import { HttpError } from "./http";
import type { GeminiContent } from "./gemini";

// OpenRouter (openrouter.ai) gives one key and one API for many models. Only its free models are allowed
// here: the list is read from OpenRouter itself, so it stays current as models come and go.

export type FreeModel = { id: string; name: string; contextLength: number };

type ModelsResponse = {
  data?: {
    id?: string;
    name?: string;
    context_length?: number;
    pricing?: { prompt?: string; completion?: string; request?: string };
    architecture?: { output_modalities?: string[] };
  }[];
};

type ChatResponse = {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string; code?: number | string };
};

let cache: { at: number; models: FreeModel[] } | null = null;
const TTL_MS = 10 * 60_000;

const isZero = (v: string | undefined) => v != null && Number(v) === 0;

// Vercel variable names are case sensitive, so a name typed as OpenRouter_API_Key is accepted too.
function openRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const name = Object.keys(process.env).find((k) => k.toUpperCase() === "OPENROUTER_API_KEY");
  return name ? process.env[name] : undefined;
}

export function hasOpenRouterKey(): boolean {
  return Boolean(openRouterKey());
}

export async function listFreeModels(): Promise<FreeModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const r = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal })
    .catch(() => null)
    .finally(() => clearTimeout(timer));
  if (!r || !r.ok) {
    if (cache) return cache.models;
    throw new HttpError(503, "Could not load OpenRouter's model list. Try again in a minute.", "OPENROUTER_BUSY");
  }
  const body = (await r.json().catch(() => ({}))) as ModelsResponse;
  const models = (body.data ?? [])
    .filter(
      (m) =>
        m.id &&
        isZero(m.pricing?.prompt) &&
        isZero(m.pricing?.completion) &&
        (m.pricing?.request == null || isZero(m.pricing.request)) &&
        // Router aliases and image/audio generators are not chat models.
        !m.id.startsWith("openrouter/") &&
        (m.architecture?.output_modalities ?? ["text"]).join() === "text",
    )
    .map((m) => ({ id: m.id as string, name: (m.name || m.id) as string, contextLength: m.context_length ?? 0 }))
    .sort((a, b) => b.contextLength - a.contextLength || a.name.localeCompare(b.name));
  cache = { at: Date.now(), models };
  return models;
}

async function callModel(
  model: string,
  key: string,
  contents: GeminiContent[],
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "X-Title": "Wealth Portfolio Tracker",
      },
      body: JSON.stringify({
        model,
        messages: contents.map((c) => ({ role: c.role === "model" ? "assistant" : "user", content: c.parts[0].text })),
        temperature: 0.3,
        max_tokens: 3000,
      }),
    });
    const data = (await r.json().catch(() => ({}))) as ChatResponse;
    if (r.status === 401) {
      throw new HttpError(502, "OpenRouter rejected the API key. Check OPENROUTER_API_KEY in Vercel.", "OPENROUTER_BAD_KEY");
    }
    if (!r.ok || data.error) {
      const message = data.error?.message ?? `OpenRouter returned ${r.status}.`;
      const hint = /data policy|privacy/i.test(message)
        ? " In openrouter.ai/settings/privacy, allow free models to be used, or pick a different model."
        : "";
      throw new HttpError(503, message + hint, "OPENROUTER_BUSY");
    }
    const text = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!text) throw new HttpError(503, `${model} returned nothing.`, "OPENROUTER_BUSY");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, `${model} took too long.`, "OPENROUTER_BUSY");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Tries the chosen free model, then the next free ones, within the function's 60 second limit.
// Free models are often rate limited, so a fallback is normal.
export async function askOpenRouter(opts: {
  system: string;
  contents: GeminiContent[];
  model: string | null;
}): Promise<{ text: string; model: string }> {
  const key = openRouterKey();
  if (!key) {
    throw new HttpError(
      503,
      "OpenRouter needs an API key. Add OPENROUTER_API_KEY in Vercel's project settings.",
      "OPENROUTER_NOT_CONFIGURED",
    );
  }
  const free = await listFreeModels();
  if (free.length === 0) throw new HttpError(503, "OpenRouter lists no free models right now.", "OPENROUTER_BUSY");
  if (opts.model && !free.some((m) => m.id === opts.model)) {
    throw new HttpError(400, "That model is not on OpenRouter's free list.");
  }
  const order = [...new Set([opts.model ?? free[0].id, ...free.slice(0, 6).map((m) => m.id)])].slice(0, 3);

  // Some free models refuse a separate system message, so the instructions go at the front of the first turn.
  const contents = opts.contents.map((c, i) =>
    i === 0 ? { ...c, parts: [{ text: `${opts.system}\n\n---\nConversation starts here.\n\n${c.parts[0].text}` }] } : c,
  );

  const deadline = Date.now() + 54_000;
  let last: HttpError | null = null;
  for (const model of order) {
    const remaining = deadline - Date.now();
    if (remaining < 8_000) break;
    try {
      const text = await callModel(model, key, contents, Math.min(remaining, 28_000));
      return { text, model };
    } catch (error) {
      if (error instanceof HttpError && error.code === "OPENROUTER_BUSY") {
        last = error;
        continue;
      }
      throw error;
    }
  }
  throw new HttpError(
    503,
    `The free models are busy right now${last ? ` (${last.message})` : ""}. Wait a minute, or pick another model.`,
    "OPENROUTER_BUSY",
  );
}

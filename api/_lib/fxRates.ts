// Live exchange rates from Frankfurter (frankfurter.dev), an open-source rate service backed by
// central banks. No key needed. Used to keep the fx_rates table current without manual entry.

type FrankfurterRow = { date?: string; base?: string; quote?: string; rate?: number };

export async function fetchLiveRates(currencies: string[]): Promise<Record<string, number>> {
  const list = [...new Set(currencies.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c) && c !== "SGD"))];
  if (list.length === 0) return {};

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://api.frankfurter.dev/v2/rates?base=SGD&quotes=${encodeURIComponent(list.join(","))}`;
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) return {};
    const data = (await r.json().catch(() => null)) as FrankfurterRow[] | null;
    if (!Array.isArray(data)) return {};

    // Frankfurter quotes "1 SGD = rate x quote"; the app stores the inverse (SGD per 1 unit).
    const rates: Record<string, number> = {};
    for (const row of data) {
      if (row.quote && typeof row.rate === "number" && row.rate > 0) {
        rates[row.quote] = Math.round((1 / row.rate) * 1e6) / 1e6;
      }
    }
    return rates;
  } catch {
    // Best-effort: a network hiccup here should never block an import.
    return {};
  } finally {
    clearTimeout(timer);
  }
}

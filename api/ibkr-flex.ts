import { DatabaseNotConfigured, ensureSchema } from "./_lib/db";
import { HttpError, Req, Res, assertSameOrigin, fail, send } from "./_lib/http";
import { fetchFlexXml, flexConfigured, parseFlex } from "./_lib/ibkrFlex";
import { requireUser } from "./_lib/session";

// Pulls the latest IBKR positions and cash through a read-only Flex Query and returns them for review.
// Nothing is saved here: the browser shows the result and the user confirms the import.

export default async function handler(req: Req, res: Res) {
  try {
    await ensureSchema();
    await requireUser(req);
    if (req.method === "GET") return send(res, 200, { configured: flexConfigured() });
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    assertSameOrigin(req);

    const xml = await fetchFlexXml();
    return send(res, 200, parseFlex(xml));
  } catch (error) {
    if (error instanceof DatabaseNotConfigured) return fail(res, 503, error.message, "DATABASE_NOT_CONFIGURED");
    if (error instanceof HttpError) return fail(res, error.status, error.message, error.code);
    console.error("ibkr flex error:", error instanceof Error ? error.name : "unknown");
    return fail(res, 500, "Could not fetch from IBKR.");
  }
}

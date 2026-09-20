import type { IncomingMessage, ServerResponse } from "http";

export type Req = IncomingMessage;
export type Res = ServerResponse;

export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function send(res: Res, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export function fail(res: Res, status: number, error: string, code?: string) {
  send(res, status, { error, code });
}

// Reads the raw request body, refusing anything over the limit.
export async function readBody(req: Req, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new HttpError(413, "That file is too large.");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) throw new HttpError(413, "That file is too large.");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: Req, limit = 2 * 1024 * 1024): Promise<unknown> {
  const raw = (await readBody(req, limit)).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "The request was not valid JSON.");
  }
}

// Blocks cross-site form posts: a browser always sends Origin on POST.
export function assertSameOrigin(req: Req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = "";
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Bad origin.");
  }
  if (host !== req.headers.host) throw new HttpError(403, "Bad origin.");
}

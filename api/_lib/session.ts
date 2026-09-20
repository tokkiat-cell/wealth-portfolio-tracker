import { createHmac, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { getDb, getSigningSecret, guardDb } from "./db";
import type { Req } from "./http";
import { HttpError } from "./http";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export const COOKIE_NAME = "wpt_session";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(":");
  if (!saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

async function sign(payload: string): Promise<string> {
  const secret = await getSigningSecret();
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function makeToken(userId: number): Promise<string> {
  const payload = b64(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS }));
  return `${payload}.${await sign(payload)}`;
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readCookie(req: Req, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export type SessionUser = { id: number; email: string; displayName: string };

// Returns the signed-in user, or null. A stuck database connection ends in a quick error, not a hang.
export function readSession(req: Req): Promise<SessionUser | null> {
  return guardDb(() => readSessionUnguarded(req));
}

async function readSessionUnguarded(req: Req): Promise<SessionUser | null> {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = await sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data: { uid?: number; exp?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data.uid || !data.exp || data.exp < Date.now() / 1000) return null;
  const rows = await getDb()<{ id: number; email: string; display_name: string }[]>`
    SELECT id, email, display_name FROM wpt.users WHERE id = ${data.uid}`;
  if (rows.length === 0) return null;
  return { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name };
}

export async function requireUser(req: Req): Promise<SessionUser> {
  const user = await readSession(req);
  if (!user) throw new HttpError(401, "Not signed in");
  return user;
}

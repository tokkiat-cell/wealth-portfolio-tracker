import { z } from "zod";
import { DatabaseNotConfigured, ensureSchema, getDb } from "./_lib/db";
import { HttpError, Req, Res, assertSameOrigin, fail, readJson, send } from "./_lib/http";
import {
  clearedCookie,
  hashPassword,
  makeToken,
  readSession,
  sessionCookie,
  verifyPassword,
} from "./_lib/session";

const emailSchema = z.string().trim().toLowerCase().email().max(200);

const loginSchema = z.object({
  action: z.literal("login"),
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const registerSchema = z.object({
  action: z.literal("register"),
  email: emailSchema,
  displayName: z.string().trim().min(1).max(80),
  password: z
    .string()
    .min(10, "Use at least 10 characters")
    .max(200)
    .regex(/[a-z]/, "Add a lower-case letter")
    .regex(/[A-Z]/, "Add an upper-case letter")
    .regex(/\d/, "Add a number"),
});

const bodySchema = z.union([loginSchema, registerSchema, z.object({ action: z.literal("logout") })]);

class RegistrationClosed extends Error {}

const WINDOW_MINUTES = 15;
const MAX_FAILURES = 8;

export default async function handler(req: Req, res: Res) {
  try {
    await ensureSchema();
    const sql = getDb();

    if (req.method === "GET") {
      const user = await readSession(req);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wpt.users`;
      return send(res, 200, { user, canRegister: n === 0 });
    }
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    assertSameOrigin(req);

    const parsed = bodySchema.safeParse(await readJson(req, 20_000));
    if (!parsed.success) {
      return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid request");
    }
    const body = parsed.data;

    if (body.action === "logout") {
      res.setHeader("Set-Cookie", clearedCookie());
      return send(res, 200, { ok: true });
    }

    if (body.action === "login") {
      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM wpt.login_attempts
        WHERE email = ${body.email} AND success = false
          AND attempted_at > now() - make_interval(mins => ${WINDOW_MINUTES})`;
      if (n >= MAX_FAILURES) {
        return fail(res, 429, "Too many failed sign-ins. Wait 15 minutes and try again.");
      }
      const rows = await sql<{ id: number; email: string; display_name: string; password_hash: string }[]>`
        SELECT id, email, display_name, password_hash FROM wpt.users WHERE email = ${body.email}`;
      const ok = rows.length > 0 && (await verifyPassword(body.password, rows[0].password_hash));
      await sql`INSERT INTO wpt.login_attempts (email, success) VALUES (${body.email}, ${ok})`;
      if (!ok) return fail(res, 401, "Wrong email or password.");
      res.setHeader("Set-Cookie", sessionCookie(await makeToken(rows[0].id)));
      return send(res, 200, {
        user: { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name },
      });
    }

    // register: only while no account exists (the owner).
    const passwordHash = await hashPassword(body.password);
    const user = await sql.begin(async (tx) => {
      await tx`LOCK TABLE wpt.users IN EXCLUSIVE MODE`;
      const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM wpt.users`;
      if (n > 0) throw new RegistrationClosed();
      const [row] = await tx<{ id: number; email: string; display_name: string }[]>`
        INSERT INTO wpt.users (email, display_name, password_hash)
        VALUES (${body.email}, ${body.displayName}, ${passwordHash})
        RETURNING id, email, display_name`;
      return row;
    });
    res.setHeader("Set-Cookie", sessionCookie(await makeToken(user.id)));
    return send(res, 200, {
      user: { id: user.id, email: user.email, displayName: user.display_name },
    });
  } catch (error) {
    if (error instanceof RegistrationClosed) return fail(res, 403, "Registration is closed.");
    if (error instanceof DatabaseNotConfigured) {
      return fail(res, 503, error.message, "DATABASE_NOT_CONFIGURED");
    }
    if (error instanceof HttpError) return fail(res, error.status, error.message, error.code);
    console.error("auth error:", error);
    return fail(res, 500, "Something went wrong.");
  }
}

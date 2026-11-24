import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { withTransaction } from "../db/pool.js";
import { loadAuthUser, requireAuth } from "../http/context.js";
import { badRequest, forbidden, parse, unauthorized } from "../http/errors.js";
import {
  hashPassword,
  hashToken,
  issueRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshFamily,
  rotateRefreshToken,
  signAccessToken,
  verifyPassword,
} from "./service.js";

export const MIN_PASSWORD_LENGTH = 8;
// bcrypt ignores everything past 72 bytes.
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH)
  .refine((v) => Buffer.byteLength(v) <= 72, "Password is too long");
const password = newPasswordSchema;
const CSRF_HEADER = "x-requested-with";

const limiter = (limit: number, windowMinutes = 15) =>
  rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many attempts, try again later", code: "rate_limited" },
  });

// Includes the service name because browsers share cookies across localhost ports.
const COOKIE_NAME = `oc_refresh_${config.serviceName}`;
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.isProduction,
  sameSite: config.cookieSameSite,
  path: "/api/auth",
  ...(config.cookieDomain && { domain: config.cookieDomain }),
};

/** Cookie-authenticated routes need a header that a cross-site form cannot send. */
const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (!req.get(CSRF_HEADER)) throw forbidden("Missing X-Requested-With header");
  next();
};

async function sessionBody(req: Request, userId: string) {
  const user = await loadAuthUser(req.db, userId);
  if (!user) throw unauthorized("Account is not available");
  const { rows } = await req.db.query(`SELECT * FROM profiles WHERE id = $1`, [userId]);
  return {
    user: { id: user.id, email: user.email },
    profile: rows[0] ?? null,
    permissions: [...user.permissions].sort(),
  };
}

async function startSession(req: Request, res: Response, userId: string) {
  const body = await sessionBody(req, userId);
  const refresh = await issueRefreshToken(req.db, userId);
  await req.db.query(`UPDATE users SET last_sign_in_at = now() WHERE id = $1`, [userId]);
  res.cookie(COOKIE_NAME, refresh.token, { ...COOKIE_OPTIONS, expires: refresh.expiresAt });
  return {
    access_token: await signAccessToken(userId),
    expires_in: config.accessTokenTtlSeconds,
    ...body,
  };
}

export const authRouter = Router({ mergeParams: true });

authRouter.post("/login", limiter(20), async (req, res) => {
  const input = parse(z.object({ email: z.string().email().max(320), password: z.string().min(1).max(200) }), req.body);
  const { rows } = await req.db.query<{ id: string; password_hash: string | null }>(
    `SELECT id, password_hash FROM users WHERE lower(email) = lower($1)`,
    [input.email]
  );
  const user = rows[0];
  const valid = await verifyPassword(input.password, user?.password_hash);
  if (!user || !valid || !(await loadAuthUser(req.db, user.id))) throw unauthorized("Invalid login credentials");
  res.json(await startSession(req, res, user.id));
});

authRouter.post("/refresh", limiter(120), requireCsrfHeader, async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (!token) throw unauthorized("No active session");

  const result = await withTransaction(req.db, (client) => rotateRefreshToken(client, token));
  if (result.status === "invalid") {
    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
    throw unauthorized("Session expired");
  }
  const body = await sessionBody(req, result.userId);
  if (result.status === "rotated") {
    res.cookie(COOKIE_NAME, result.token, { ...COOKIE_OPTIONS, expires: result.expiresAt });
  }
  res.json({
    access_token: await signAccessToken(result.userId),
    expires_in: config.accessTokenTtlSeconds,
    ...body,
  });
});

authRouter.post("/logout", requireCsrfHeader, async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined;
  if (token) await revokeRefreshFamily(req.db, token);
  res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json(await sessionBody(req, req.user.id));
});

authRouter.post("/verify-password", limiter(20), requireAuth, async (req, res) => {
  const input = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  const { rows } = await req.db.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json({ ok: await verifyPassword(input.password, rows[0]?.password_hash) });
});

authRouter.post("/password", limiter(20), requireAuth, async (req, res) => {
  const input = parse(z.object({ current_password: z.string().min(1).max(200), password }), req.body);
  const { rows } = await req.db.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!(await verifyPassword(input.current_password, rows[0]?.password_hash))) {
    throw badRequest("Current password is incorrect");
  }
  const hash = await hashPassword(input.password);
  await withTransaction(req.db, async (client) => {
    await client.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [hash, req.user.id]);
    await revokeAllRefreshTokens(client, req.user.id);
  });
  // Other devices are signed out. This one continues with a fresh session.
  res.json(await startSession(req, res, req.user.id));
});

authRouter.post("/token/verify", limiter(30), async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  const { rows } = await req.db.query<{ type: string; email: string; user_id: string }>(
    `SELECT t.type, u.email, t.user_id FROM auth_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [hashToken(token)]
  );
  const link = rows[0];
  if (!link || !(await loadAuthUser(req.db, link.user_id))) throw badRequest("Link is invalid or has expired");
  res.json({ type: link.type, email: link.email });
});

authRouter.post("/token/accept", limiter(20), async (req, res) => {
  const input = parse(z.object({ token: z.string().min(20).max(200), password }), req.body);
  const hash = await hashPassword(input.password);
  const userId = await withTransaction(req.db, async (client) => {
    // The UPDATE is atomic, so a link can only ever be used once.
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE auth_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashToken(input.token)]
    );
    const id = rows[0]?.user_id;
    // Throwing rolls back, so a blocked account's link is not consumed or its password changed.
    if (!id || !(await loadAuthUser(client, id))) throw badRequest("Link is invalid or has expired");
    await client.query(
      `UPDATE users SET password_hash = $1, email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
       WHERE id = $2`,
      [hash, id]
    );
    await revokeAllRefreshTokens(client, id);
    return id;
  });
  res.json(await startSession(req, res, userId));
});

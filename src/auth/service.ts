import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { SignJWT } from "jose";
import { config } from "../config.js";
import { JWT_ISSUER } from "../http/context.js";

const BCRYPT_ROUNDS = 10;
const REFRESH_REUSE_GRACE_MS = 10_000;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_TTL_MS = 60 * 60 * 1000;
// Compared when the email is unknown, so response time doesn't reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), BCRYPT_ROUNDS);

type Queryable = pg.Pool | pg.PoolClient;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_ROUNDS);

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const matched = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return Boolean(hash) && matched;
}

export function signAccessToken(userId: string): Promise<string> {
  return new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(config.serviceName)
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(config.jwtSecret);
}

export async function issueRefreshToken(db: Queryable, userId: string, familyId: string = randomUUID()) {
  const token = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), familyId, expiresAt]
  );
  return { token, expiresAt };
}

export type RefreshResult =
  | { status: "rotated"; userId: string; token: string; expiresAt: Date }
  | { status: "grace"; userId: string }
  | { status: "invalid" };

/** Rotates a refresh token. Replaying an old token revokes its whole session family. */
export async function rotateRefreshToken(client: pg.PoolClient, token: string): Promise<RefreshResult> {
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    family_id: string;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, user_id, family_id, expires_at, revoked_at FROM refresh_tokens
     WHERE token_hash = $1 FOR UPDATE`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row || row.expires_at <= new Date()) return { status: "invalid" };

  if (row.revoked_at) {
    // Two tabs can refresh at once with the same cookie. That isn't token theft.
    if (Date.now() - row.revoked_at.getTime() < REFRESH_REUSE_GRACE_MS) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [row.family_id]
      );
      if (rowCount) return { status: "grace", userId: row.user_id };
      return { status: "invalid" };
    }
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [row.family_id]
    );
    return { status: "invalid" };
  }

  await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
  const next = await issueRefreshToken(client, row.user_id, row.family_id);
  return { status: "rotated", userId: row.user_id, token: next.token, expiresAt: next.expiresAt };
}

export async function revokeRefreshFamily(db: Queryable, token: string): Promise<void> {
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE revoked_at IS NULL AND family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
    [hashToken(token)]
  );
}

export async function revokeAllRefreshTokens(db: Queryable, userId: string): Promise<void> {
  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}

/** Creates a single-use link, replacing any earlier unused link of the same type. */
export async function createAuthLink(
  db: Queryable,
  userId: string,
  type: "invite" | "recovery"
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const ttl = type === "invite" ? INVITE_TTL_MS : RECOVERY_TTL_MS;
  await db.query(
    `UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND type = $2 AND used_at IS NULL`,
    [userId, type]
  );
  await db.query(
    `INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, type, hashToken(token), new Date(Date.now() + ttl)]
  );
  // In the fragment, so the token never reaches web server access logs.
  return `${config.siteUrl.replace(/\/$/, "")}/auth/callback#type=${type}&token=${token}`;
}

export interface NewUser {
  email: string;
  password?: string;
  fullName?: string;
  department?: string;
  position?: string;
  invited?: boolean;
}

/** Replaces Supabase's handle_new_user trigger: user, profile, and default role together. */
export async function createUserWithProfile(client: pg.PoolClient, input: NewUser) {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const { rows } = await client.query<{ id: string; email: string }>(
    `INSERT INTO users (email, password_hash, email_confirmed_at, invited_at, metadata)
     VALUES ($1, $2, CASE WHEN $3 THEN NULL ELSE now() END, CASE WHEN $3 THEN now() END, $4)
     RETURNING id, email`,
    [input.email, passwordHash, Boolean(input.invited), JSON.stringify({ full_name: input.fullName ?? "" })]
  );
  const user = rows[0]!;
  await client.query(
    `INSERT INTO profiles (id, email, full_name, avatar_url, department, position)
     VALUES ($1, $2, $3, '', $4, $5)`,
    [user.id, user.email, input.fullName ?? "", input.department ?? null, input.position ?? null]
  );
  await client.query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'member'`,
    [user.id]
  );
  return user;
}

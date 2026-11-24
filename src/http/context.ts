import type { NextFunction, Request, RequestHandler, Response } from "express";
import type pg from "pg";
import { jwtVerify } from "jose";
import { config } from "../config.js";
import { getPool } from "../db/pool.js";
import { forbidden, unauthorized } from "./errors.js";

export interface AuthUser {
  id: string;
  email: string;
  permissions: Set<string>;
  isSuperAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      db: pg.Pool;
      user: AuthUser;
    }
  }
}

export const JWT_ISSUER = "oc-pg-api";

/** Attaches this service's database to the request. */
export function dbContext(req: Request, _res: Response, next: NextFunction): void {
  req.db = getPool();
  next();
}

/** Returns null for a missing, banned, inactive or suspended account. */
export async function loadAuthUser(db: pg.Pool | pg.PoolClient, userId: string): Promise<AuthUser | null> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    permissions: string[];
    is_super_admin: boolean;
  }>(
    `SELECT u.id, u.email,
       COALESCE(ARRAY(
         SELECT DISTINCT p.name FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = u.id), '{}') AS permissions,
       EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = u.id AND r.name = 'super_admin') AS is_super_admin
     FROM users u
     WHERE u.id = $1 AND (u.banned_until IS NULL OR u.banned_until <= now())
       AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = u.id AND p.status <> 'active')`,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    permissions: new Set(row.permissions),
    isSuperAdmin: row.is_super_admin,
  };
}

/** Verifies the access token and reloads permissions, so revocations apply immediately. */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token) throw unauthorized("Missing bearer token");

  let userId: string | undefined;
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, {
      issuer: JWT_ISSUER,
      audience: config.serviceName,
      algorithms: ["HS256"],
    });
    if (payload.typ === "access") userId = payload.sub;
  } catch {
    throw unauthorized("Invalid or expired token");
  }
  if (!userId) throw unauthorized("Invalid token");

  const user = await loadAuthUser(req.db, userId);
  if (!user) throw unauthorized("Invalid token");
  req.user = user;
  next();
};

/** Allows the request if the user holds at least one of the permissions. */
export function requirePermission(...permissions: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!permissions.some((p) => req.user.permissions.has(p))) {
      throw forbidden(`Missing permission: ${permissions.join(" or ")}`);
    }
    next();
  };
}

export const hasPermission = (req: Request, permission: string) => req.user.permissions.has(permission);

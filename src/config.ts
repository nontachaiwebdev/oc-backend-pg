import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const blank = (v: unknown) => (v === "" ? undefined : v);
const optional = z.preprocess(blank, z.string().optional());

// One running service serves one frontend, with one database and one storage container.
const env = z
  .object({
    // Required: a default of development would silently weaken cookies and the JWT secret.
    NODE_ENV: z.enum(["development", "test", "production"]),
    PORT: z.coerce.number().default(4000),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    SERVICE_NAME: z.string().regex(/^[a-z0-9-]+$/, "use lowercase letters, numbers and hyphens"),
    KNOWLEDGE_BASE_NAME: z.string().min(1).max(100).regex(/^[^{}]+$/, "must not contain braces"),
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: optional,
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    COOKIE_DOMAIN: optional,
    COOKIE_SAME_SITE: z.preprocess(blank, z.enum(["lax", "strict", "none"]).default("lax")),
    REINDEX_NIGHTLY_TIME: z.preprocess(
      blank,
      z.string().regex(/^(off|([01]\d|2[0-3]):[0-5]\d)$/, "use HH:MM or off").optional()
    ),
    SITE_URL: z.preprocess(blank, z.string().default("http://localhost:5173")),
    AZURE_STORAGE_CONNECTION_STRING: optional,
    AZURE_STORAGE_CONTAINER: z.preprocess(blank, z.string().default("knowledge-base")),
    AZURE_COMMUNICATION_CONNECTION_STRING: optional,
    MAIL_FROM_ADDRESS: optional,
    MAIL_FROM_NAME: optional,
  })
  .parse(process.env);

const isProduction = env.NODE_ENV === "production";

if (isProduction && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must be at least 32 characters in production");
}
if (isProduction) {
  // Their defaults point at localhost, which would break logins and emailed links.
  for (const name of ["CORS_ORIGINS", "SITE_URL"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required in production`);
  }
}
if (env.COOKIE_SAME_SITE === "none" && !isProduction) {
  throw new Error("COOKIE_SAME_SITE=none needs a Secure cookie, so it only works in production");
}
if (!env.JWT_SECRET) {
  console.warn("JWT_SECRET is blank: using a temporary secret, so logins reset on restart");
}

export const config = {
  isProduction,
  port: env.PORT,
  trustProxy: env.TRUST_PROXY,
  /** Identifies this deployment in tokens and cookies. */
  serviceName: env.SERVICE_NAME,
  /** Name used in AI prompts and sync logs. */
  knowledgeBaseName: env.KNOWLEDGE_BASE_NAME,
  corsOrigins: env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  jwtSecret: new TextEncoder().encode(env.JWT_SECRET ?? randomBytes(48).toString("hex")),
  accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  cookieDomain: env.COOKIE_DOMAIN,
  cookieSameSite: env.COOKIE_SAME_SITE,
  /** HH:MM in Stockholm time, or null when off. On at 04:00 by default only in production. */
  reindexNightlyTime:
    (env.REINDEX_NIGHTLY_TIME ?? (isProduction ? "04:00" : "off")) === "off"
      ? null
      : (env.REINDEX_NIGHTLY_TIME ?? "04:00"),
  databaseUrl: env.DATABASE_URL,
  siteUrl: env.SITE_URL,
  storage: {
    connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
    container: env.AZURE_STORAGE_CONTAINER,
  },
  mail: {
    connectionString: env.AZURE_COMMUNICATION_CONNECTION_STRING,
    fromAddress: env.MAIL_FROM_ADDRESS,
    fromName: env.MAIL_FROM_NAME,
  },
};

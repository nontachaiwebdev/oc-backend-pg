import { randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { signAccessToken } from "./auth/service.js";
import { config } from "./config.js";
import { closePool, getPool } from "./db/pool.js";

// End-to-end check against a running API and local seeded data.
// Creates one temporary user through the API, then deletes it.

const BASE = process.argv[2] ?? `http://127.0.0.1:${config.port}`;
const ORIGIN = config.corsOrigins[0] ?? "http://localhost:5173";
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail === undefined ? "" : `: ${String(detail)}`}`);
  }
}

async function smoke() {
  const api = `${BASE}/api`;
  const db = getPool();
  const admin = (await db.query<{ user_id: string }>(
    `SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.name = 'super_admin' LIMIT 1`
  )).rows[0];
  if (!admin) throw new Error("no super_admin");
  const token = await signAccessToken(admin.user_id);
  const auth = { Authorization: `Bearer ${token}` };
  const json = { ...auth, "Content-Type": "application/json" };

  const preflight = await fetch(`${api}/users`, {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
  });
  check(`CORS allows frontend`, preflight.headers.get("access-control-allow-origin") === ORIGIN);
  check(`CORS credentials`, preflight.headers.get("access-control-allow-credentials") === "true");
  const foreign = await fetch(`${api}/users`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
  check(`CORS rejects other origin`, !foreign.headers.get("access-control-allow-origin"));
  check(`no token is 401`, (await fetch(`${api}/users`)).status === 401);

  const crossToken = await new SignJWT({ typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("oc-pg-api")
    .setAudience("another-service")
    .setSubject(admin.user_id)
    .setExpirationTime("5m")
    .sign(config.jwtSecret);
  check("token for another service is 401",
    (await fetch(`${api}/users`, { headers: { Authorization: `Bearer ${crossToken}` } })).status === 401);

  const year = new Date().getFullYear();
  const group = (await db.query<{ id: string }>(`SELECT id FROM file_groups WHERE is_default LIMIT 1`)).rows[0];
  for (const path of ["/users", "/roles", "/groups", `/files?group_id=${group?.id}`, "/file-groups", "/templates", "/faq", "/faq/sections",
    "/faq/items", `/activities?year=${year}`, "/activities/types", "/activities/manage", "/sync-logs", "/chat/sessions"]) {
    const res = await fetch(`${api}${path}`, { headers: auth });
    check(`GET ${path}`, res.status === 200, res.status);
    await res.arrayBuffer();
  }

  const file = (await db.query<{ id: string; size_bytes: number }>(
    `SELECT id, size_bytes FROM files WHERE NOT is_directory AND name ILIKE '%.docx' AND size_bytes > 0 ORDER BY size_bytes LIMIT 1`
  )).rows[0];
  if (file) {
    const res = await fetch(`${api}/files/${file.id}/content`, { headers: auth });
    const bytes = new Uint8Array(await res.arrayBuffer());
    check(`seeded file downloads`, res.status === 200, res.status);
    check(`seeded file size`, bytes.length === Number(file.size_bytes), bytes.length);
    check(`seeded file is a docx`, bytes[0] === 0x50 && bytes[1] === 0x4b);
  }

  const email = `smoke-${randomBytes(6).toString("hex")}@example.invalid`;
  const password = `Sm0ke-${randomBytes(9).toString("hex")}`;
  const created = await fetch(`${api}/users`, {
    method: "POST", headers: json, body: JSON.stringify({ email, password, full_name: "Smoke Test" }),
  });
  const createdBody = (await created.json()) as { user?: { id: string } };
  const userId = createdBody.user?.id;
  check(`create user`, created.status === 201 && Boolean(userId), created.status);
  if (!userId) return;

  try {
    const bad = await fetch(`${api}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "wrong-password" }),
    });
    check(`wrong password is 401`, bad.status === 401, bad.status);

    const login = await fetch(`${api}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
    });
    const session = (await login.json()) as { access_token?: string; permissions?: string[]; password_hash?: unknown };
    const cookie = login.headers.get("set-cookie") ?? "";
    check(`login`, login.status === 200 && Boolean(session.access_token), login.status);
    check(`refresh cookie is httpOnly`, /HttpOnly/i.test(cookie));
    check(`login gets member permissions`, session.permissions?.includes("send_chat") === true);
    const member = { Authorization: `Bearer ${session.access_token}` };
    check(`/auth/me`, (await fetch(`${api}/auth/me`, { headers: member })).status === 200);
    check(`member cannot create users`, (await fetch(`${api}/users`, {
      method: "POST", headers: { ...member, "Content-Type": "application/json" }, body: "{}",
    })).status === 403);

    const pair = cookie.split(";")[0]!;
    check(`refresh needs CSRF header`, (await fetch(`${api}/auth/refresh`, { method: "POST", headers: { Cookie: pair } })).status === 403);
    const refreshed = await fetch(`${api}/auth/refresh`, { method: "POST", headers: { Cookie: pair, "X-Requested-With": "oc-app" } });
    check(`refresh`, refreshed.status === 200, refreshed.status);
    const nextPair = (refreshed.headers.get("set-cookie") ?? "").split(";")[0]!;
    check(`refresh rotates token`, Boolean(nextPair) && nextPair !== pair);
    const out = await fetch(`${api}/auth/logout`, { method: "POST", headers: { Cookie: nextPair, "X-Requested-With": "oc-app" } });
    check(`logout`, out.status === 204, out.status);
    check(`refresh fails after logout`, (await fetch(`${api}/auth/refresh`, {
      method: "POST", headers: { Cookie: nextPair, "X-Requested-With": "oc-app" },
    })).status === 401);
  } finally {
    const removed = await fetch(`${api}/users/${userId}`, { method: "DELETE", headers: auth });
    check(`delete user`, removed.status === 200, removed.status);
  }
}

try {
  await smoke();
} finally {
  await closePool();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

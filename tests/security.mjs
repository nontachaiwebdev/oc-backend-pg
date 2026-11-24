import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import pg from "pg";

// Run through `npm test`, which provides the temporary database and server.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DATABASE_URL?.endsWith("/oc_test_security")) throw new Error("refusing: not the test database");
const BASE = "http://127.0.0.1:4099";
const api = `${BASE}/api`;
const PASSWORD = "Fixture-pass-123";
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}`);
  }
};

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const perms = ["view_chat", "send_chat", "manage_chat", "manage_users", "manage_roles", "manage_settings", "manage_files",
  "manage_file_access", "manage_content_groups", "manage_groups", "manage_faq", "view_faq", "manage_activities",
  "view_sync_logs", "draft_documents"];
const permId = {};
for (const name of perms) permId[name] = (await one(`INSERT INTO permissions (name) VALUES ($1) RETURNING id`, [name])).id;
const roleId = {};
const roleDef = {
  super_admin: perms,
  admin: perms.filter((p) => !["manage_roles", "manage_settings", "manage_file_access", "view_sync_logs"].includes(p)),
  manager: ["view_chat", "send_chat", "manage_chat", "view_faq"],
  member: ["view_chat", "send_chat", "view_faq"],
  custom_high: ["manage_roles"],
};
for (const [name, list] of Object.entries(roleDef)) {
  roleId[name] = (await one(`INSERT INTO roles (name) VALUES ($1) RETURNING id`, [name])).id;
  for (const p of list) await db.query(`INSERT INTO role_permissions VALUES ($1, $2)`, [roleId[name], permId[p]]);
}
await db.query(readFileSync(`${ROOT}/db/migrations/0006_restrict_view_chat.sql`, "utf8"));
const holders = (await db.query(
  `SELECT r.name FROM roles r JOIN role_permissions rp ON rp.role_id=r.id WHERE rp.permission_id=$1 ORDER BY 1`, [permId.view_chat]
)).rows.map((r) => r.name).join(",");
check("view_chat only on admin roles", holders === "admin,super_admin", holders);

const hash = await bcrypt.hash(PASSWORD, 4);
const uid = {};
for (const [key, role] of [["sa", "super_admin"], ["admin", "admin"], ["m1", "member"], ["m2", "member"]]) {
  const email = `${key}@example.invalid`;
  uid[key] = (await one(`INSERT INTO users (email, password_hash, email_confirmed_at) VALUES ($1,$2,now()) RETURNING id`, [email, hash])).id;
  await db.query(`INSERT INTO profiles (id, email) VALUES ($1,$2)`, [uid[key], email]);
  await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)`, [uid[key], roleId[role]]);
}
const group = (await one(`INSERT INTO file_groups (name, is_default) VALUES ('Fixture', true) RETURNING id`)).id;

const login = async (key, password = PASSWORD) => {
  const res = await fetch(`${api}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${key}@example.invalid`, password }),
  });
  const body = await res.json();
  return { status: res.status, token: body.access_token, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
};
const call = async (session, method, path, body) => {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
};

const sa = await login("sa");
const admin = await login("admin");
const m1 = await login("m1");
const m2 = await login("m2");
check("fixtures log in", [sa, admin, m1, m2].every((s) => s.status === 200));

// 1. Chats
const m2Session = (await call(m2, "POST", "/chat/sessions", { title: "private" })).json.session.id;
check("member cannot list all chats", (await call(m1, "GET", "/chat/sessions?all=true")).status === 403);
check("member cannot list another user", (await call(m1, "GET", `/chat/sessions?user_id=${uid.m2}`)).status === 403);
check("member cannot read another chat", (await call(m1, "GET", `/chat/sessions/${m2Session}/messages`)).status === 404);
check("owner reads own chat", (await call(m2, "GET", `/chat/sessions/${m2Session}/messages`)).status === 200);
check("admin can list all chats", (await call(admin, "GET", "/chat/sessions?all=true")).status === 200);

// 2. Files
const upload = async (name, parent) => {
  const q = new URLSearchParams({ name, group_id: group, ...(parent ? { parent_id: parent } : {}) });
  const res = await fetch(`${api}/files/upload?${q}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/octet-stream" },
    body: Buffer.from("PK-fixture"),
  });
  return (await res.json()).id;
};
const folder = (await call(admin, "POST", "/files/directories", { name: "Granted", group_id: group })).json.id;
await upload("granted.docx", folder);
await upload("secret.docx");
await db.query(`INSERT INTO file_permissions (file_id, user_id, access_level) VALUES ($1,$2,'view')`, [folder, uid.m1]);
const names = async (s) => (await call(s, "GET", "/templates")).json.files.map((f) => f.name).sort().join(",");
const download = async (s, source) => (await call(s, "POST", "/source-files/download", { source })).status;
check("member sees only granted templates", (await names(m1)) === "granted.docx", await names(m1));
check("member without grants sees none", (await names(m2)) === "", await names(m2));
check("manage_files sees all templates", (await names(admin)) === "granted.docx,secret.docx", await names(admin));
check("granted download through folder", (await download(m1, "Root/granted.docx")) === 200);
check("ungranted download blocked", (await download(m1, "secret.docx")) === 404);
check("no-grant user blocked", (await download(m2, "granted.docx")) === 404);
check("manage_files can download", (await download(admin, "secret.docx")) === 200);

// 3. Escalation
const roles = (...names) => ({ role_ids: names.map((n) => roleId[n]) });
check("admin cannot self-promote", (await call(admin, "PUT", `/users/${uid.admin}/roles`, roles("admin", "super_admin"))).status === 403);
check("admin cannot promote member", (await call(admin, "PUT", `/users/${uid.m1}/roles`, roles("member", "super_admin"))).status === 403);
check("admin cannot grant higher custom role", (await call(admin, "PUT", `/users/${uid.m1}/roles`, roles("member", "custom_high"))).status === 403);
check("admin cannot get super admin recovery link", (await call(admin, "POST", `/users/${uid.sa}/recovery-link`)).status === 403);
check("admin cannot edit super admin", (await call(admin, "PATCH", `/users/${uid.sa}`, { status: "suspended" })).status === 403);
check("admin cannot delete super admin", (await call(admin, "DELETE", `/users/${uid.sa}`)).status === 403);
check("admin cannot strip super admin", (await call(admin, "PUT", `/users/${uid.sa}/roles`, roles("member"))).status === 403);
check("admin can assign equal role", (await call(admin, "PUT", `/users/${uid.m1}/roles`, roles("member", "manager"))).status === 200);
check("admin can restore role", (await call(admin, "PUT", `/users/${uid.m1}/roles`, roles("member"))).status === 200);
check("super admin can promote", (await call(sa, "PUT", `/users/${uid.m1}/roles`, roles("member", "custom_high"))).status === 200);
check("super admin can demote", (await call(sa, "PUT", `/users/${uid.m1}/roles`, roles("member"))).status === 200);

// 4. Suspension
const link = await call(admin, "POST", `/users/${uid.m2}/recovery-link`);
check("admin gets member recovery link", link.status === 200);
const linkToken = new URLSearchParams(link.json.action_link.split("#")[1]).get("token");
const post = (path, body) => fetch(`${api}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("cannot deactivate self", (await call(admin, "PATCH", `/users/${uid.admin}`, { status: "inactive" })).status === 400);
for (const status of ["suspended", "inactive"]) {
  check(`set ${status}`, (await call(admin, "PATCH", `/users/${uid.m2}`, { status })).status === 200);
  check(`${status}: access token rejected`, (await call(m2, "GET", "/auth/me")).status === 401);
  check(`${status}: login rejected`, (await login("m2")).status === 401);
  check(`${status}: link verify rejected`, (await post("/auth/token/verify", { token: linkToken })).status === 400);
  check(`${status}: link accept rejected`, (await post("/auth/token/accept", { token: linkToken, password: "Changed-pass-123" })).status === 400);
}
check("reactivate", (await call(admin, "PATCH", `/users/${uid.m2}`, { status: "active" })).status === 200);
const refreshOld = await fetch(`${api}/auth/refresh`, { method: "POST", headers: { Cookie: m2.cookie, "X-Requested-With": "oc-app" } });
check("old session stays revoked", refreshOld.status === 401, refreshOld.status);
const m2Again = await login("m2");
check("password unchanged and login works", m2Again.status === 200, m2Again.status);
check("recovery link still usable after reactivation", (await post("/auth/token/verify", { token: linkToken })).status === 200);

// 5. Sign-off
const type = (await one(`INSERT INTO activity_types (code,name,color) VALUES ('T','T','#000000') RETURNING id`)).id;
const activity = (await call(admin, "POST", "/activities", { name: "Audit", type_id: type, responsible_role: "x", frequency: "monthly", recur_day: 1 })).json.id;
const ack = (s, status, note) => call(s, "POST", "/activities/acknowledge", { activity_id: activity, due_date: "2026-01-01", status, note });
check("member signs off", (await ack(m1, "done", "first")).status === 200);
check("other member cannot overwrite", (await ack(m2Again, "done", "tampered")).status === 403);
check("member cannot reopen", (await ack(m2Again, "in_progress")).status === 403);
const row = await one(`SELECT completed_by, note FROM activity_instances WHERE activity_id=$1`, [activity]);
check("signer and note preserved", row.completed_by === uid.m1 && row.note === "first");
check("activity admin can change", (await ack(admin, "in_progress")).status === 200);

// 6. AI limit. No AI keys are configured, so an allowed call stops at 503 without spending anything.
const m1Session = (await call(m1, "POST", "/chat/sessions", {})).json.session.id;
const statuses = [];
for (let i = 0; i < 61; i++) statuses.push((await call(m1, "POST", `/chat/sessions/${m1Session}/messages`, { message: "hi" })).status);
check("60 AI calls allowed", statuses.slice(0, 60).every((s) => s === 503), [...new Set(statuses.slice(0, 60))]);
check("61st AI call limited", statuses[60] === 429, statuses[60]);
const otherSession = (await call(m2Again, "POST", "/chat/sessions", {})).json.session.id;
check("limit is per user", (await call(m2Again, "POST", `/chat/sessions/${otherSession}/messages`, { message: "hi" })).status === 503);

// FAQ form has no group picker
const faqSection = await call(admin, "POST", "/faq/sections", { title: "No group" });
check("FAQ section without a group uses the default", faqSection.status === 201 && faqSection.json.group_id === group, faqSection.status);

// 7. Nightly reindex
const { isNightlyDue } = await import("../src/rag/nightly.ts");
const { startReindex } = await import("../src/rag/reindex.ts");
const { closePool } = await import("../src/db/pool.ts");
check("nightly due at 04:00 in winter", isNightlyDue(new Date("2026-01-15T03:00:10Z"), "04:00", null));
check("nightly due at 04:00 in summer", isNightlyDue(new Date("2026-07-15T02:00:10Z"), "04:00", "2026-07-14"));
check("nightly runs once per day", !isNightlyDue(new Date("2026-07-15T02:00:40Z"), "04:00", "2026-07-15"));
check("nightly waits for its time", !isNightlyDue(new Date("2026-07-15T02:01:00Z"), "04:00", null));
const noEmbedder = { embedQuery: async () => [], embedDocuments: async () => [] };
const run = await startReindex("schedule", { embedder: noEmbedder, onlyFileIds: [] });
await run.done.catch(() => undefined);
const log = await one(`SELECT "trigger" FROM sync_logs WHERE id = $1`, [run.logId]);
check("nightly runs are logged", log?.trigger === "schedule", log?.trigger);
await closePool();

await db.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

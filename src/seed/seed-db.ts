import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "dotenv/config";

// Copies database rows from the linked Supabase project into LOCAL Docker
// PostgreSQL. It replaces all rows in the target, so it refuses remote targets.
// Supabase is only read. Dumps are deleted when the run ends.

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Target {
  name: string;
  repo: string;
  projectRef: string;
  databaseUrl: string | undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for seeding`);
  return value;
}

const TARGET: Target = {
  name: requiredEnv("SERVICE_NAME"),
  // Local checkout of the frontend that is linked to the Supabase project.
  repo: resolve(ROOT, requiredEnv("SEED_SUPABASE_REPO")),
  projectRef: requiredEnv("SEED_SUPABASE_PROJECT_REF"),
  databaseUrl: process.env.DATABASE_URL,
};

// Only auth.users is needed. Sessions, tokens and MFA data are never migrated.
const AUTH_TABLES_TO_SKIP = [
  "audit_log_entries", "flow_state", "identities", "instances", "mfa_amr_claims",
  "mfa_challenges", "mfa_factors", "oauth_authorizations", "oauth_clients",
  "oauth_consents", "one_time_tokens", "refresh_tokens", "saml_providers",
  "saml_relay_states", "schema_migrations", "sessions", "sso_domains", "sso_providers",
].map((t) => `auth.${t}`);

function localDatabaseName(url: string | undefined): string {
  if (!url) throw new Error("Missing target database URL");
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error(`Refusing to seed non-local host ${parsed.hostname}`);
  }
  return parsed.pathname.slice(1);
}

function psql(database: string, input: string, extra: string[] = []): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(
      "docker",
      ["compose", "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", database,
        "-v", "ON_ERROR_STOP=1", "-q", ...extra],
      { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(err.slice(0, 2000)))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

async function dump(target: Target, schema: string, file: string, exclude: string[] = []) {
  const args = ["db", "dump", "--linked", "--data-only", "--use-copy", "--schema", schema, "-f", file];
  for (const table of exclude) args.push("-x", table);
  await run("supabase", args, { cwd: target.repo, maxBuffer: 1024 * 1024 * 16 });
}

/** Row count per table, read from the COPY blocks in a dump. */
function countCopyRows(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  let current: string | undefined;
  for (const line of sql.split("\n")) {
    if (current) {
      if (line === "\\.") current = undefined;
      else counts.set(current, (counts.get(current) ?? 0) + 1);
      continue;
    }
    const match = line.match(/^COPY "?public"?\."?([a-z_]+)"? .*FROM stdin;$/);
    if (match?.[1]) {
      current = match[1];
      counts.set(current, 0);
    }
  }
  return counts;
}

function extractAuthUsers(sql: string): { columns: string[]; block: string } {
  const lines = sql.split("\n");
  const start = lines.findIndex((l) => /^COPY "?auth"?\."?users"? \(/.test(l));
  if (start < 0) throw new Error("auth.users was not found in the dump");
  const end = lines.indexOf("\\.", start);
  const header = lines[start]!;
  const columns = header.slice(header.indexOf("(") + 1, header.lastIndexOf(")"))
    .split(",").map((c) => c.trim().replace(/"/g, ""));
  const quoted = columns.map((c) => `"${c}"`).join(", ");
  const body = lines.slice(start + 1, end + 1).join("\n");
  return { columns, block: `COPY pg_temp.auth_users_stage (${quoted}) FROM stdin;\n${body}\n` };
}

function buildLoadScript(authSql: string, publicSql: string): string {
  const { columns, block } = extractAuthUsers(authSql);
  const stage = columns.map((c) => `"${c}" text`).join(", ");
  return `
SET session_replication_role = replica;
-- Embeddings cost money, so keep them across re-seeds for files that still exist.
CREATE TEMP TABLE keep_chunks AS SELECT * FROM public.document_chunks;
CREATE TEMP TABLE keep_index_state AS SELECT * FROM public.rag_file_index_state;
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
  LOOP EXECUTE format('TRUNCATE TABLE public.%I CASCADE', t); END LOOP;
END $$;
CREATE TEMP TABLE auth_users_stage (${stage});
${block}
INSERT INTO public.users (id, email, password_hash, email_confirmed_at, invited_at,
  last_sign_in_at, banned_until, metadata, created_at, updated_at)
SELECT id::uuid, email, NULLIF(encrypted_password, ''), email_confirmed_at::timestamptz,
  invited_at::timestamptz, last_sign_in_at::timestamptz,
  CASE WHEN deleted_at IS NOT NULL THEN 'infinity'::timestamptz ELSE banned_until::timestamptz END,
  COALESCE(raw_user_meta_data::jsonb, '{}'::jsonb),
  COALESCE(created_at::timestamptz, now()), COALESCE(updated_at::timestamptz, now())
FROM pg_temp.auth_users_stage;
${publicSql}
-- Supabase still holds the old grant. Keep this in step with migration 0006.
DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p
WHERE rp.role_id = r.id AND rp.permission_id = p.id
  AND p.name = 'view_chat' AND r.name IN ('member', 'manager');
INSERT INTO public.document_chunks
SELECT k.* FROM pg_temp.keep_chunks k WHERE EXISTS (SELECT 1 FROM public.files f WHERE f.id = k.file_id);
INSERT INTO public.rag_file_index_state
SELECT k.* FROM pg_temp.keep_index_state k WHERE EXISTS (SELECT 1 FROM public.files f WHERE f.id = k.file_id);
`;
}

const ORPHAN_QUERY = `
DO $$
DECLARE fk record; missing bigint; total bigint := 0;
BEGIN
  FOR fk IN
    SELECT c.conname, c.conrelid::regclass AS child, c.confrelid::regclass AS parent,
      (SELECT string_agg(format('c.%I = p.%I', a.attname, b.attname), ' AND ')
         FROM unnest(c.conkey, c.confkey) k(ck, pk)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.ck
         JOIN pg_attribute b ON b.attrelid = c.confrelid AND b.attnum = k.pk) AS join_on,
      (SELECT string_agg(format('c.%I IS NOT NULL', a.attname), ' AND ')
         FROM unnest(c.conkey) k(ck)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.ck) AS not_null
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('SELECT count(*) FROM %s c WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
      fk.child, fk.not_null, fk.parent, fk.join_on) INTO missing;
    IF missing > 0 THEN
      RAISE WARNING 'orphans: % on % = %', fk.conname, fk.child, missing;
      total := total + missing;
    END IF;
  END LOOP;
  RAISE NOTICE 'ORPHAN_TOTAL=%', total;
END $$;`;

async function seed(target: Target, workDir: string) {
  const database = localDatabaseName(target.databaseUrl);
  const linked = (await readFile(join(target.repo, "supabase/.temp/project-ref"), "utf8")).trim();
  if (linked !== target.projectRef) {
    throw new Error(`${target.repo} is linked to ${linked}, expected ${target.projectRef}`);
  }

  const dir = join(workDir, target.name);
  await mkdir(dir, { mode: 0o700 });
  const publicFile = join(dir, "public.sql");
  const authFile = join(dir, "auth.sql");
  console.log(`[${target.name}] exporting from Supabase`);
  await dump(target, "public", publicFile);
  await dump(target, "auth", authFile, AUTH_TABLES_TO_SKIP);

  const [publicSql, authSql] = await Promise.all([readFile(publicFile, "utf8"), readFile(authFile, "utf8")]);
  const expected = countCopyRows(publicSql);

  console.log(`[${target.name}] loading into ${database}`);
  await psql(database, buildLoadScript(authSql, publicSql), ["--single-transaction"]);

  let mismatches = 0;
  for (const [table, count] of expected) {
    // Differs from the source by design: the view_chat grant is removed above.
    if (table === "role_permissions") continue;
    const actual = Number((await psql(database, `SELECT count(*) FROM public."${table}";`, ["-At"])).trim());
    if (actual !== count) {
      mismatches++;
      console.error(`[${target.name}] MISMATCH ${table}: source ${count}, target ${actual}`);
    }
  }

  const orphanOutput = await new Promise<string>((done, fail) => {
    const child = spawn("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "postgres",
      "-d", database, "-v", "ON_ERROR_STOP=1"], { cwd: ROOT });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(text) : fail(new Error(text.slice(0, 2000)))));
    child.stdin.end(ORPHAN_QUERY);
  });
  const orphans = Number(orphanOutput.match(/ORPHAN_TOTAL=(\d+)/)?.[1] ?? -1);
  for (const line of orphanOutput.split("\n")) if (line.includes("orphans:")) console.error(`[${target.name}] ${line}`);

  const users = (await psql(database, "SELECT count(*) FROM public.users;", ["-At"])).trim();
  const rows = [...expected.values()].reduce((a, b) => a + b, 0);
  console.log(`[${target.name}] ${expected.size} tables, ${rows} rows, ${users} users, ${mismatches} mismatches, ${orphans} orphans`);
  if (mismatches > 0 || orphans !== 0) throw new Error(`[${target.name}] verification failed`);
}

await mkdir(join(ROOT, ".seed"), { recursive: true, mode: 0o700 });
await chmod(join(ROOT, ".seed"), 0o700);
const workDir = await mkdtemp(join(ROOT, ".seed", "run-"));
try {
  await seed(TARGET, workDir);
} finally {
  await rm(workDir, { recursive: true, force: true });
}

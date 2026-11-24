import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import dotenv from "dotenv";
import pg from "pg";

// Copies a verified local seed into an EMPTY, migrated deployment: rows and file blobs.
// Without --apply it only checks and reports. Sessions and one-time links are never copied.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIPPED_TABLES = ["schema_migrations", "refresh_tokens", "auth_tokens"];
const BLOB_CONCURRENCY = 8;
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

interface Site {
  file: string;
  databaseUrl: string;
  url: URL;
  database: string;
  isLocal: boolean;
  storage: string;
  container: string;
}

function loadSite(path: string): Promise<Site> {
  const file = resolve(ROOT, path);
  return readFile(file, "utf8").then((text) => {
    const env = dotenv.parse(text);
    if (!env.DATABASE_URL) throw new Error(`${path}: DATABASE_URL is required`);
    if (!env.AZURE_STORAGE_CONNECTION_STRING) throw new Error(`${path}: AZURE_STORAGE_CONNECTION_STRING is required`);
    const url = new URL(env.DATABASE_URL);
    return {
      file: path,
      databaseUrl: env.DATABASE_URL,
      url,
      database: decodeURIComponent(url.pathname.slice(1)),
      isLocal: LOCAL_HOSTS.includes(url.hostname),
      storage: env.AZURE_STORAGE_CONNECTION_STRING,
      container: env.AZURE_STORAGE_CONTAINER || "knowledge-base",
    };
  });
}

async function withClient<T>(site: Site, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: site.databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const quoted = (table: string) => `public."${table.replace(/"/g, '""')}"`;

async function tableCounts(site: Site): Promise<Map<string, number>> {
  return withClient(site, async (client) => {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT (tablename = ANY($1)) ORDER BY tablename`,
      [SKIPPED_TABLES]
    );
    const counts = new Map<string, number>();
    for (const { tablename } of rows) {
      const result = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${quoted(tablename)}`);
      counts.set(tablename, Number(result.rows[0]!.n));
    }
    return counts;
  });
}

async function assertTargetReady(target: Site, targetCounts: Map<string, number>) {
  const expected = (await readdir(join(ROOT, "db/migrations"))).filter((f) => f.endsWith(".sql")).sort();
  const applied = await withClient(target, async (client) => {
    const exists = await client.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    if (!exists.rows[0].t) return [];
    return (await client.query<{ name: string }>(`SELECT name FROM public.schema_migrations ORDER BY name`)).rows.map(
      (r) => r.name
    );
  });
  if (applied.join() !== expected.join()) {
    throw new Error(`Target migrations differ from this code. Run db:migrate with ${target.file} first.`);
  }
  const occupied = [...targetCounts].filter(([, n]) => n > 0).map(([table]) => table);
  if (occupied.length > 0) throw new Error(`Target is not empty: ${occupied.join(", ")}`);
}

const blobContainer = (site: Site) =>
  BlobServiceClient.fromConnectionString(site.storage).getContainerClient(site.container);

async function storagePaths(site: Site): Promise<string[]> {
  return withClient(site, async (client) => {
    const { rows } = await client.query<{ storage_path: string }>(
      `SELECT DISTINCT storage_path FROM files WHERE storage_path IS NOT NULL ORDER BY storage_path`
    );
    return rows.map((r) => r.storage_path);
  });
}

async function findMissing(container: ContainerClient, paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  const queue = [...paths];
  await Promise.all(
    Array.from({ length: BLOB_CONCURRENCY }, async () => {
      for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
        if (!(await container.getBlobClient(path).exists())) missing.push(path);
      }
    })
  );
  return missing;
}

/** Safe to re-run: a blob already present with the same size is skipped. */
async function copyBlobs(source: ContainerClient, target: ContainerClient, paths: string[]) {
  await target.createIfNotExists();
  const queue = [...paths];
  let copied = 0;
  let skipped = 0;
  await Promise.all(
    Array.from({ length: BLOB_CONCURRENCY }, async () => {
      for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
        const from = source.getBlobClient(path);
        const to = target.getBlockBlobClient(path);
        const properties = await from.getProperties();
        if (await to.exists()) {
          if ((await to.getProperties()).contentLength === properties.contentLength) {
            skipped++;
            continue;
          }
        }
        await to.uploadData(await from.downloadToBuffer(), {
          blobHTTPHeaders: { blobContentType: properties.contentType },
        });
        copied++;
      }
    })
  );
  return { copied, skipped };
}

/** Streams rows through the Docker Postgres tools in one transaction. */
function copyRows(source: Site, target: Site): Promise<void> {
  const dumpArgs = [
    "compose", "exec", "-T", "postgres", "pg_dump", "-U", "postgres", "--data-only", "--no-owner", "--no-privileges",
    "--schema=public", ...SKIPPED_TABLES.map((t) => `--exclude-table=public.${t}`), source.database,
  ];
  const connection = target.isLocal
    ? ["-U", "postgres", "-d", target.database]
    : ["-h", target.url.hostname, "-p", target.url.port || "5432", "-U", decodeURIComponent(target.url.username), "-d", target.database];
  // Passed by name, so the password never appears in a process list.
  const secretEnv = target.isLocal ? [] : ["-e", "PGPASSWORD", "-e", "PGSSLMODE"];
  const restoreArgs = [
    "compose", "exec", "-T", ...secretEnv, "postgres", "psql", ...connection, "-v", "ON_ERROR_STOP=1", "-q", "--single-transaction",
  ];

  return new Promise((done, fail) => {
    const dump = spawn("docker", dumpArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const restore = spawn("docker", restoreArgs, {
      cwd: ROOT,
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        PGPASSWORD: decodeURIComponent(target.url.password),
        PGSSLMODE: target.url.searchParams.get("sslmode") ?? "require",
      },
    });
    let errors = "";
    dump.stderr.on("data", (d) => (errors += d));
    restore.stderr.on("data", (d) => (errors += d));

    // pg_dump 17 emits this setting, which older target servers reject.
    let first = true;
    const compatible = new Transform({
      transform(chunk, _encoding, callback) {
        if (!first) return callback(null, chunk);
        first = false;
        callback(null, Buffer.from(chunk.toString("latin1").replace(/^SET transaction_timeout = 0;\n/m, ""), "latin1"));
      },
    });
    restore.stdin.on("error", () => undefined);
    dump.stdout.pipe(compatible).pipe(restore.stdin);

    let dumpCode: number | null = null;
    dump.on("error", fail);
    restore.on("error", fail);
    dump.on("close", (code) => (dumpCode = code));
    restore.on("close", (code) => {
      if (code === 0 && (dumpCode === 0 || dumpCode === null)) done();
      else fail(new Error(`Row copy failed: ${errors.slice(0, 2000)}`));
    });
  });
}

const { values: args } = parseArgs({
  options: {
    "source-env": { type: "string", default: ".env" },
    "target-env": { type: "string" },
    apply: { type: "boolean", default: false },
    confirm: { type: "string" },
    "allow-missing-blobs": { type: "boolean", default: false },
  },
});
if (!args["target-env"]) throw new Error("--target-env is required");

const source = await loadSite(args["source-env"]!);
const target = await loadSite(args["target-env"]);
if (!source.isLocal) throw new Error("The source must be the local seeded database");
if (source.isLocal && target.isLocal && (source.database === target.database || source.url.port !== target.url.port)) {
  throw new Error("A local target must be a different database on the same Docker Postgres");
}
if (source.storage === target.storage && source.container === target.container) {
  throw new Error("Source and target use the same blob container");
}

const [sourceCounts, targetCounts, paths] = await Promise.all([
  tableCounts(source),
  tableCounts(target),
  storagePaths(source),
]);
await assertTargetReady(target, targetCounts);

const sourceBlobs = blobContainer(source);
const missing = await findMissing(sourceBlobs, paths);
const rows = [...sourceCounts.values()].reduce((a, b) => a + b, 0);
console.log(`Target: ${target.url.hostname}/${target.database}, container ${target.container}`);
console.log(`Ready to copy ${rows} rows in ${sourceCounts.size} tables and ${paths.length} files (${missing.length} missing locally)`);
if (missing.length > 0 && !args["allow-missing-blobs"]) {
  throw new Error("Some files are missing from local storage. Run seed:files, or pass --allow-missing-blobs");
}
if (!args.apply) {
  console.log(`Dry run, nothing written. To import: --apply --confirm ${target.database}`);
  process.exit(0);
}
if (args.confirm !== target.database) throw new Error(`--confirm must be exactly ${target.database}`);

const blobs = await copyBlobs(sourceBlobs, blobContainer(target), paths.filter((p) => !missing.includes(p)));
console.log(`Files: ${blobs.copied} copied, ${blobs.skipped} already present`);
await copyRows(source, target);

const finalCounts = await tableCounts(target);
const mismatches = [...sourceCounts].filter(([table, n]) => finalCounts.get(table) !== n);
if (mismatches.length > 0) {
  throw new Error(`Row counts differ: ${mismatches.map(([t, n]) => `${t} ${n}/${finalCounts.get(t)}`).join(", ")}`);
}
console.log(`Imported and verified ${rows} rows. Everyone keeps their password and signs in again.`);

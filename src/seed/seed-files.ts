import { BlobServiceClient } from "@azure/storage-blob";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

// Copies files from the Supabase bucket into Azure Blob Storage, keeping storage
// paths. Blobs that already match by size are skipped, so re-runs are cheap.
// Supabase is only read. The temporary download is deleted after a clean run.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUCKET = process.env.SUPABASE_BUCKET || "knowledge-base";
const REPO = process.env.SEED_SUPABASE_REPO;
const PROJECT_REF = process.env.SEED_SUPABASE_PROJECT_REF;
if (!REPO || !PROJECT_REF) throw new Error("SEED_SUPABASE_REPO and SEED_SUPABASE_PROJECT_REF are required");
const source = { repo: resolve(ROOT, REPO), projectRef: PROJECT_REF };
const serviceName = config.serviceName;

interface Row {
  id: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | string | null;
}

function download(repo: string, dir: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(
      "supabase",
      ["storage", "cp", "-r", `ss:///${BUCKET}`, dir, "--experimental", "--linked", "-j", "8"],
      { cwd: repo, stdio: ["ignore", "ignore", "pipe"] }
    );
    let tail = "";
    child.stderr.on("data", (d) => (tail = (tail + d).slice(-1000)));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done() : fail(new Error(`storage cp failed: ${tail}`))));
  });
}

async function seedFiles(service: BlobServiceClient): Promise<boolean> {
  const linked = (await readFile(join(source.repo, "supabase/.temp/project-ref"), "utf8")).trim();
  if (linked !== source.projectRef) throw new Error(`${source.repo} is linked to ${linked}`);

  const db = new pg.Client({ connectionString: config.databaseUrl });
  await db.connect();
  let rows: Row[];
  try {
    ({ rows } = await db.query<Row>(
      `SELECT id, storage_path, mime_type, size_bytes FROM files
       WHERE NOT is_directory AND storage_path IS NOT NULL`
    ));
  } finally {
    await db.end();
  }

  const container = service.getContainerClient(config.storage.container);
  await container.createIfNotExists();
  const existing = new Map<string, number>();
  for await (const blob of container.listBlobsFlat()) {
    existing.set(blob.name, blob.properties.contentLength ?? -1);
  }
  const pending = rows.filter((r) => {
    const size = existing.get(r.storage_path);
    return size === undefined || (r.size_bytes != null && size !== Number(r.size_bytes));
  });
  console.log(`[${serviceName}] ${rows.length} files, ${pending.length} to copy`);
  if (pending.length === 0) return true;

  const workDir = join(ROOT, ".seed", `files-${serviceName}`);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  console.log(`[${serviceName}] downloading bucket`);
  await download(source.repo, workDir);
  const base = resolve(workDir, BUCKET);

  let copied = 0;
  const missing: string[] = [];
  const failed: string[] = [];
  const queue = [...pending];
  const worker = async () => {
    for (let row = queue.pop(); row; row = queue.pop()) {
      const local = resolve(base, row.storage_path);
      if (!local.startsWith(base + sep)) {
        failed.push(row.id);
        continue;
      }
      try {
        await stat(local);
      } catch {
        missing.push(row.id);
        continue;
      }
      try {
        await container.getBlockBlobClient(row.storage_path).uploadFile(local, {
          blobHTTPHeaders: { blobContentType: row.mime_type ?? "application/octet-stream" },
        });
        copied++;
        if (copied % 500 === 0) console.log(`[${serviceName}] copied ${copied}/${pending.length}`);
      } catch {
        failed.push(row.id);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  console.log(`[${serviceName}] copied ${copied}, missing in Supabase ${missing.length}, failed ${failed.length}`);
  if (missing.length) console.log(`[${serviceName}] missing file ids (first 10): ${missing.slice(0, 10).join(", ")}`);
  if (failed.length) console.log(`[${serviceName}] failed file ids (first 10): ${failed.slice(0, 10).join(", ")}`);
  if (failed.length === 0) await rm(workDir, { recursive: true, force: true });
  return failed.length === 0;
}

if (!config.storage.connectionString) throw new Error("AZURE_STORAGE_CONNECTION_STRING is blank");
const service = BlobServiceClient.fromConnectionString(config.storage.connectionString);
process.exit((await seedFiles(service)) ? 0 : 1);

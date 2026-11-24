import { createHash } from "node:crypto";
import pg from "pg";
import { config } from "../config.js";
import { getPool, withTransaction } from "../db/pool.js";
import { conflict, HttpError } from "../http/errors.js";
import { getObjectBuffer } from "../services/storage.js";
import { chunkDocument } from "./chunking.js";
import { EMBEDDING_DIMENSIONS, INDEX_NAME, PIPELINE_VERSION } from "./config.js";
import {
  describeError,
  getEmbedder,
  isBadInput,
  SafeError,
  withBackoff,
  type BackoffOptions,
  type Embedder,
} from "./embeddings.js";
import { extractMetadataFromPath } from "./metadata.js";

const LOCK_NAMESPACE = 727002;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOWNLOAD_CONCURRENCY = 8;
const EMBED_BATCH_SIZE = 100;
const PROGRESS_EVERY_FILES = 25;

export type SyncTrigger = "cli" | "api" | "schedule";

interface SyncFileDetail {
  file_id: string;
  name: string;
  status: "indexed" | "download_failed" | "failed";
  chunks?: number;
  error?: string;
}

export interface ReindexResult {
  filesFound: number;
  filesSkipped: number;
  filesIndexed: number;
  filesFailed: number;
  filesRemoved: number;
  chunksIndexed: number;
  textsEmbedded: number;
}

export interface ReindexOverrides {
  db?: pg.Pool;
  connectionString?: string;
  embedder?: Embedder;
  readBlob?: (path: string) => Promise<Buffer>;
  backoff?: BackoffOptions;
  /** Limit to these file ids (tests). Stale-chunk removal is skipped when set. */
  onlyFileIds?: string[];
}

interface FileRow {
  id: string;
  name: string;
  parent_id: string | null;
  is_directory: boolean;
  storage_path: string | null;
  mime_type: string | null;
}

interface StateRow {
  file_id: string;
  content_hash: string;
  source: string;
  pipeline_version: number;
  chunk_count: number;
}

interface PreparedChunk {
  content: string;
  metadata: Record<string, unknown>;
}

interface PreparedFile {
  row: FileRow;
  hash: string;
  source: string;
  chunks: PreparedChunk[];
  /** Vectors (as pgvector text) already stored for identical chunk text. */
  reusable: Map<string, string>;
}

const isDocx = (r: FileRow) => r.mime_type === DOCX_MIME || r.name.endsWith(".docx");

function folderPath(row: FileRow, dirs: Map<string, FileRow>): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  let parentId = row.parent_id;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const dir = dirs.get(parentId);
    if (!dir) break;
    parts.unshift(dir.name);
    parentId = dir.parent_id;
  }
  return parts;
}

function assertVector(v: number[] | undefined): asserts v is number[] {
  if (!v || v.length !== EMBEDDING_DIMENSIONS || !v.every(Number.isFinite)) {
    throw new SafeError(`Embedding must have ${EMBEDDING_DIMENSIONS} finite dimensions`);
  }
}

/** Removes indexed data for files that are gone or no longer .docx. */
export async function removeStale(db: pg.Pool): Promise<number> {
  const eligible = `EXISTS (
    SELECT 1 FROM files f
    WHERE f.id = t.file_id AND NOT f.is_directory AND f.storage_path IS NOT NULL
      AND (f.mime_type = '${DOCX_MIME}' OR right(f.name, 5) = '.docx'))`;
  return withTransaction(db, async (client) => {
    const chunks = await client.query(
      `DELETE FROM document_chunks t WHERE NOT ${eligible} RETURNING file_id`
    );
    const states = await client.query(
      `DELETE FROM rag_file_index_state t WHERE NOT ${eligible} RETURNING file_id`
    );
    return new Set([...chunks.rows, ...states.rows].map((r) => r.file_id as string)).size;
  });
}

async function commitFile(db: pg.Pool, file: PreparedFile, vectors: Map<string, string>): Promise<void> {
  await withTransaction(db, async (client) => {
    await client.query("DELETE FROM document_chunks WHERE file_id = $1", [file.row.id]);
    if (file.chunks.length > 0) {
      await client.query(
        `INSERT INTO document_chunks (file_id, chunk_index, source, content, metadata, embedding)
         SELECT $1, u.ord - 1, $2, u.content, u.metadata::jsonb, u.embedding::vector
         FROM unnest($3::text[], $4::text[], $5::text[])
           WITH ORDINALITY AS u(content, metadata, embedding, ord)`,
        [
          file.row.id,
          file.source,
          file.chunks.map((c) => c.content),
          file.chunks.map((c) => JSON.stringify(c.metadata)),
          file.chunks.map((c) => vectors.get(c.content) ?? file.reusable.get(c.content)),
        ]
      );
    }
    await client.query(
      `INSERT INTO rag_file_index_state (file_id, content_hash, source, pipeline_version, chunk_count)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (file_id) DO UPDATE SET
         content_hash = EXCLUDED.content_hash, source = EXCLUDED.source,
         pipeline_version = EXCLUDED.pipeline_version, chunk_count = EXCLUDED.chunk_count,
         indexed_at = now()`,
      [file.row.id, file.hash, file.source, PIPELINE_VERSION, file.chunks.length]
    );
  });
}

async function runReindex(
  logId: string,
  db: pg.Pool,
  embedder: Embedder,
  readBlob: (path: string) => Promise<Buffer>,
  overrides: ReindexOverrides,
  signal: AbortSignal
): Promise<ReindexResult> {
  const result: ReindexResult = {
    filesFound: 0,
    filesSkipped: 0,
    filesIndexed: 0,
    filesFailed: 0,
    filesRemoved: 0,
    chunksIndexed: 0,
    textsEmbedded: 0,
  };
  const details: SyncFileDetail[] = [];
  let filesRead = 0;
  let lastProgress = 0;

  const writeLog = async (extra: { status?: string; error?: string; finished?: boolean } = {}) => {
    try {
      await db.query(
        `UPDATE sync_logs SET
           status = COALESCE($2, status), files_found = $3, files_downloaded = $4,
           files_failed = $5, chunks_indexed = $6,
           details = CASE WHEN $7 THEN $8::jsonb ELSE details END,
           error_message = $9,
           finished_at = CASE WHEN $7 THEN now() ELSE finished_at END
         WHERE id = $1`,
        [
          logId,
          extra.status ?? null,
          result.filesFound,
          filesRead,
          result.filesFailed,
          result.chunksIndexed,
          extra.finished === true,
          JSON.stringify(details),
          extra.error ?? null,
        ]
      );
    } catch (err) {
      console.warn(`[reindex] could not update sync log: ${describeError(err)}`);
    }
  };

  const fail = (row: FileRow, status: "download_failed" | "failed", err: unknown) => {
    result.filesFailed++;
    details.push({
      file_id: row.id,
      name: row.name,
      status,
      error: err instanceof HttpError ? err.message : describeError(err),
    });
  };

  const backoff = { ...overrides.backoff, signal };
  const embedBatch = async (batch: string[], into: Map<string, string>) => {
    const vectors = await withBackoff(() => embedder.embedDocuments(batch), backoff);
    if (vectors.length !== batch.length) throw new SafeError("Embedding count mismatch");
    batch.forEach((text, j) => {
      const v = vectors[j];
      assertVector(v);
      into.set(text, JSON.stringify(v));
    });
    result.textsEmbedded += batch.length;
  };

  const commit = async (file: PreparedFile, vectors: Map<string, string>) => {
    try {
      await commitFile(db, file, vectors);
    } catch (err) {
      // The file was deleted while this run was working on it.
      if ((err as { code?: string }).code === "23503") {
        fail(file.row, "failed", new HttpError(409, "File was deleted during the run"));
        return;
      }
      throw err;
    }
    result.filesIndexed++;
    result.chunksIndexed += file.chunks.length;
    details.push({ file_id: file.row.id, name: file.row.name, status: "indexed", chunks: file.chunks.length });
  };

  const missingTexts = (files: PreparedFile[]) => [
    ...new Set(files.flatMap((f) => f.chunks.filter((c) => !f.reusable.has(c.content)).map((c) => c.content))),
  ];

  let pending: PreparedFile[] = [];
  const flush = async () => {
    let files = pending;
    pending = [];
    const vectors = new Map<string, string>();

    // Commit each file as soon as its vectors exist, so a failure loses no paid work.
    const commitReady = async () => {
      const isReady = (f: PreparedFile) =>
        f.chunks.every((c) => vectors.has(c.content) || f.reusable.has(c.content));
      const ready = files.filter(isReady);
      files = files.filter((f) => !isReady(f));
      for (const file of ready) await commit(file, vectors);
    };

    await commitReady();
    const texts = missingTexts(files);
    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        signal.throwIfAborted();
        await embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE), vectors);
        await commitReady();
      }
    } catch (err) {
      if (!isBadInput(err)) throw err;
      // A text was rejected: retry per file so only the offending file fails.
      for (const file of files) {
        const own = [...new Set(file.chunks.map((c) => c.content))].filter(
          (t) => !vectors.has(t) && !file.reusable.has(t)
        );
        try {
          for (let i = 0; i < own.length; i += EMBED_BATCH_SIZE) {
            await embedBatch(own.slice(i, i + EMBED_BATCH_SIZE), vectors);
          }
          await commit(file, vectors);
        } catch (fileErr) {
          if (!isBadInput(fileErr)) throw fileErr;
          fail(file.row, "failed", fileErr);
        }
      }
    }
  };

  try {
    const [{ rows: allFiles }, { rows: stateRows }] = await Promise.all([
      db.query<FileRow>("SELECT id, name, parent_id, is_directory, storage_path, mime_type FROM files"),
      db.query<StateRow>(
        "SELECT file_id, content_hash, source, pipeline_version, chunk_count FROM rag_file_index_state"
      ),
    ]);
    const dirs = new Map(allFiles.filter((f) => f.is_directory).map((f) => [f.id, f]));
    const states = new Map(stateRows.map((s) => [s.file_id, s]));
    const only = overrides.onlyFileIds ? new Set(overrides.onlyFileIds) : undefined;
    const docx = allFiles.filter(
      (f) => !f.is_directory && f.storage_path && isDocx(f) && (!only || only.has(f.id))
    );
    result.filesFound = docx.length;
    await writeLog();

    // An empty listing must never clear the index.
    if (docx.length === 0) throw new SafeError("No .docx files found");
    if (!only) result.filesRemoved = await removeStale(db);

    const prepare = async (row: FileRow): Promise<PreparedFile | null> => {
      let buffer: Buffer;
      try {
        buffer = await readBlob(row.storage_path!);
      } catch (err) {
        fail(row, "download_failed", err);
        return null;
      }
      filesRead++;
      const hash = createHash("sha256").update(buffer).digest("hex");
      const metadata = extractMetadataFromPath(folderPath(row, dirs), row.name);
      const state = states.get(row.id);
      const sameVersion = state?.pipeline_version === PIPELINE_VERSION;
      if (state && sameVersion && state.content_hash === hash && state.source === metadata.source) {
        result.filesSkipped++;
        result.chunksIndexed += state.chunk_count;
        return null;
      }
      let chunks: PreparedChunk[];
      try {
        const docs = await chunkDocument(buffer, metadata);
        chunks = docs.map((d) => ({ content: d.pageContent, metadata: d.metadata }));
      } catch (err) {
        fail(row, "failed", err);
        return null;
      }
      // A rename or partial edit keeps the vectors of chunks whose text is unchanged.
      const reusable = new Map<string, string>();
      if (sameVersion) {
        const { rows } = await db.query<{ content: string; embedding: string }>(
          "SELECT content, embedding::text AS embedding FROM document_chunks WHERE file_id = $1",
          [row.id]
        );
        for (const r of rows) reusable.set(r.content, r.embedding);
      }
      return { row, hash, source: metadata.source, chunks, reusable };
    };

    for (let i = 0; i < docx.length; i += DOWNLOAD_CONCURRENCY) {
      signal.throwIfAborted();
      const prepared = await Promise.all(docx.slice(i, i + DOWNLOAD_CONCURRENCY).map(prepare));
      for (const file of prepared) if (file) pending.push(file);
      if (missingTexts(pending).length >= EMBED_BATCH_SIZE) await flush();
      if (filesRead - lastProgress >= PROGRESS_EVERY_FILES) {
        lastProgress = filesRead;
        await writeLog();
      }
    }
    await flush();

    if (result.filesIndexed + result.filesSkipped === 0) {
      throw new SafeError("No files could be indexed");
    }
    await writeLog({ status: "success", finished: true });
    return result;
  } catch (err) {
    await writeLog({
      status: "failed",
      finished: true,
      error: describeError(signal.aborted ? signal.reason : err),
    });
    throw err;
  }
}

export interface ReindexHandle {
  logId: string;
  done: Promise<ReindexResult>;
}

/**
 * Takes the service lock and starts the run. Resolves once the run is under
 * way; throws 503 without an embedder and 409 when a run is already active.
 * The lock lives on its own connection, so it is released if the process dies.
 */
export async function startReindex(
  trigger: SyncTrigger,
  overrides: ReindexOverrides = {}
): Promise<ReindexHandle> {
  const embedder = overrides.embedder ?? getEmbedder();
  const db = overrides.db ?? getPool();
  const readBlob = overrides.readBlob ?? ((path: string) => getObjectBuffer(path));

  const lock = new pg.Client({
    connectionString: overrides.connectionString ?? config.databaseUrl,
  });
  const abort = new AbortController();
  lock.on("error", () => abort.abort(new SafeError("Lost the reindex lock connection")));
  await lock.connect();

  let logId: string;
  try {
    const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS ok", [
      LOCK_NAMESPACE,
      0,
    ]);
    if (!rows[0]?.ok) throw conflict("A reindex is already running for this system");

    // Holding the lock proves any row still "running" belongs to a dead process.
    await db.query(
      `UPDATE sync_logs SET status = 'failed', finished_at = now(),
         error_message = 'Interrupted: the process stopped before finishing'
       WHERE target = $1 AND status = 'running'`,
      [config.knowledgeBaseName]
    );
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO sync_logs (target, trigger, pinecone_index, status)
       VALUES ($1, $2, $3, 'running') RETURNING id`,
      [config.knowledgeBaseName, trigger, INDEX_NAME]
    );
    logId = inserted.rows[0]!.id;
  } catch (err) {
    await lock.end().catch(() => undefined);
    throw err;
  }

  const done = runReindex(logId, db, embedder, readBlob, overrides, abort.signal).finally(() =>
    lock.end().catch(() => undefined)
  );
  return { logId, done };
}

import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import express, { Router, type Request, type RequestHandler, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { hasPermission, requirePermission } from "../http/context.js";
import { badRequest, conflict, HttpError, notFound, parse } from "../http/errors.js";
import { VISIBLE_FILES } from "../rag/retrieval.js";
import { getObjectStream, MAX_FILE_BYTES, putObject, removeObjects } from "../services/storage.js";

export const filesRouter = Router({ mergeParams: true });

const PAGE_SIZE = 1000; // Same page cap as PostgREST max_rows, which the frontend already pages against.
const MAX_BATCH_IDS = 1000;
const MAX_GRANT_IDS = 50_000;
const MAX_DIRECTORY_PATHS = 5000;
const MAX_DIRECTORY_DEPTH = 32;
const FILE_COLUMNS = `id, name, is_directory, parent_id, group_id, storage_path, mime_type,
  size_bytes, uploaded_by, created_at, updated_at`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });

const entryName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !/[\u0000-\u001f\u007f/\\]/.test(n) && n !== "." && n !== "..", "Invalid name");

const groupName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((n) => !/[\u0000-\u001f\u007f]/.test(n), "Invalid name");

const paging = {
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE).default(PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
};

// A blank or "null" parent means the group root.
const parentQuery = z
  .union([uuid, z.literal(""), z.literal("null")])
  .optional()
  .transform((v) => (v && v !== "null" ? v : null));

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(;\s*charset=[a-z0-9_-]+)?$/i;
const mimeType = z.string().max(255).regex(MIME, "Invalid MIME type");

const listQuery = z.object({ group_id: uuid, parent_id: parentQuery, ...paging });
const treeQuery = z.object({
  group_id: uuid,
  directories_only: z.enum(["true", "false"]).default("false"),
  ...paging,
});
const lookupQuery = z.object({
  ids: z
    .string()
    .max(MAX_BATCH_IDS * 37)
    .transform((v) => [...new Set(v.split(",").filter(Boolean))])
    .pipe(z.array(uuid).min(1).max(MAX_BATCH_IDS)),
});
const directoryBody = z
  .object({ name: entryName, group_id: uuid, parent_id: uuid.nullable().default(null) })
  .strict();
const ensureDirectoriesBody = z
  .object({
    group_id: uuid,
    parent_id: uuid.nullable().default(null),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_DIRECTORY_PATHS),
  })
  .strict();
const uploadQuery = z.object({
  name: entryName,
  group_id: uuid,
  parent_id: parentQuery,
  mime_type: mimeType.optional(),
});
const replaceQuery = z.object({ mime_type: mimeType.optional() });
const updateBody = z
  .object({ name: entryName.optional(), parent_id: uuid.nullable().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.parent_id !== undefined, "Nothing to update");
const batchDeleteBody = z.object({ ids: z.array(uuid).min(1).max(MAX_BATCH_IDS) }).strict();
const sourceBody = z.object({ source: z.string().min(1).max(2048) }).strict();
const groupBody = z.object({ name: groupName }).strict();

const grantSubject = {
  user_id: uuid.optional(),
  group_id: uuid.optional(),
};
const oneSubject = (v: { user_id?: string; group_id?: string }) => Boolean(v.user_id) !== Boolean(v.group_id);
const grantsQuery = z
  .object({ ...grantSubject, ...paging })
  .refine(oneSubject, "Exactly one of user_id or group_id is required");
const idList = z.array(uuid).max(MAX_GRANT_IDS).default([]);
const saveGrantsBody = z
  .object({
    ...grantSubject,
    view_file_ids: idList,
    manage_file_ids: idList,
    remove_file_ids: idList,
  })
  .strict()
  .refine(oneSubject, "Exactly one of user_id or group_id is required");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Queryable = pg.Pool | pg.PoolClient;

interface FileRow {
  id: string;
  name: string;
  is_directory: boolean;
  parent_id: string | null;
  group_id: string;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
}

const canManageFiles = (req: Request) => hasPermission(req, "manage_files");
const canViewGroups = (req: Request) =>
  ["manage_files", "manage_faq", "manage_file_access", "manage_content_groups"].some((p) =>
    hasPermission(req, p)
  );

/** Same object-key rule as the frontend: ASCII only, never a path separator. */
function toStorageSafeName(name: string): string {
  const safe = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(-200);
  return safe.replace(/^[._]+$/, "") || "file";
}

/** Keys are always server-generated, so a client can't traverse or hit another file's blob. */
const newStoragePath = (userId: string, name: string) => `${userId}/${randomUUID()}/${toStorageSafeName(name)}`;

function contentDisposition(name: string): string {
  const fallback =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;%]/g, "_")
      .trim() || "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Types a browser could execute are never echoed back, even as an attachment. */
function safeContentType(...candidates: (string | null | undefined)[]): string {
  const type = candidates.find((c) => c && MIME.test(c) && c !== "application/octet-stream");
  if (!type || /[/+](x?html|svg|xml)([+;\s]|$)|javascript|ecmascript/i.test(type)) return "application/octet-stream";
  return type;
}

async function streamFile(
  res: Response,
  file: { name: string; storage_path: string; mime_type: string | null }
): Promise<void> {
  const object = await getObjectStream(file.storage_path);
  res.setHeader("Content-Type", safeContentType(object.contentType, file.mime_type));
  res.setHeader("Content-Disposition", contentDisposition(file.name));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (object.contentLength !== undefined) res.setHeader("Content-Length", object.contentLength);
  try {
    await pipeline(object.stream, res);
  } catch (err) {
    // The client went away, or the blob stream broke after headers were sent.
    if ((err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") {
      console.error("File stream failed:", (err as Error).message);
    }
    res.destroy();
  }
}

/** Blob cleanup runs after commit. A failure leaves an orphan blob, never a broken row. */
async function removeBlobsAfterCommit(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await removeObjects(paths);
  } catch (err) {
    console.error(`Blob cleanup failed for ${paths.length} object(s):`, (err as Error).message);
  }
}

/** Of the given paths, those no remaining row points at. */
async function unreferencedPaths(db: Queryable, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { rows } = await db.query<{ path: string }>(
    `SELECT unnest($1::text[]) AS path
     EXCEPT
     SELECT storage_path FROM files WHERE storage_path IS NOT NULL`,
    [paths]
  );
  return rows.map((r) => r.path);
}

/** Confirms the group exists and that the parent, if any, is a directory inside it. */
async function assertPlacement(db: Queryable, groupId: string, parentId: string | null, lock = false) {
  const { rows } = await db.query<{ group_exists: boolean; parent_group: string | null; parent_is_dir: boolean | null }>(
    `SELECT EXISTS (SELECT 1 FROM file_groups WHERE id = $1) AS group_exists,
            p.group_id AS parent_group, p.is_directory AS parent_is_dir
     FROM (SELECT 1) AS one
     LEFT JOIN LATERAL (
       SELECT group_id, is_directory FROM files WHERE id = $2 ${lock ? "FOR KEY SHARE" : ""}
     ) p ON true`,
    [groupId, parentId]
  );
  const row = rows[0];
  if (!row?.group_exists) throw notFound("File group not found");
  if (parentId && (row.parent_group !== groupId || !row.parent_is_dir)) {
    throw badRequest("parent_id must be a directory in the same file group");
  }
}

// Deletes whole subtrees atomically. Directories are locked first, repeating until the set
// is stable, so a concurrent insert can't be cascaded away without its blob being collected.
async function deleteTrees(db: pg.Pool, ids: string[]): Promise<number> {
  const { deleted, orphaned } = await withTransaction(db, async (client) => {
    let previous = -1;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { rows } = await client.query<{ n: number }>(
        `WITH RECURSIVE tree AS (
           SELECT id FROM files WHERE id = ANY($1::uuid[])
           UNION
           SELECT c.id FROM files c JOIN tree ON c.parent_id = tree.id
         ), locked AS (
           SELECT f.id FROM files f WHERE f.id IN (SELECT id FROM tree) ORDER BY f.id FOR UPDATE OF f
         )
         SELECT count(*)::int AS n FROM locked`,
        [ids]
      );
      const count = rows[0]?.n ?? 0;
      if (count === previous) break;
      previous = count;
    }
    const removed = await client.query<{ storage_path: string | null }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM files WHERE id = ANY($1::uuid[])
         UNION
         SELECT c.id FROM files c JOIN tree ON c.parent_id = tree.id
       )
       DELETE FROM files f USING tree WHERE f.id = tree.id
       RETURNING f.storage_path`,
      [ids]
    );
    const paths = removed.rows.flatMap((r) => (r.storage_path ? [r.storage_path] : []));
    return { deleted: removed.rowCount ?? 0, orphaned: await unreferencedPaths(client, paths) };
  });
  await removeBlobsAfterCommit(orphaned);
  return deleted;
}

function splitDirectoryPath(path: string): string[] {
  const segments = path.split("/").map((s) => parse(entryName, s));
  if (segments.length > MAX_DIRECTORY_DEPTH) throw badRequest("Folder path is too deep");
  return segments;
}

// The body must be octet-stream: the global JSON parser would otherwise consume JSON uploads.
const requireBinaryBody: RequestHandler = (req, _res, next) => {
  const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] ?? 0) > 0;
  if (hasBody && !req.is("application/octet-stream")) {
    throw new HttpError(415, "Upload must use Content-Type: application/octet-stream", "unsupported_media_type");
  }
  next();
};
const rawBody = express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES });
const uploadedBuffer = (req: Request): Buffer => (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));

// ---------------------------------------------------------------------------
// Files: reads. Without manage_files these match RLS: empty results, not errors.
// ---------------------------------------------------------------------------

filesRouter.get("/files", async (req, res) => {
  const q = parse(listQuery, req.query);
  if (!canManageFiles(req)) {
    res.json([]);
    return;
  }
  const { rows } = await req.db.query(
    `SELECT f.id, f.name, f.is_directory, f.parent_id, f.group_id, f.storage_path, f.mime_type,
            f.size_bytes, f.uploaded_by, f.created_at, f.updated_at,
            CASE WHEN p.id IS NULL THEN NULL
                 ELSE json_build_object('full_name', p.full_name, 'email', p.email) END AS uploader
     FROM files f
     LEFT JOIN profiles p ON p.id = f.uploaded_by
     WHERE f.group_id = $1 AND f.parent_id IS NOT DISTINCT FROM $2::uuid
     ORDER BY f.is_directory DESC, f.name, f.id
     LIMIT $3 OFFSET $4`,
    [q.group_id, q.parent_id, q.limit, q.offset]
  );
  res.json(rows);
});

filesRouter.get("/files/tree", async (req, res) => {
  const q = parse(treeQuery, req.query);
  if (!canManageFiles(req)) {
    res.json([]);
    return;
  }
  const { rows } = await req.db.query(
    `SELECT id, name, is_directory, parent_id
     FROM files
     WHERE group_id = $1 AND ($2::boolean = false OR is_directory)
     ORDER BY is_directory DESC, name, id
     LIMIT $3 OFFSET $4`,
    [q.group_id, q.directories_only === "true", q.limit, q.offset]
  );
  res.json(rows);
});

filesRouter.get("/files/lookup", async (req, res) => {
  const { ids } = parse(lookupQuery, req.query);
  if (!canManageFiles(req)) {
    res.json([]);
    return;
  }
  const { rows } = await req.db.query(`SELECT id, name, group_id FROM files WHERE id = ANY($1::uuid[])`, [ids]);
  res.json(rows);
});

filesRouter.get("/files/:id/breadcrumbs", async (req, res) => {
  const { id } = parse(idParams, req.params);
  if (!canManageFiles(req)) {
    res.json([]);
    return;
  }
  const { rows } = await req.db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, name, parent_id, 0 AS depth, ARRAY[id] AS seen FROM files WHERE id = $1
       UNION ALL
       SELECT f.id, f.name, f.parent_id, c.depth + 1, c.seen || f.id
       FROM files f JOIN chain c ON f.id = c.parent_id
       WHERE NOT f.id = ANY(c.seen)
     )
     SELECT id, name FROM chain ORDER BY depth DESC`,
    [id]
  );
  res.json(rows);
});

filesRouter.get("/files/:id/content", requirePermission("manage_files"), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { rows } = await req.db.query<FileRow>(
    `SELECT name, storage_path, mime_type FROM files WHERE id = $1 AND NOT is_directory AND storage_path IS NOT NULL`,
    [id]
  );
  const file = rows[0];
  if (!file?.storage_path) throw notFound("File not found");
  await streamFile(res, { name: file.name, storage_path: file.storage_path, mime_type: file.mime_type });
});

filesRouter.get("/files/:id", async (req, res) => {
  const { id } = parse(idParams, req.params);
  if (!canManageFiles(req)) throw notFound("File not found");
  const { rows } = await req.db.query(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound("File not found");
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// Files: writes (manage_files)
// ---------------------------------------------------------------------------

filesRouter.post("/files/directories", requirePermission("manage_files"), async (req, res) => {
  const body = parse(directoryBody, req.body);
  await assertPlacement(req.db, body.group_id, body.parent_id);
  const { rows } = await req.db.query(
    `INSERT INTO files (name, is_directory, parent_id, group_id, uploaded_by)
     VALUES ($1, true, $2, $3, $4) RETURNING ${FILE_COLUMNS}`,
    [body.name, body.parent_id, body.group_id, req.user.id]
  );
  res.status(201).json(rows[0]);
});

// Folder upload: resolves or creates every folder level in one transaction, one statement pair per depth.
filesRouter.post("/files/directories/ensure", requirePermission("manage_files"), async (req, res) => {
  const body = parse(ensureDirectoriesBody, req.body);

  const levels: Map<string, { name: string; parentPath: string }>[] = [];
  for (const raw of new Set(body.paths)) {
    const segments = splitDirectoryPath(raw);
    segments.forEach((name, depth) => {
      const path = segments.slice(0, depth + 1).join("/");
      const level = (levels[depth] ??= new Map());
      level.set(path, { name, parentPath: segments.slice(0, depth).join("/") });
    });
  }

  const resolved = await withTransaction(req.db, async (client) => {
    await assertPlacement(client, body.group_id, body.parent_id, true);
    const ids = new Map<string, string | null>([["", body.parent_id]]);
    for (const level of levels) {
      const paths = [...level.keys()];
      const names = paths.map((p) => level.get(p)!.name);
      const parents = paths.map((p) => ids.get(level.get(p)!.parentPath) ?? null);
      await client.query(
        `INSERT INTO files (name, is_directory, parent_id, group_id, uploaded_by)
         SELECT t.name, true, t.parent_id, $3::uuid, $4::uuid
         FROM unnest($1::text[], $2::uuid[]) AS t(name, parent_id)
         ON CONFLICT DO NOTHING`,
        [names, parents, body.group_id, req.user.id]
      );
      const { rows } = await client.query<{ path: string; id: string | null; is_directory: boolean | null }>(
        `SELECT t.path, f.id, f.is_directory
         FROM unnest($1::text[], $2::text[], $3::uuid[]) AS t(path, name, parent_id)
         LEFT JOIN files f ON f.group_id = $4 AND f.name = t.name
           AND f.parent_id IS NOT DISTINCT FROM t.parent_id`,
        [paths, names, parents, body.group_id]
      );
      for (const row of rows) {
        if (!row.id || !row.is_directory) throw conflict(`A file already exists at "${row.path}"`);
        ids.set(row.path, row.id);
      }
    }
    ids.delete("");
    return ids;
  });
  res.json({ directories: Object.fromEntries(resolved) });
});

filesRouter.post("/files/batch-delete", requirePermission("manage_files"), async (req, res) => {
  const { ids } = parse(batchDeleteBody, req.body);
  const deleted = await deleteTrees(req.db, [...new Set(ids)]);
  res.json({ message: "Deleted successfully", deleted });
});

// Metadata travels in the query so the body can stay raw. Checks run before the body is buffered.
filesRouter.post(
  "/files/upload",
  requirePermission("manage_files"),
  requireBinaryBody,
  async (req, res, next) => {
    const q = parse(uploadQuery, req.query);
    await assertPlacement(req.db, q.group_id, q.parent_id);
    res.locals.upload = q;
    next();
  },
  rawBody,
  async (req, res) => {
    const q = res.locals.upload as z.output<typeof uploadQuery>;
    const data = uploadedBuffer(req);
    const mime = q.mime_type ?? "application/octet-stream";
    const storagePath = newStoragePath(req.user.id, q.name);

    await putObject(storagePath, data, mime);
    try {
      const { rows } = await req.db.query(
        `INSERT INTO files (name, is_directory, parent_id, group_id, storage_path, mime_type, size_bytes, uploaded_by)
         VALUES ($1, false, $2, $3, $4, $5, $6, $7) RETURNING ${FILE_COLUMNS}`,
        [q.name, q.parent_id, q.group_id, storagePath, mime, data.length, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      await removeBlobsAfterCommit([storagePath]);
      throw err;
    }
  }
);

// Writes a new blob and swaps the row to it, so a failed upload never damages the current content.
filesRouter.put(
  "/files/:id/content",
  requirePermission("manage_files"),
  requireBinaryBody,
  async (req, res, next) => {
    const { id } = parse(idParams, req.params);
    const q = parse(replaceQuery, req.query);
    const { rows } = await req.db.query<FileRow>(
      `SELECT id, name, mime_type FROM files WHERE id = $1 AND NOT is_directory AND storage_path IS NOT NULL`,
      [id]
    );
    if (!rows[0]) throw notFound("File not found");
    res.locals.target = { ...rows[0], contentType: q.mime_type ?? rows[0].mime_type ?? "application/octet-stream" };
    next();
  },
  rawBody,
  async (req, res) => {
    const target = res.locals.target as { id: string; name: string; contentType: string };
    const data = uploadedBuffer(req);
    const storagePath = newStoragePath(req.user.id, target.name);
    await putObject(storagePath, data, target.contentType);

    let swapped: { row: Record<string, unknown>; orphaned: string[] } | null;
    try {
      swapped = await withTransaction(req.db, async (client) => {
        const { rows } = await client.query<Record<string, unknown> & { previous_path: string }>(
          `WITH old AS (
             SELECT id, storage_path FROM files
             WHERE id = $1 AND NOT is_directory AND storage_path IS NOT NULL
             FOR UPDATE
           ), updated AS (
             UPDATE files f SET storage_path = $2, size_bytes = $3
             FROM old WHERE f.id = old.id
             RETURNING f.id, f.name, f.is_directory, f.parent_id, f.group_id, f.storage_path,
                       f.mime_type, f.size_bytes, f.uploaded_by, f.created_at, f.updated_at
           )
           SELECT updated.*, old.storage_path AS previous_path FROM updated JOIN old USING (id)`,
          [target.id, storagePath, data.length]
        );
        if (!rows[0]) return null;
        const { previous_path: previous, ...row } = rows[0];
        return { row, orphaned: await unreferencedPaths(client, [previous]) };
      });
    } catch (err) {
      await removeBlobsAfterCommit([storagePath]);
      throw err;
    }
    if (!swapped) {
      await removeBlobsAfterCommit([storagePath]);
      throw notFound("File not found");
    }
    await removeBlobsAfterCommit(swapped.orphaned);
    res.json(swapped.row);
  }
);

filesRouter.patch("/files/:id", requirePermission("manage_files"), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(updateBody, req.body);

  const row = await withTransaction(req.db, async (client) => {
    const current = await client.query<{ group_id: string }>(`SELECT group_id FROM files WHERE id = $1`, [id]);
    const groupId = current.rows[0]?.group_id;
    if (!groupId) throw notFound("File not found");

    if (body.parent_id !== undefined) {
      // Serializes moves per group, so two concurrent moves can't combine into a cycle.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`files-tree:${groupId}`]);
      if (body.parent_id) {
        await assertPlacement(client, groupId, body.parent_id, true);
        const cycle = await client.query(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM files WHERE id = $1
             UNION
             SELECT f.id, f.parent_id FROM files f JOIN ancestors a ON f.id = a.parent_id
           )
           SELECT 1 FROM ancestors WHERE id = $2 LIMIT 1`,
          [body.parent_id, id]
        );
        if (cycle.rowCount) throw badRequest("A folder cannot be moved into itself");
      }
    }

    const { rows } = await client.query(
      `UPDATE files
       SET name = COALESCE($2, name),
           parent_id = CASE WHEN $3::boolean THEN $4::uuid ELSE parent_id END
       WHERE id = $1
       RETURNING ${FILE_COLUMNS}`,
      [id, body.name ?? null, body.parent_id !== undefined, body.parent_id ?? null]
    );
    return rows[0];
  });
  if (!row) throw notFound("File not found");
  res.json(row);
});

// Like the edge function, deleting an id that is already gone succeeds.
filesRouter.delete("/files/:id", requirePermission("manage_files"), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const deleted = await deleteTrees(req.db, [id]);
  res.json({ message: "Deleted successfully", deleted });
});

// ---------------------------------------------------------------------------
// Source downloads and templates: files granted to the user. manage_files sees all.
// ---------------------------------------------------------------------------

filesRouter.post("/source-files/download", async (req, res) => {
  const { source } = parse(sourceBody, req.body);
  // Sources may be a bare name or carry a path prefix, so match on the basename.
  const basename = source.split("/").pop()!.trim();
  if (!basename || basename.includes("\u0000")) throw notFound("Source file not found");

  const { rows } = await req.db.query<{ name: string; storage_path: string; mime_type: string | null }>(
    `WITH RECURSIVE ${VISIBLE_FILES}
     SELECT name, storage_path, mime_type FROM files
     WHERE NOT is_directory AND name = $2 AND storage_path IS NOT NULL
       AND ($3::boolean OR id IN (SELECT id FROM visible))
     ORDER BY created_at, id
     LIMIT 2`,
    [req.user.id, basename, canManageFiles(req)]
  );
  const file = rows[0];
  if (!file) throw notFound("Source file not found");
  res.setHeader("X-Source-Ambiguous", rows.length > 1 ? "true" : "false");
  await streamFile(res, file);
});

filesRouter.get("/templates", async (req, res) => {
  const q = parse(z.object(paging), req.query);
  const { rows } = await req.db.query<{ total: number }>(
    `WITH RECURSIVE ${VISIBLE_FILES}
     SELECT id, name, mime_type, size_bytes, updated_at, count(*) OVER()::int AS total
     FROM files
     WHERE NOT is_directory AND storage_path IS NOT NULL
       AND ($2::boolean OR id IN (SELECT id FROM visible))
     ORDER BY name, id
     LIMIT $3 OFFSET $4`,
    [req.user.id, canManageFiles(req), q.limit, q.offset]
  );
  const total = rows[0]?.total ?? 0;
  res.json({ files: rows.map(({ total: _total, ...file }) => file), total });
});

// ---------------------------------------------------------------------------
// File groups
// ---------------------------------------------------------------------------

filesRouter.get("/file-groups", async (req, res) => {
  if (!canViewGroups(req)) {
    res.json([]);
    return;
  }
  const { rows } = await req.db.query(
    `SELECT id, name, is_default, created_by, created_at, updated_at
     FROM file_groups ORDER BY is_default DESC, name`
  );
  res.json(rows);
});

filesRouter.post("/file-groups", requirePermission("manage_content_groups"), async (req, res) => {
  const { name } = parse(groupBody, req.body);
  const { rows } = await req.db.query(
    `INSERT INTO file_groups (name, created_by) VALUES ($1, $2)
     RETURNING id, name, is_default, created_by, created_at, updated_at`,
    [name, req.user.id]
  );
  res.status(201).json(rows[0]);
});

filesRouter.patch("/file-groups/:id", requirePermission("manage_content_groups"), async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { name } = parse(groupBody, req.body);
  const { rows } = await req.db.query(
    `UPDATE file_groups SET name = $2 WHERE id = $1
     RETURNING id, name, is_default, created_by, created_at, updated_at`,
    [id, name]
  );
  if (!rows[0]) throw notFound("File group not found");
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// File permissions
// ---------------------------------------------------------------------------

filesRouter.get("/file-permissions", async (req, res) => {
  const q = parse(grantsQuery, req.query);
  // RLS: access managers see all grants; anyone else only rows granted directly to them.
  if (!hasPermission(req, "manage_file_access") && q.user_id !== req.user.id) {
    throw new HttpError(403, "Missing permission: manage_file_access", "forbidden");
  }
  // The embedded file is subject to the files policy, so it is null without manage_files.
  const { rows } = await req.db.query(
    `SELECT fp.file_id, fp.access_level,
            CASE WHEN $4::boolean
                 THEN json_build_object('group_id', f.group_id, 'is_directory', f.is_directory)
                 ELSE NULL END AS files
     FROM file_permissions fp
     JOIN files f ON f.id = fp.file_id
     WHERE fp.${q.user_id ? "user_id" : "group_id"} = $1
     ORDER BY fp.id
     LIMIT $2 OFFSET $3`,
    [q.user_id ?? q.group_id, q.limit, q.offset, canManageFiles(req)]
  );
  res.json(rows);
});

// Applies a whole grant diff atomically, replacing the frontend's sequential batches.
filesRouter.put("/file-permissions", requirePermission("manage_file_access"), async (req, res) => {
  const body = parse(saveGrantsBody, req.body);
  const seen = new Set<string>();
  for (const id of [...body.view_file_ids, ...body.manage_file_ids, ...body.remove_file_ids]) {
    if (seen.has(id)) throw badRequest("A file id may appear only once");
    seen.add(id);
  }
  const userId = body.user_id ?? null;
  const groupId = body.group_id ?? null;
  const fileIds = [...body.view_file_ids, ...body.manage_file_ids];
  const levels = [
    ...body.view_file_ids.map(() => "view"),
    ...body.manage_file_ids.map(() => "manage"),
  ];

  const result = await withTransaction(req.db, async (client) => {
    let removed = 0;
    if (body.remove_file_ids.length > 0) {
      const del = await client.query(
        `DELETE FROM file_permissions
         WHERE file_id = ANY($1::uuid[])
           AND user_id IS NOT DISTINCT FROM $2::uuid
           AND group_id IS NOT DISTINCT FROM $3::uuid`,
        [body.remove_file_ids, userId, groupId]
      );
      removed = del.rowCount ?? 0;
    }
    let saved = 0;
    if (fileIds.length > 0) {
      const upsert = await client.query(
        `INSERT INTO file_permissions (file_id, user_id, group_id, access_level, granted_by)
         SELECT t.file_id, $3::uuid, $4::uuid, t.level::file_access_level, $5::uuid
         FROM unnest($1::uuid[], $2::text[]) AS t(file_id, level)
         ON CONFLICT ON CONSTRAINT uq_file_permissions_subject
         DO UPDATE SET access_level = EXCLUDED.access_level, granted_by = EXCLUDED.granted_by`,
        [fileIds, levels, userId, groupId, req.user.id]
      );
      saved = upsert.rowCount ?? 0;
    }
    return { saved, removed };
  });
  res.json(result);
});

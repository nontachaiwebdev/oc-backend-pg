import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../http/context.js";
import { notFound, parse } from "../../http/errors.js";

export const syncLogsRouter = Router({ mergeParams: true });

const PAGE_SIZE = 50;

// Everything except `details`, which can hold one entry per file.
const LIST_COLUMNS =
  "id, target, trigger, directory_id, pinecone_index, status, files_found, files_downloaded, " +
  "files_failed, chunks_indexed, error_message, started_at, finished_at, duration_ms";

const listQuery = z.object({
  target: z.string().trim().min(1).max(100).default("all"),
  status: z.enum(["all", "running", "success", "failed"]).default("all"),
  page: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

syncLogsRouter.use(requirePermission("view_sync_logs"));

syncLogsRouter.get("/", async (req, res) => {
  const { target, status, page } = parse(listQuery, req.query);
  const targetFilter = target === "all" ? null : target;
  const statusFilter = status === "all" ? null : status;
  const where = "($1::text IS NULL OR target = $1) AND ($2::text IS NULL OR status = $2)";

  const [{ rows: logs }, { rows: counts }] = await Promise.all([
    req.db.query<{ directory_id: string | null }>(
      `SELECT ${LIST_COLUMNS} FROM sync_logs WHERE ${where}
       ORDER BY started_at DESC, id LIMIT $3 OFFSET $4`,
      [targetFilter, statusFilter, PAGE_SIZE, page * PAGE_SIZE]
    ),
    req.db.query<{ total: number }>(`SELECT count(*) AS total FROM sync_logs WHERE ${where}`, [
      targetFilter,
      statusFilter,
    ]),
  ]);

  // The old client read names from `files`, whose only SELECT policy is manage_files.
  // Without it the page falls back to showing the id, as it did under RLS.
  const directory_names: Record<string, string> = {};
  const dirIds = [...new Set(logs.map((l) => l.directory_id).filter((id): id is string => !!id))];
  if (dirIds.length > 0 && req.user.permissions.has("manage_files")) {
    const { rows } = await req.db.query<{ id: string; name: string }>(
      "SELECT id, name FROM files WHERE id = ANY($1::uuid[])",
      [dirIds]
    );
    for (const row of rows) directory_names[row.id] = row.name;
  }

  res.json({ logs, total: counts[0]?.total ?? 0, directory_names });
});

syncLogsRouter.get("/:id/details", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { rows } = await req.db.query<{ details: unknown }>("SELECT details FROM sync_logs WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("Sync log not found");
  res.json({ details: rows[0].details ?? [] });
});

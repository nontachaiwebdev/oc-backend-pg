import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../http/context.js";
import { badRequest, forbidden, notFound, parse } from "../../http/errors.js";
import { withTransaction } from "../../db/pool.js";

export const faqRouter = Router({ mergeParams: true });

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const int4 = z.number().int().min(-2147483648).max(2147483647);

// Mirrors the RLS policies on faq_sections, faq_items and faq_permissions.
const canReadAdmin = requirePermission("manage_faq", "manage_file_access");
const canWriteContent = requirePermission("manage_faq");
const canWriteGrants = requirePermission("manage_file_access");

const SECTION_COLUMNS = "id, title, description, sort_order, is_active, group_id, created_at, updated_at";
const ITEM_COLUMNS = "id, section_id, question, answer, sort_order, is_active, created_at, updated_at";

const description = z
  .string()
  .nullable()
  .transform((v) => v?.trim() || null);

const sectionCreate = z.object({
  title: z.string().trim().min(1),
  description: description.optional().transform((v) => v ?? null),
  sort_order: int4.default(0),
  is_active: z.boolean().default(true),
  // The admin form has no group picker, so a new section goes in the default group.
  group_id: uuid.optional(),
});

const sectionPatch = z
  .object({
    title: z.string().trim().min(1),
    description,
    sort_order: int4,
    is_active: z.boolean(),
    group_id: uuid,
  })
  .partial()
  .strict();

const itemCreate = z.object({
  section_id: uuid,
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
  sort_order: int4.default(0),
  is_active: z.boolean().default(true),
});

const itemPatch = z
  .object({
    section_id: uuid,
    question: z.string().trim().min(1),
    answer: z.string().trim().min(1),
    sort_order: int4,
    is_active: z.boolean(),
  })
  .partial()
  .strict();

/** Builds a SET clause. Keys come from a strict zod schema, never from raw input. */
function setClause(patch: Record<string, unknown>) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw badRequest("No fields to update");
  return {
    sql: entries.map(([column], i) => `"${column}" = $${i + 1}`).join(", "),
    values: entries.map(([, value]) => value),
  };
}

// Replaces the list-faq edge function. Grants are used for filtering and never returned.
faqRouter.get("/", async (req, res) => {
  const isFaqAdmin = req.user.permissions.has("manage_faq");
  if (!req.user.permissions.has("view_faq") && !isFaqAdmin) throw forbidden("Forbidden");

  const { rows: sections } = await req.db.query<{ id: string }>(
    `SELECT ${SECTION_COLUMNS} FROM faq_sections WHERE is_active = true ORDER BY sort_order, id`
  );
  const { rows: items } = await req.db.query<{ section_id: string }>(
    `SELECT i.id, i.section_id, i.question, i.answer, i.sort_order, i.is_active, i.created_at, i.updated_at
     FROM faq_items i
     JOIN faq_sections s ON s.id = i.section_id AND s.is_active = true
     WHERE i.is_active = true
       AND ($2::boolean OR EXISTS (
         SELECT 1 FROM faq_permissions p
         WHERE p.item_id = i.id
           AND (p.user_id = $1 OR p.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1))
       ))
     ORDER BY i.sort_order, i.id`,
    [req.user.id, isFaqAdmin]
  );

  const bySection = new Map<string, unknown[]>();
  for (const item of items) {
    const list = bySection.get(item.section_id);
    if (list) list.push(item);
    else bySection.set(item.section_id, [item]);
  }

  res.json({
    sections: sections
      .map((section) => ({ ...section, faq_items: bySection.get(section.id) ?? [] }))
      .filter((section) => section.faq_items.length > 0),
  });
});

faqRouter.get("/sections", canReadAdmin, async (req, res) => {
  const { group_id } = parse(z.object({ group_id: uuid.optional() }), req.query);
  const { rows } = await req.db.query(
    `SELECT ${SECTION_COLUMNS} FROM faq_sections
     WHERE ($1::uuid IS NULL OR group_id = $1) ORDER BY sort_order, id`,
    [group_id ?? null]
  );
  res.json(rows);
});

faqRouter.post("/sections", canWriteContent, async (req, res) => {
  const b = parse(sectionCreate, req.body ?? {});
  const { rows } = await req.db.query(
    `INSERT INTO faq_sections (title, description, sort_order, is_active, group_id)
     VALUES ($1, $2, $3, $4, COALESCE($5::uuid, (SELECT id FROM file_groups WHERE is_default)))
     RETURNING ${SECTION_COLUMNS}`,
    [b.title, b.description, b.sort_order, b.is_active, b.group_id ?? null]
  );
  res.status(201).json(rows[0]);
});

faqRouter.patch("/sections/:id", canWriteContent, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { sql, values } = setClause(parse(sectionPatch, req.body ?? {}));
  const { rows } = await req.db.query(
    `UPDATE faq_sections SET ${sql} WHERE id = $${values.length + 1} RETURNING ${SECTION_COLUMNS}`,
    [...values, id]
  );
  if (!rows[0]) throw notFound("Section not found");
  res.json(rows[0]);
});

// Idempotent, like the PostgREST delete it replaces. Cascades to items and their grants.
faqRouter.delete("/sections/:id", canWriteContent, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await req.db.query("DELETE FROM faq_sections WHERE id = $1", [id]);
  res.status(204).end();
});

// Keeps the embedded faq_permissions(count) shape PostgREST returned.
faqRouter.get("/items", canReadAdmin, async (req, res) => {
  const { section_id } = parse(z.object({ section_id: uuid.optional() }), req.query);
  const { rows } = await req.db.query<{ grant_count: number }>(
    `SELECT i.id, i.section_id, i.question, i.answer, i.sort_order, i.is_active, i.created_at, i.updated_at,
       (SELECT count(*) FROM faq_permissions p WHERE p.item_id = i.id) AS grant_count
     FROM faq_items i
     WHERE ($1::uuid IS NULL OR i.section_id = $1)
     ORDER BY i.sort_order, i.id`,
    [section_id ?? null]
  );
  res.json(rows.map(({ grant_count, ...item }) => ({ ...item, faq_permissions: [{ count: grant_count }] })));
});

faqRouter.post("/items", canWriteContent, async (req, res) => {
  const b = parse(itemCreate, req.body ?? {});
  const { rows } = await req.db.query(
    `INSERT INTO faq_items (section_id, question, answer, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${ITEM_COLUMNS}`,
    [b.section_id, b.question, b.answer, b.sort_order, b.is_active]
  );
  res.status(201).json(rows[0]);
});

faqRouter.patch("/items/:id", canWriteContent, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const { sql, values } = setClause(parse(itemPatch, req.body ?? {}));
  const { rows } = await req.db.query(
    `UPDATE faq_items SET ${sql} WHERE id = $${values.length + 1} RETURNING ${ITEM_COLUMNS}`,
    [...values, id]
  );
  if (!rows[0]) throw notFound("Item not found");
  res.json(rows[0]);
});

faqRouter.delete("/items/:id", canWriteContent, async (req, res) => {
  const { id } = parse(idParams, req.params);
  await req.db.query("DELETE FROM faq_items WHERE id = $1", [id]);
  res.status(204).end();
});

// The Behörigheter page: every section with its questions.
faqRouter.get("/access/sections", canReadAdmin, async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT s.id, s.title, s.group_id, s.is_active,
       COALESCE((
         SELECT json_agg(json_build_object('id', i.id, 'question', i.question, 'is_active', i.is_active)
                         ORDER BY i.sort_order, i.id)
         FROM faq_items i WHERE i.section_id = s.id
       ), '[]'::json) AS items
     FROM faq_sections s ORDER BY s.sort_order, s.id`
  );
  res.json(rows);
});

const subject = z
  .object({ user_id: uuid.optional(), group_id: uuid.optional() })
  .refine((s) => Boolean(s.user_id) !== Boolean(s.group_id), "Provide exactly one of user_id or group_id");

faqRouter.get("/permissions", canReadAdmin, async (req, res) => {
  const s = parse(subject, req.query);
  const { rows } = await req.db.query(
    s.user_id
      ? "SELECT item_id FROM faq_permissions WHERE user_id = $1"
      : "SELECT item_id FROM faq_permissions WHERE group_id = $1",
    [s.user_id ?? s.group_id]
  );
  res.json(rows);
});

const grantsBody = z
  .object({
    user_id: uuid.optional(),
    group_id: uuid.optional(),
    add: z.array(uuid).default([]),
    remove: z.array(uuid).default([]),
  })
  .refine((s) => Boolean(s.user_id) !== Boolean(s.group_id), "Provide exactly one of user_id or group_id");

// One atomic call for the add/remove diff useFaqAccess computes. granted_by is the caller.
faqRouter.put("/permissions", canWriteGrants, async (req, res) => {
  const b = parse(grantsBody, req.body ?? {});
  const add = [...new Set(b.add)];
  const remove = [...new Set(b.remove)];
  const userId = b.user_id ?? null;
  const groupId = b.group_id ?? null;

  await withTransaction(req.db, async (client) => {
    if (remove.length > 0) {
      await client.query(
        `DELETE FROM faq_permissions
         WHERE item_id = ANY($1::uuid[]) AND user_id IS NOT DISTINCT FROM $2::uuid
           AND group_id IS NOT DISTINCT FROM $3::uuid`,
        [remove, userId, groupId]
      );
    }
    if (add.length > 0) {
      await client.query(
        `INSERT INTO faq_permissions (item_id, user_id, group_id, granted_by)
         SELECT item_id, $2::uuid, $3::uuid, $4::uuid FROM unnest($1::uuid[]) AS item_id
         ON CONFLICT ON CONSTRAINT uq_faq_permissions_subject
         DO UPDATE SET granted_by = EXCLUDED.granted_by`,
        [add, userId, groupId, req.user.id]
      );
    }
  });
  res.json({ error: null });
});

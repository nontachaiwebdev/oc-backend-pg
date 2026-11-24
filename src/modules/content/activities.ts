import { Router, type RequestHandler } from "express";
import type pg from "pg";
import { z } from "zod";
import { withTransaction } from "../../db/pool.js";
import { badRequest, forbidden, HttpError, notFound, parse } from "../../http/errors.js";

export const activitiesRouter = Router({ mergeParams: true });

const RESTRICT_VIOLATION = "23001";
const FOREIGN_KEY_VIOLATION = "23503";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuid = z.string().regex(UUID, "Invalid id");
const idParams = z.object({ id: uuid });

const requireManage: RequestHandler = (req, _res, next) => {
  if (!req.user.permissions.has("manage_activities")) {
    throw forbidden("Forbidden: missing manage_activities permission");
  }
  next();
};

/** The edge functions answered 400 when a referenced row was missing. */
function rethrowForeignKey(err: unknown): never {
  if ((err as { code?: string })?.code === FOREIGN_KEY_VIOLATION) {
    throw badRequest("A referenced record does not exist");
  }
  throw err;
}

type Payload = {
  name?: string;
  type_id?: string;
  responsible_role?: string;
  document_ref?: string | null;
  file_id?: string | null;
  frequency?: string | null;
  recur_month?: number | null;
  recur_day?: number;
  requires_evidence?: boolean;
  visibility?: string | null;
  group_ids?: string[];
  user_ids?: string[];
};

// Same rules and messages as manage-activities.
function validate(p: Payload): string | null {
  if (!p.name?.trim()) return "name is required";
  if (!p.type_id) return "type_id is required";
  if (!p.responsible_role?.trim()) return "responsible_role is required";

  const frequency = p.frequency ?? "yearly";
  if (!["yearly", "quarterly", "monthly"].includes(frequency)) return "invalid frequency";

  if (!Number.isInteger(p.recur_day) || p.recur_day! < 1 || p.recur_day! > 28) {
    return "recur_day must be an integer between 1 and 28";
  }

  if (frequency === "monthly") {
    if (p.recur_month !== null && p.recur_month !== undefined) {
      return "recur_month must be null for a monthly activity";
    }
  } else {
    const max = frequency === "yearly" ? 12 : 3;
    if (!Number.isInteger(p.recur_month) || p.recur_month! < 1 || p.recur_month! > max) {
      return `recur_month must be an integer between 1 and ${max} for a ${frequency} activity`;
    }
  }

  const visibility = p.visibility ?? "all";
  if (!["all", "selected"].includes(visibility)) return "invalid visibility";
  if (visibility === "selected" && !(p.group_ids?.length || p.user_ids?.length)) {
    return "a restricted activity needs at least one group or user, otherwise nobody can see it";
  }

  if (!UUID.test(p.type_id)) return "type_id must be a UUID";
  if (p.file_id && !UUID.test(p.file_id)) return "file_id must be a UUID";
  return null;
}

const activityBody = z
  .object({
    name: z.string().optional(),
    type_id: z.string().optional(),
    responsible_role: z.string().optional(),
    document_ref: z.string().nullish(),
    file_id: z.string().nullish(),
    frequency: z.string().nullish(),
    recur_month: z.number().nullish(),
    recur_day: z.number().optional(),
    requires_evidence: z.boolean().optional(),
    visibility: z.string().nullish(),
    group_ids: z.array(uuid).optional(),
    user_ids: z.array(uuid).optional(),
  })
  .superRefine((p, ctx) => {
    const message = validate(p);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });

function columnsFrom(p: Payload) {
  const frequency = p.frequency ?? "yearly";
  return [
    p.name!.trim(),
    p.type_id!,
    p.responsible_role!.trim(),
    p.document_ref?.trim() || null,
    p.file_id || null,
    frequency,
    frequency === "monthly" ? null : p.recur_month!,
    p.recur_day!,
    !!p.requires_evidence,
    p.visibility ?? "all",
  ];
}

// Replaced wholesale, so a stale grant can never survive an edit.
async function replaceGrants(client: pg.PoolClient, activityId: string, callerId: string, p: Payload) {
  await client.query("DELETE FROM activity_visibility_grants WHERE activity_id = $1", [activityId]);
  if ((p.visibility ?? "all") !== "selected") return;

  const groupIds = [...new Set(p.group_ids ?? [])];
  const userIds = [...new Set(p.user_ids ?? [])];
  await client.query(
    `INSERT INTO activity_visibility_grants (activity_id, group_id, user_id, granted_by)
     SELECT $1::uuid, g, NULL::uuid, $4::uuid FROM unnest($2::uuid[]) AS g
     UNION ALL
     SELECT $1::uuid, NULL::uuid, u, $4::uuid FROM unnest($3::uuid[]) AS u`,
    [activityId, groupIds, userIds, callerId]
  );
}

const yearSchema = z.coerce
  .number({ invalid_type_error: "year must be an integer between 2000 and 2100" })
  .refine((y) => Number.isInteger(y) && y >= 2000 && y <= 2100, "year must be an integer between 2000 and 2100");

const pad = (n: number) => String(n).padStart(2, "0");

function monthsFor(frequency: string, recurMonth: number | null): number[] {
  if (frequency === "monthly") return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // recur_month is the month within the quarter, so 2 means Feb/May/Aug/Nov.
  if (frequency === "quarterly") return [0, 3, 6, 9].map((offset) => recurMonth! + offset);
  return [recurMonth!];
}

type CalendarRow = {
  id: string;
  visibility: string;
  frequency: string;
  recur_month: number | null;
  recur_day: number;
  activity_visibility_grants: { user_id: string | null; group_id: string | null }[];
};

// Replaces list-activities. Any authenticated user; visibility is applied per activity.
activitiesRouter.get("/", async (req, res) => {
  const year = parse(yearSchema, req.query.year);
  const isAdmin = req.user.permissions.has("manage_activities");

  const { rows: memberships } = await req.db.query<{ group_id: string }>(
    "SELECT group_id FROM group_members WHERE user_id = $1",
    [req.user.id]
  );
  const callerGroupIds = new Set(memberships.map((m) => m.group_id));

  const { rows: types } = await req.db.query(
    "SELECT id, code, name, color, sort_order FROM activity_types ORDER BY sort_order"
  );
  const { rows } = await req.db.query<CalendarRow>(
    `SELECT a.id, a.name, a.type_id, a.responsible_role, a.document_ref, a.file_id,
       a.frequency, a.recur_month, a.recur_day, a.requires_evidence, a.visibility,
       COALESCE((
         SELECT json_agg(json_build_object('user_id', g.user_id, 'group_id', g.group_id))
         FROM activity_visibility_grants g WHERE g.activity_id = a.id
       ), '[]'::json) AS activity_visibility_grants
     FROM activities a WHERE a.is_active = true ORDER BY a.name`
  );

  // Grants are stripped: the calendar has no use for them and they name other people.
  const visible: (Omit<CalendarRow, "activity_visibility_grants"> & { restricted: boolean })[] = [];
  for (const { activity_visibility_grants: grants, ...activity } of rows) {
    const seen =
      activity.visibility === "all" ||
      grants.some(
        (g) => g.user_id === req.user.id || (g.group_id !== null && callerGroupIds.has(g.group_id))
      );
    if (!seen && !isAdmin) continue;
    visible.push({ ...activity, restricted: !seen });
  }

  const { rows: stored } = visible.length
    ? await req.db.query<{ activity_id: string; due_date: string }>(
        `SELECT activity_id, due_date, status, completed_at, completed_by_name, note, evidence_file_id
         FROM activity_instances
         WHERE activity_id = ANY($1::uuid[]) AND due_date >= $2::date AND due_date <= $3::date`,
        [visible.map((a) => a.id), `${year}-01-01`, `${year}-12-31`]
      )
    : { rows: [] as { activity_id: string; due_date: string }[] };

  const storedByKey = new Map(stored.map((i) => [`${i.activity_id}|${i.due_date}`, i]));

  // 'sv-SE' formats as YYYY-MM-DD; the zone keeps "overdue" honest around midnight.
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

  const instances = visible.flatMap((activity) =>
    monthsFor(activity.frequency, activity.recur_month).map((month) => {
      const dueDate = `${year}-${pad(month)}-${pad(activity.recur_day)}`;
      const existing = storedByKey.get(`${activity.id}|${dueDate}`);
      if (existing) return { ...existing, activity_id: activity.id, due_date: dueDate };
      return {
        activity_id: activity.id,
        due_date: dueDate,
        status: dueDate < today ? "overdue" : "planned",
        completed_at: null,
        completed_by_name: null,
        note: null,
        evidence_file_id: null,
      };
    })
  );

  res.json({ types, activities: visible, instances });
});

// activity_types has a SELECT policy for every authenticated user.
activitiesRouter.get("/types", async (req, res) => {
  const { rows } = await req.db.query(
    "SELECT id, code, name, color, sort_order FROM activity_types ORDER BY sort_order"
  );
  res.json(rows);
});

// manage-activities action "list". Archived rows are included.
activitiesRouter.get("/manage", requireManage, async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT a.id, a.name, a.type_id, a.responsible_role, a.document_ref, a.file_id,
       a.frequency, a.recur_month, a.recur_day, a.requires_evidence, a.visibility,
       a.is_active, a.created_at, a.updated_at,
       (SELECT json_build_object('id', t.id, 'code', t.code, 'name', t.name, 'color', t.color,
                                 'sort_order', t.sort_order)
        FROM activity_types t WHERE t.id = a.type_id) AS type,
       COALESCE((
         SELECT json_agg(json_build_object('user_id', g.user_id, 'group_id', g.group_id))
         FROM activity_visibility_grants g WHERE g.activity_id = a.id
       ), '[]'::json) AS activity_visibility_grants,
       EXISTS (SELECT 1 FROM activity_instances i
               WHERE i.activity_id = a.id AND i.status = 'done') AS has_history
     FROM activities a
     ORDER BY a.recur_month ASC NULLS FIRST, a.recur_day ASC`
  );
  res.json({ activities: rows });
});

const acknowledgeBody = z.unknown().transform((raw, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  };
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  if (!b.activity_id) return fail("activity_id is required");
  if (typeof b.activity_id !== "string" || !UUID.test(b.activity_id)) return fail("activity_id must be a UUID");

  // The regex alone would let 2026-02-31 reach Postgres and surface as a 500.
  const dueDate = b.due_date;
  if (typeof dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return fail("due_date must be a YYYY-MM-DD date");
  }
  const parsed = new Date(`${dueDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueDate) {
    return fail("due_date must be a YYYY-MM-DD date");
  }

  if (b.status !== "in_progress" && b.status !== "done") return fail("status must be 'in_progress' or 'done'");

  const evidence = b.evidence_file_id;
  if (evidence && (typeof evidence !== "string" || !UUID.test(evidence))) {
    return fail("evidence_file_id must be a UUID");
  }

  return {
    activity_id: b.activity_id,
    due_date: dueDate,
    status: b.status as "in_progress" | "done",
    note: typeof b.note === "string" ? b.note.trim() : "",
    evidence_file_id: (evidence as string | null | undefined) || null,
  };
});

// Replaces acknowledge-activity. Open to anyone who can see the activity.
activitiesRouter.post("/acknowledge", async (req, res) => {
  const b = parse(acknowledgeBody, req.body);
  const isAdmin = req.user.permissions.has("manage_activities");
  const callerId = req.user.id;

  const instance = await withTransaction(req.db, async (client) => {
    // The row lock serializes sign-offs, so the reopen check below cannot race.
    const { rows } = await client.query<{ is_active: boolean; visibility: string; requires_evidence: boolean }>(
      "SELECT is_active, visibility, requires_evidence FROM activities WHERE id = $1 FOR NO KEY UPDATE",
      [b.activity_id]
    );
    const activity = rows[0];
    if (!activity) throw notFound("Activity not found");

    let allowed = isAdmin || activity.visibility === "all";
    if (!allowed) {
      const grant = await client.query(
        `SELECT 1 FROM activity_visibility_grants g
         WHERE g.activity_id = $1
           AND (g.user_id = $2 OR g.group_id IN (SELECT group_id FROM group_members WHERE user_id = $2))
         LIMIT 1`,
        [b.activity_id, callerId]
      );
      allowed = grant.rows.length > 0;
    }
    // Same response as a missing activity, so a restricted one is not revealed.
    if (!allowed) throw notFound("Activity not found");
    // Checked after visibility: the edge function's order revealed hidden archived activities.
    if (!activity.is_active) throw badRequest("Activity is archived and cannot be signed off");

    const { rows: existing } = await client.query<{ status: string }>(
      "SELECT status FROM activity_instances WHERE activity_id = $1 AND due_date = $2",
      [b.activity_id, b.due_date]
    );
    // Includes done -> done, which would replace the recorded signer and note.
    if (existing[0]?.status === "done" && !isAdmin) {
      throw new HttpError(403, "Only an activity administrator can change a signed-off occurrence", "already_signed_off");
    }

    if (b.status === "done" && activity.requires_evidence && !b.note && !b.evidence_file_id) {
      throw new HttpError(400, "This activity requires evidence: attach a file or write a note", "evidence_required");
    }

    const { rows: profiles } = await client.query<{ full_name: string | null; email: string | null }>(
      "SELECT full_name, email FROM profiles WHERE id = $1",
      [callerId]
    );
    const profile = profiles[0];
    const done = b.status === "done";

    const { rows: saved } = await client.query(
      `INSERT INTO activity_instances
         (activity_id, due_date, status, completed_at, completed_by, completed_by_name, note, evidence_file_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (activity_id, due_date) DO UPDATE SET
         status = EXCLUDED.status,
         completed_at = EXCLUDED.completed_at,
         completed_by = EXCLUDED.completed_by,
         completed_by_name = EXCLUDED.completed_by_name,
         note = EXCLUDED.note,
         evidence_file_id = EXCLUDED.evidence_file_id
       RETURNING activity_id, due_date, status, completed_at, completed_by_name, note, evidence_file_id`,
      [
        b.activity_id,
        b.due_date,
        b.status,
        done ? new Date() : null,
        done ? callerId : null,
        // Snapshot: completed_by goes NULL if the employee is later deleted.
        done ? profile?.full_name || profile?.email || null : null,
        b.note || null,
        b.evidence_file_id,
      ]
    );
    return saved[0];
  }).catch(rethrowForeignKey);

  res.json({ instance });
});

activitiesRouter.post("/", requireManage, async (req, res) => {
  const body = parse(activityBody, req.body ?? {});
  const id = await withTransaction(req.db, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO activities (name, type_id, responsible_role, document_ref, file_id, frequency,
         recur_month, recur_day, requires_evidence, visibility, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [...columnsFrom(body), req.user.id]
    );
    const activityId = rows[0]!.id;
    await replaceGrants(client, activityId, req.user.id, body);
    return activityId;
  }).catch(rethrowForeignKey);
  res.status(201).json({ id, message: "Saved" });
});

activitiesRouter.put("/:id", requireManage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  const body = parse(activityBody, req.body ?? {});
  await withTransaction(req.db, async (client) => {
    const { rows } = await client.query(
      `UPDATE activities SET name = $1, type_id = $2, responsible_role = $3, document_ref = $4,
         file_id = $5, frequency = $6, recur_month = $7, recur_day = $8, requires_evidence = $9,
         visibility = $10
       WHERE id = $11 RETURNING id`,
      [...columnsFrom(body), id]
    );
    if (!rows[0]) throw notFound("Activity not found");
    await replaceGrants(client, id, req.user.id, body);
  }).catch(rethrowForeignKey);
  res.json({ id, message: "Saved" });
});

for (const [action, isActive, message] of [
  ["archive", false, "Archived"],
  ["restore", true, "Restored"],
] as const) {
  activitiesRouter.post(`/:id/${action}`, requireManage, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { rows } = await req.db.query("UPDATE activities SET is_active = $1 WHERE id = $2 RETURNING id", [
      isActive,
      id,
    ]);
    if (!rows[0]) throw notFound("Activity not found");
    res.json({ message });
  });
}

activitiesRouter.delete("/:id", requireManage, async (req, res) => {
  const { id } = parse(idParams, req.params);
  try {
    await req.db.query("DELETE FROM activities WHERE id = $1", [id]);
  } catch (err) {
    // The audit-trail trigger fired. 409 + has_history tells the UI to offer archiving.
    if ((err as { code?: string })?.code === RESTRICT_VIOLATION) {
      throw new HttpError(409, "Activity has signed-off occurrences", "has_history");
    }
    throw err;
  }
  res.json({ message: "Deleted" });
});

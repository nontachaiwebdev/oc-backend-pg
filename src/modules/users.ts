import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { newPasswordSchema } from "../auth/routes.js";
import { createAuthLink, createUserWithProfile, revokeAllRefreshTokens } from "../auth/service.js";
import { withTransaction } from "../db/pool.js";
import { hasPermission, requirePermission, type AuthUser } from "../http/context.js";
import { badRequest, conflict, forbidden, HttpError, notFound, parse, unavailable } from "../http/errors.js";
import { inviteEmail, sendMail } from "../services/mail.js";

type Queryable = pg.Pool | pg.PoolClient;

const MAX_IDS = 1000;
const MAX_LOOKUP_IDS = 200;

// Lowercased so that ID comparisons, such as the self-delete guard, cannot be bypassed by case.
const uuid = z.string().uuid().toLowerCase();
const uuidList = z.array(uuid).max(MAX_IDS);
const email = z.string().trim().toLowerCase().email().max(320);
const emptyToNull = (v: string | null) => v || null;
const nullableText = (max: number) => z.string().trim().max(max).nullable().transform(emptyToNull);
const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((v) => v || undefined);

const createUserBody = z.object({
  email,
  password: newPasswordSchema,
  full_name: optionalText,
  department: optionalText,
  position: optionalText,
});

const inviteUserBody = createUserBody.omit({ password: true });

// Column names below come only from these fixed schemas, never from request keys.
const ownProfileBody = z
  .object({
    full_name: nullableText(200),
    avatar_url: nullableText(2048),
    department: nullableText(200),
    position: nullableText(200),
  })
  .partial()
  .strict();

const adminProfileBody = z
  .object({
    full_name: nullableText(200),
    department: nullableText(200),
    position: nullableText(200),
    status: z.enum(["active", "inactive", "suspended"]),
  })
  .partial()
  .strict();

const groupName = z.string().trim().min(1).max(200);
const createGroupBody = z.object({
  name: groupName,
  description: nullableText(2000).optional(),
  member_ids: uuidList.default([]),
});
const updateGroupBody = z
  .object({ name: groupName, description: nullableText(2000) })
  .partial()
  .strict();
const groupMembersBody = z
  .object({ add: uuidList.default([]), remove: uuidList.default([]) })
  .refine((v) => !v.add.some((id) => v.remove.includes(id)), "A user cannot be both added and removed");

const lookupQuery = z.object({
  ids: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(",")).filter(Boolean))
    .pipe(z.array(uuid).min(1).max(MAX_LOOKUP_IDS)),
});

const USER_SELECT = `
  SELECT p.*,
    COALESCE((
      SELECT json_agg(json_build_object(
               'role', json_build_object('id', r.id, 'name', r.name, 'description', r.description)
             ) ORDER BY r.name)
      FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = p.id
    ), '[]'::json) AS user_roles
  FROM profiles p`;

const GROUP_SELECT = `
  SELECT g.*,
    COALESCE((
      SELECT json_agg(json_build_object('user', to_jsonb(p)) ORDER BY gm.created_at, gm.user_id)
      FROM group_members gm JOIN profiles p ON p.id = gm.user_id
      WHERE gm.group_id = g.id
    ), '[]'::json) AS group_members
  FROM groups g`;

const idParam = (value: unknown) => parse(uuid, value);

async function loadUser(db: Queryable, id: string) {
  const { rows } = await db.query(`${USER_SELECT} WHERE p.id = $1`, [id]);
  if (!rows[0]) throw notFound("User not found");
  return rows[0];
}

async function loadGroup(db: Queryable, id: string) {
  const { rows } = await db.query(`${GROUP_SELECT} WHERE g.id = $1`, [id]);
  if (!rows[0]) throw notFound("Group not found");
  return rows[0];
}

/** Builds SET assignments from a validated body. Placeholders start at $2; $1 is the row id. */
function assignments(body: Record<string, unknown>) {
  const entries = Object.entries(body).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw badRequest("No fields to update");
  return {
    set: entries.map(([column], i) => `"${column}" = $${i + 2}`).join(", "),
    values: entries.map(([, value]) => value),
  };
}

async function updateProfile(db: Queryable, id: string, body: Record<string, unknown>) {
  const { set, values } = assignments(body);
  const { rowCount } = await db.query(`UPDATE profiles SET ${set} WHERE id = $1`, [id, ...values]);
  if (!rowCount) throw notFound("User not found");
}

/** True if any of the roles is super_admin or carries a permission the actor lacks. */
async function rolesExceedActor(db: Queryable, actor: AuthUser, roleIds: string[]): Promise<boolean> {
  if (actor.isSuperAdmin || roleIds.length === 0) return false;
  const { rows } = await db.query<{ role: string; permission: string | null }>(
    `SELECT r.name AS role, p.name AS permission
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE r.id = ANY($1::uuid[])`,
    [roleIds]
  );
  return rows.some((r) => r.role === "super_admin" || (r.permission !== null && !actor.permissions.has(r.permission)));
}

/**
 * Editing, deleting or issuing a recovery link for an account can hand over its access,
 * so the actor must already hold everything that account holds.
 */
async function assertCanManageUser(db: Queryable, actor: AuthUser, targetId: string): Promise<void> {
  const { rows } = await db.query<{ role_id: string }>(`SELECT role_id FROM user_roles WHERE user_id = $1`, [targetId]);
  if (await rolesExceedActor(db, actor, rows.map((r) => r.role_id))) {
    throw forbidden("You cannot manage a user with more access than you have");
  }
}

/** Supabase reported a taken address with this message, and the modals display it. */
function rethrowDuplicateEmail(err: unknown): never {
  if ((err as { code?: string })?.code === "23505") {
    throw conflict("A user with this email address has already been registered");
  }
  throw err;
}

export const usersRouter = Router({ mergeParams: true });

// Any signed-in user can read profiles and roles, as the RLS SELECT policies allowed.
usersRouter.get("/users", async (req, res) => {
  const { rows } = await req.db.query(`${USER_SELECT} ORDER BY p.created_at DESC, p.id`);
  res.json(rows);
});

usersRouter.get("/profiles", async (req, res) => {
  const { ids } = parse(lookupQuery, req.query);
  const { rows } = await req.db.query(`SELECT id, full_name, email FROM profiles WHERE id = ANY($1::uuid[])`, [ids]);
  res.json(rows);
});

usersRouter.get("/roles", async (req, res) => {
  const { rows } = await req.db.query(`SELECT * FROM roles ORDER BY name`);
  res.json(rows);
});

// Only the fields on the profile page. Status stays admin-controlled.
usersRouter.patch("/profiles/me", async (req, res) => {
  const body = parse(ownProfileBody, req.body);
  await updateProfile(req.db, req.user.id, body);
  const { rows } = await req.db.query(`SELECT * FROM profiles WHERE id = $1`, [req.user.id]);
  res.json(rows[0]);
});

usersRouter.post("/users", requirePermission("manage_users"), async (req, res) => {
  const input = parse(createUserBody, req.body);
  const user = await withTransaction(req.db, (client) =>
    createUserWithProfile(client, {
      email: input.email,
      password: input.password,
      fullName: input.full_name,
      department: input.department,
      position: input.position,
    })
  ).catch(rethrowDuplicateEmail);
  res.status(201).json({
    user: { id: user.id, email: user.email },
    message: `User ${user.email} created successfully`,
  });
});

usersRouter.post("/users/invite", requirePermission("manage_users"), async (req, res) => {
  const input = parse(inviteUserBody, req.body);
  const { user, link } = await withTransaction(req.db, async (client) => {
    const created = await createUserWithProfile(client, {
      email: input.email,
      fullName: input.full_name,
      department: input.department,
      position: input.position,
      invited: true,
    });
    return { user: created, link: await createAuthLink(client, created.id, "invite") };
  }).catch(rethrowDuplicateEmail);

  let sent: boolean;
  try {
    // Sent after commit so a slow mail service doesn't hold a database connection.
    sent = await sendMail(inviteEmail(user.email, link, input.full_name));
  } catch (err) {
    // Without the email nobody holds the link, so remove the account just created.
    await req.db.query(`DELETE FROM users WHERE id = $1`, [user.id]).catch(() => undefined);
    if (err instanceof HttpError) throw err;
    throw unavailable("The invitation email could not be sent");
  }
  res.status(201).json({
    user: { id: user.id, email: user.email },
    email_sent: sent,
    message: sent ? `Invitation sent to ${user.email}` : `User ${user.email} created, but no email was sent`,
  });
});

usersRouter.patch("/users/:id", requirePermission("manage_users"), async (req, res) => {
  const id = idParam(req.params.id);
  const body = parse(adminProfileBody, req.body);
  const blocking = body.status !== undefined && body.status !== "active";
  if (blocking && id === req.user.id) throw badRequest("You cannot deactivate your own account");
  const user = await withTransaction(req.db, async (client) => {
    await assertCanManageUser(client, req.user, id);
    await updateProfile(client, id, body);
    // Reactivating the account later must not bring old sessions back.
    if (blocking) await revokeAllRefreshTokens(client, id);
    return loadUser(client, id);
  });
  res.json(user);
});

usersRouter.delete("/users/:id", requirePermission("manage_users"), async (req, res) => {
  const id = idParam(req.params.id);
  if (id === req.user.id) throw badRequest("You cannot delete your own account");
  await assertCanManageUser(req.db, req.user, id);
  const { rowCount } = await req.db.query(`DELETE FROM users WHERE id = $1`, [id]);
  if (!rowCount) throw notFound("User not found");
  res.json({ message: "User deleted successfully" });
});

usersRouter.post("/users/:id/recovery-link", requirePermission("manage_users"), async (req, res) => {
  const id = idParam(req.params.id);
  const result = await withTransaction(req.db, async (client) => {
    // users.email is the login address. profiles.email can drift from it.
    const { rows } = await client.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw notFound("User not found");
    await assertCanManageUser(client, req.user, id);
    return { action_link: await createAuthLink(client, id, "recovery"), email: rows[0].email };
  });
  res.set("Cache-Control", "no-store").json(result);
});

// Replaces the whole set atomically. Roles the user keeps retain their assigned_by.
usersRouter.put("/users/:id/roles", requirePermission("manage_users"), async (req, res) => {
  const id = idParam(req.params.id);
  const { role_ids } = parse(z.object({ role_ids: uuidList }), req.body);
  const roleIds = [...new Set(role_ids)];

  const user = await withTransaction(req.db, async (client) => {
    const target = await client.query(`SELECT id FROM profiles WHERE id = $1 FOR UPDATE`, [id]);
    if (!target.rowCount) throw notFound("User not found");

    const known = await client.query(`SELECT id FROM roles WHERE id = ANY($1::uuid[])`, [roleIds]);
    if (known.rowCount !== roleIds.length) throw badRequest("Unknown role");

    await assertCanManageUser(client, req.user, id);
    const held = await client.query<{ role_id: string }>(`SELECT role_id FROM user_roles WHERE user_id = $1`, [id]);
    const heldIds = new Set(held.rows.map((r) => r.role_id));
    if (await rolesExceedActor(client, req.user, roleIds.filter((r) => !heldIds.has(r)))) {
      throw forbidden("You cannot assign a role with more access than you have");
    }

    if (id === req.user.id) {
      const losing = await client.query(
        `SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1 AND r.name = 'super_admin' AND NOT (r.id = ANY($2::uuid[]))`,
        [id, roleIds]
      );
      if (losing.rowCount) throw badRequest("You cannot remove your own super_admin role");
    }

    await client.query(`DELETE FROM user_roles WHERE user_id = $1 AND NOT (role_id = ANY($2::uuid[]))`, [id, roleIds]);
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, assigned_by)
       SELECT $1::uuid, role_id, $3::uuid FROM unnest($2::uuid[]) AS role_id
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [id, roleIds, req.user.id]
    );
    return loadUser(client, id);
  });
  res.json(user);
});

// RLS returned no rows, not an error, to users without manage_groups. The activity and
// access pages load groups for those users, so a 403 here would break them.
usersRouter.get("/groups", async (req, res) => {
  if (!hasPermission(req, "manage_groups")) {
    res.json([]);
    return;
  }
  const { rows } = await req.db.query(`${GROUP_SELECT} ORDER BY g.name`);
  res.json(rows);
});

usersRouter.post("/groups", requirePermission("manage_groups"), async (req, res) => {
  const input = parse(createGroupBody, req.body);
  const group = await withTransaction(req.db, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING id`,
      [input.name, input.description ?? null, req.user.id]
    );
    const groupId = rows[0]!.id;
    await addMembers(client, groupId, input.member_ids, req.user.id);
    return loadGroup(client, groupId);
  });
  res.status(201).json(group);
});

usersRouter.patch("/groups/:id", requirePermission("manage_groups"), async (req, res) => {
  const id = idParam(req.params.id);
  const { set, values } = assignments(parse(updateGroupBody, req.body));
  const { rowCount } = await req.db.query(`UPDATE groups SET ${set} WHERE id = $1`, [id, ...values]);
  if (!rowCount) throw notFound("Group not found");
  res.json(await loadGroup(req.db, id));
});

usersRouter.delete("/groups/:id", requirePermission("manage_groups"), async (req, res) => {
  const id = idParam(req.params.id);
  const { rowCount } = await req.db.query(`DELETE FROM groups WHERE id = $1`, [id]);
  if (!rowCount) throw notFound("Group not found");
  res.status(204).end();
});

usersRouter.patch("/groups/:id/members", requirePermission("manage_groups"), async (req, res) => {
  const id = idParam(req.params.id);
  const { add, remove } = parse(groupMembersBody, req.body);
  const group = await withTransaction(req.db, async (client) => {
    const found = await client.query(`SELECT id FROM groups WHERE id = $1 FOR UPDATE`, [id]);
    if (!found.rowCount) throw notFound("Group not found");
    if (remove.length > 0) {
      await client.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])`, [id, remove]);
    }
    await addMembers(client, id, add, req.user.id);
    return loadGroup(client, id);
  });
  res.json(group);
});

async function addMembers(client: pg.PoolClient, groupId: string, userIds: string[], addedBy: string) {
  if (userIds.length === 0) return;
  await client.query(
    `INSERT INTO group_members (group_id, user_id, added_by)
     SELECT $1::uuid, user_id, $3::uuid FROM unnest($2::uuid[]) AS user_id
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, userIds, addedBy]
  );
}

import { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import { hasPermission, requirePermission, type AuthUser } from "../../http/context.js";
import { forbidden, notFound, parse } from "../../http/errors.js";

type Queryable = pg.Pool | pg.PoolClient;

export interface ChatSessionRow {
  id: string;
  user_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_CHARS = 500;

const titleSchema = z.string().min(1).max(MAX_TITLE_CHARS);
const createSessionSchema = z.object({ title: titleSchema.optional() });
const renameSessionSchema = z.object({ title: titleSchema });
const feedbackSchema = z.object({ rating: z.enum(["like", "dislike"]) });
const listQuerySchema = z.object({
  user_id: z.string().regex(UUID_RE, "must be a UUID").optional(),
  all: z.enum(["true", "false"]).optional(),
});

/** A malformed id can't exist, so it is a 404 rather than a database error. */
function idParam(req: Request, name: string): string {
  const value = String(req.params[name]);
  if (!UUID_RE.test(value)) throw notFound();
  return value;
}

async function findSession(db: Queryable, id: string): Promise<ChatSessionRow | null> {
  const { rows } = await db.query<ChatSessionRow>(`SELECT * FROM chat_sessions WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** RLS: the owner or view_chat can read. Anyone else gets a 404, so ids aren't revealed. */
async function readableSession(req: Request, id: string): Promise<ChatSessionRow> {
  const session = await findSession(req.db, id);
  if (!session || (session.user_id !== req.user.id && !hasPermission(req, "view_chat"))) throw notFound();
  return session;
}

/** For a write the caller isn't allowed: 403 if they can see the session, otherwise 404. */
function denyWrite(user: AuthUser): never {
  throw user.permissions.has("view_chat") ? forbidden() : notFound();
}

/**
 * For the assistant endpoint: the session must exist, belong to the user, and the user
 * must hold send_chat (the RLS insert rule for chat_messages). Returns the session.
 */
export async function assertChatSessionWritable(
  db: Queryable,
  user: AuthUser,
  sessionId: string
): Promise<ChatSessionRow> {
  if (!user.permissions.has("send_chat")) throw forbidden("Missing permission: send_chat");
  if (!UUID_RE.test(sessionId)) throw notFound();
  const session = await findSession(db, sessionId);
  if (!session) throw notFound();
  if (session.user_id !== user.id) denyWrite(user);
  return session;
}

export const chatRouter = Router({ mergeParams: true });

// Own sessions by default. Another user's, or everyone's, needs view_chat.
chatRouter.get("/chat/sessions", async (req, res) => {
  const query = parse(listQuerySchema, req.query);
  const all = query.all === "true";
  const userId = query.user_id ?? req.user.id;
  if ((all || userId !== req.user.id) && !hasPermission(req, "view_chat")) {
    throw forbidden("Missing permission: view_chat");
  }
  const { rows } = all
    ? await req.db.query(`SELECT * FROM chat_sessions ORDER BY updated_at DESC`)
    : await req.db.query(`SELECT * FROM chat_sessions WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
  res.json({ sessions: rows });
});

chatRouter.post("/chat/sessions", requirePermission("send_chat"), async (req, res) => {
  const { title } = parse(createSessionSchema, req.body ?? {});
  const { rows } =
    title === undefined
      ? await req.db.query(`INSERT INTO chat_sessions (user_id) VALUES ($1) RETURNING *`, [req.user.id])
      : await req.db.query(`INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING *`, [
          req.user.id,
          title,
        ]);
  res.status(201).json({ session: rows[0] });
});

chatRouter.get("/chat/sessions/:id", async (req, res) => {
  res.json({ session: await readableSession(req, idParam(req, "id")) });
});

// Only the owner can rename, as in RLS. view_chat does not grant this.
chatRouter.patch("/chat/sessions/:id", async (req, res) => {
  const id = idParam(req, "id");
  const { title } = parse(renameSessionSchema, req.body);
  const session = await findSession(req.db, id);
  if (!session) throw notFound();
  if (session.user_id !== req.user.id) denyWrite(req.user);
  const { rows } = await req.db.query(
    `UPDATE chat_sessions SET title = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
    [title, id, req.user.id]
  );
  if (!rows[0]) throw notFound();
  res.json({ session: rows[0] });
});

// The owner or manage_chat. Messages and feedback cascade.
chatRouter.delete("/chat/sessions/:id", async (req, res) => {
  const id = idParam(req, "id");
  const session = await findSession(req.db, id);
  if (!session) throw notFound();
  if (session.user_id !== req.user.id && !hasPermission(req, "manage_chat")) denyWrite(req.user);
  await req.db.query(`DELETE FROM chat_sessions WHERE id = $1`, [id]);
  res.status(204).end();
});

// Feedback follows RLS: your own, or everyone's with view_chat.
chatRouter.get("/chat/sessions/:id/messages", async (req, res) => {
  const session = await readableSession(req, idParam(req, "id"));
  const [messages, feedback] = await Promise.all([
    req.db.query(`SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`, [session.id]),
    req.db.query(
      `SELECT f.* FROM chat_message_feedback f
       JOIN chat_messages m ON m.id = f.message_id
       WHERE m.session_id = $1 AND (f.user_id = $2 OR $3::boolean)`,
      [session.id, req.user.id, hasPermission(req, "view_chat")]
    ),
  ]);
  res.json({ messages: messages.rows, feedback: feedback.rows });
});

// The owner or delete_chat_messages.
chatRouter.delete("/chat/sessions/:id/messages/:messageId", async (req, res) => {
  const id = idParam(req, "id");
  const messageId = idParam(req, "messageId");
  const session = await findSession(req.db, id);
  if (!session) throw notFound();
  if (session.user_id !== req.user.id && !hasPermission(req, "delete_chat_messages")) denyWrite(req.user);
  const { rowCount } = await req.db.query(`DELETE FROM chat_messages WHERE id = $1 AND session_id = $2`, [
    messageId,
    id,
  ]);
  if (!rowCount) throw notFound();
  res.status(204).end();
});

// Stricter than RLS, which let a user rate any message id: the message must be readable.
chatRouter.put("/chat/messages/:messageId/feedback", async (req, res) => {
  const messageId = idParam(req, "messageId");
  const { rating } = parse(feedbackSchema, req.body);
  const { rows } = await req.db.query(
    `INSERT INTO chat_message_feedback (message_id, user_id, rating)
     SELECT m.id, $2, $3
     FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
     WHERE m.id = $1 AND (s.user_id = $2 OR $4::boolean)
     ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating
     RETURNING *`,
    [messageId, req.user.id, rating, hasPermission(req, "view_chat")]
  );
  if (!rows[0]) throw notFound();
  res.json({ feedback: rows[0] });
});

// Idempotent, like the Supabase delete it replaces.
chatRouter.delete("/chat/messages/:messageId/feedback", async (req, res) => {
  const messageId = idParam(req, "messageId");
  await req.db.query(`DELETE FROM chat_message_feedback WHERE message_id = $1 AND user_id = $2`, [
    messageId,
    req.user.id,
  ]);
  res.status(204).end();
});

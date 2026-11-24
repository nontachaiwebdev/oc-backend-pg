import { Router } from "express";
import type pg from "pg";
import { z } from "zod";
import { withTransaction } from "../../db/pool.js";
import { requirePermission, type AuthUser } from "../../http/context.js";
import { badRequest, HttpError, notFound, parse } from "../../http/errors.js";

// Port of the manage-drafts edge function. One endpoint, same action names, bodies,
// responses and error codes, so the frontend only changes the URL.

type Queryable = pg.Pool | pg.PoolClient;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
type Payload = Record<string, unknown>;
type Ctx = { db: pg.Pool; user: AuthUser; body: Payload };
type Result = [status: number, body: unknown];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOC_CHARS = 100_000;
const MAX_TITLE_CHARS = 200;
const FOREIGN_KEY_VIOLATION = "23503";
// A turn lock older than this belongs to a turn whose tab was closed. The frontend's
// useDraftChat uses the same value, so the two must change together.
const TURN_LOCK_MS = 3 * 60 * 1000;
const HISTORY_MESSAGES = 10;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_CHARS = 100_000;
const MAX_ATTACHMENT_NAME = 200;
const MAX_SOURCES = 100;
const MODES = ["draft", "review"] as const;
const EDIT_TYPES = ["replace", "insert_after_heading", "append"] as const;
const ID_KEYS = ["document_id", "session_id", "edit_id", "assistant_message_id"] as const;

// parse() on a bare value reports the message as is, matching manage-drafts' error text.
const text = (message: string) => z.string({ required_error: message, invalid_type_error: message });
const oneOf = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.enum(values, { errorMap: () => ({ message }) });
const optionalText = (message: string) => text(message).optional();
const modeSchema = oneOf(MODES, 'mode must be "draft" or "review"').optional();
const decisionSchema = oneOf(["accepted", "rejected"], 'status must be "accepted" or "rejected"');
const finishStatusSchema = oneOf(
  ["complete", "failed", "aborted"],
  'status must be "complete", "failed" or "aborted"'
);
const uuidOrNull = (message: string) =>
  z.custom<string | null>((v) => v === null || UUID_RE.test(String(v)), { message });

const payloadSchema = z.record(z.unknown()).catch({});

const toDocument = (r: Row) => ({
  id: r.id,
  title: r.title,
  content: r.content,
  savedFileId: r.saved_file_id,
  sourceFileId: r.source_file_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// Attachment content stays on the server; clients only need what's attached.
const toSession = (r: Row) => ({
  id: r.id,
  documentId: r.document_id,
  title: r.title,
  mode: r.mode ?? "draft",
  attachments: ((r.attachments ?? []) as Row[]).map((a) => ({ fileId: a.fileId ?? null, name: a.name })),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEdit = (r: Row) => ({
  editId: r.id,
  messageId: r.message_id,
  type: r.type,
  ...(r.type === "replace" && { oldText: r.old_text ?? "" }),
  ...(r.type === "insert_after_heading" && { heading: r.heading ?? "" }),
  newText: r.new_text,
  reason: r.reason,
  sources: r.sources ?? [],
  status: r.status,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
});

/** Session title from the first message: one line, at most 80 characters. */
function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 80 ? line.slice(0, 79).trimEnd() + "…" : line;
}

/** Validates an edit from the LLM stream and returns its columns. */
function editColumns(value: unknown): Row {
  if (!value || typeof value !== "object") throw badRequest("edit is required");
  const e = value as Row;
  if (!UUID_RE.test(String(e.editId))) throw badRequest("edit.editId must be a UUID");
  const type = parse(oneOf(EDIT_TYPES, "edit.type is invalid"), e.type);
  const newText = parse(text("edit.newText is invalid").max(MAX_DOC_CHARS, "edit.newText is invalid"), e.newText);
  const reason = parse(optionalText("edit.reason must be a string"), e.reason);
  const oldText = type === "replace" ? parse(text("edit.oldText is required for replace"), e.oldText) : null;
  const heading =
    type === "insert_after_heading"
      ? parse(text("edit.heading is required for insert_after_heading"), e.heading)
      : null;
  const sources = Array.isArray(e.sources) ? e.sources.filter((s: unknown) => typeof s === "string") : [];
  return { id: e.editId, type, old_text: oldText, heading, new_text: newText, reason: reason ?? "", sources };
}

/** Validates attachments. One without content keeps what is stored for its fileId. */
function attachmentRows(value: unknown, existing: Row[] = []): Row[] {
  const list = parse(z.array(z.unknown(), { invalid_type_error: "attachments must be an array" }), value);
  if (list.length > MAX_ATTACHMENTS) throw badRequest(`at most ${MAX_ATTACHMENTS} attachments are allowed`);
  const shapeError = "each attachment needs a string name and content";
  const rows: Row[] = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") throw badRequest(shapeError);
    const a = item as Row;
    const name = parse(text(shapeError), a.name);
    if (a.fileId !== undefined && a.fileId !== null && !UUID_RE.test(String(a.fileId))) {
      throw badRequest("attachment fileId must be a UUID");
    }
    const content: unknown =
      typeof a.content === "string"
        ? a.content
        : a.fileId
          ? existing.find((x) => x.fileId === a.fileId)?.content
          : undefined;
    if (typeof content !== "string") throw badRequest(shapeError);
    total += content.length;
    rows.push({
      fileId: a.fileId ?? null,
      name: name.trim().slice(0, MAX_ATTACHMENT_NAME) || "bilaga",
      content,
    });
  }
  if (total > MAX_ATTACHMENT_CHARS) {
    throw new HttpError(413, `attachments exceed ${MAX_ATTACHMENT_CHARS} characters in total`, "payload_too_large");
  }
  return rows;
}

/** Validates optional document fields and returns the columns to write. */
function documentColumns(p: Payload): Row {
  const cols: Row = {};
  if (p.title !== undefined) {
    const message = "title must be a non-empty string";
    const title = parse(text(message).refine((v) => v.trim().length > 0, message), p.title);
    if (title.length > MAX_TITLE_CHARS) throw badRequest(`title exceeds ${MAX_TITLE_CHARS} characters`);
    cols.title = title.trim();
  }
  if (p.content !== undefined) {
    const content = parse(text("content must be a string"), p.content);
    if (content.length > MAX_DOC_CHARS) throw badRequest(`content exceeds ${MAX_DOC_CHARS} characters`);
    cols.content = content;
  }
  if (p.saved_file_id !== undefined) {
    cols.saved_file_id = parse(uuidOrNull("saved_file_id must be a UUID or null"), p.saved_file_id);
  }
  return cols;
}

/** The files RLS policy: only manage_files can see files. */
async function fileVisible(db: Queryable, user: AuthUser, id: string): Promise<boolean> {
  if (!user.permissions.has("manage_files")) return false;
  const { rowCount } = await db.query(`SELECT 1 FROM files WHERE id = $1`, [id]);
  return Boolean(rowCount);
}

async function ownedDocument(db: Queryable, userId: string, id: unknown): Promise<Row | null> {
  if (!id) return null;
  const { rows } = await db.query(`SELECT * FROM draft_documents WHERE id = $1 AND owner_id = $2`, [id, userId]);
  return rows[0] ?? null;
}

/**
 * A session of one of the user's documents. With `lock`, holds the row until commit, so
 * turns, edit saves and decisions on one session run one at a time.
 */
async function ownedSession(
  db: Queryable,
  userId: string,
  body: Payload,
  lock = false
): Promise<Row | null> {
  if (!body.document_id || !body.session_id) return null;
  const { rows } = await db.query(
    `SELECT s.* FROM draft_sessions s
     JOIN draft_documents d ON d.id = s.document_id
     WHERE s.id = $1 AND s.document_id = $2 AND d.owner_id = $3
     ${lock ? "FOR UPDATE OF s" : ""}`,
    [body.session_id, body.document_id, userId]
  );
  return rows[0] ?? null;
}

/** The session and assistant message of a turn, with the session row locked. */
async function runningTurn(client: pg.PoolClient, ctx: Ctx): Promise<{ session: Row; reply: Row }> {
  const session = await ownedSession(client, ctx.user.id, ctx.body, true);
  if (!session || !ctx.body.assistant_message_id) throw notFound();
  const { rows } = await client.query(
    `SELECT id, status FROM draft_messages WHERE id = $1 AND session_id = $2 AND role = 'assistant'`,
    [ctx.body.assistant_message_id, session.id]
  );
  const reply = rows[0];
  if (!reply) throw notFound();
  if (reply.status !== "streaming") throw new HttpError(409, "Turn already finished", "turn_finished");
  return { session, reply };
}

const list = async ({ db, user }: Ctx): Promise<Result> => {
  const { rows } = await db.query(
    `SELECT d.id, d.title, d.saved_file_id, d.source_file_id, d.created_at, d.updated_at,
       (SELECT count(*) FROM draft_sessions s WHERE s.document_id = d.id) AS session_count
     FROM draft_documents d WHERE d.owner_id = $1 ORDER BY d.updated_at DESC`,
    [user.id]
  );
  return [
    200,
    {
      documents: rows.map((r) => ({
        id: r.id,
        title: r.title,
        savedFileId: r.saved_file_id,
        sourceFileId: r.source_file_id,
        sessionCount: r.session_count,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    },
  ];
};

const create = async ({ db, user, body }: Ctx): Promise<Result> => {
  const cols = documentColumns(body);
  const mode = parse(modeSchema, body.mode);
  const attachments = body.attachments === undefined ? [] : attachmentRows(body.attachments);

  // A draft opened from a knowledge-base file points at it. Only visible files are accepted.
  if (body.source_file_id !== undefined && body.source_file_id !== null) {
    if (!UUID_RE.test(String(body.source_file_id))) throw badRequest("source_file_id must be a UUID");
    cols.source_file_id = body.source_file_id;
  }
  for (const id of new Set([cols.saved_file_id, cols.source_file_id].filter(Boolean))) {
    if (!(await fileVisible(db, user, id))) throw badRequest("file not found");
  }

  const keys = Object.keys(cols);
  const columns = ["owner_id", ...keys].join(", ");
  const placeholders = ["$1", ...keys.map((_, i) => `$${i + 2}`)].join(", ");
  try {
    return await withTransaction(db, async (client) => {
      const doc = await client.query(
        `INSERT INTO draft_documents (${columns}) VALUES (${placeholders}) RETURNING *`,
        [user.id, ...keys.map((k) => cols[k])]
      );
      const session = await client.query(
        `INSERT INTO draft_sessions (document_id, user_id, mode, attachments)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
        [doc.rows[0].id, user.id, mode ?? "draft", JSON.stringify(attachments)]
      );
      return [201, { document: toDocument(doc.rows[0]), session: toSession(session.rows[0]) }] as Result;
    });
  } catch (err) {
    if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) throw badRequest("file not found");
    throw err;
  }
};

const get = async ({ db, user, body }: Ctx): Promise<Result> => {
  const doc = await ownedDocument(db, user.id, body.document_id);
  if (!doc) throw notFound();
  const { rows } = await db.query(
    `SELECT s.id, s.document_id, s.title, s.mode, s.attachments, s.created_at, s.updated_at,
       (SELECT count(*) FROM draft_messages m WHERE m.session_id = s.id) AS message_count
     FROM draft_sessions s WHERE s.document_id = $1 ORDER BY s.updated_at DESC`,
    [doc.id]
  );
  return [
    200,
    {
      document: toDocument(doc),
      sessions: rows.map((r) => ({ ...toSession(r), messageCount: r.message_count })),
    },
  ];
};

const update = async ({ db, user, body }: Ctx): Promise<Result> => {
  if (!body.document_id) throw notFound();
  const cols = documentColumns(body);
  const keys = Object.keys(cols);
  if (keys.length === 0) throw badRequest("nothing to update");

  // Stricter than manage-drafts, which accepted any existing file id here.
  if (cols.saved_file_id && !(await fileVisible(db, user, cols.saved_file_id))) {
    throw badRequest("saved_file_id does not exist");
  }

  const assignments = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  try {
    const { rows } = await db.query(
      `UPDATE draft_documents SET ${assignments} WHERE id = $1 AND owner_id = $2 RETURNING *`,
      [body.document_id, user.id, ...keys.map((k) => cols[k])]
    );
    if (!rows[0]) throw notFound();
    return [200, { document: toDocument(rows[0]) }];
  } catch (err) {
    if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
      throw badRequest("saved_file_id does not exist");
    }
    throw err;
  }
};

const deleteDocument = async ({ db, user, body }: Ctx): Promise<Result> => {
  if (!body.document_id) throw notFound();
  // Sessions, messages and edits cascade.
  const { rowCount } = await db.query(`DELETE FROM draft_documents WHERE id = $1 AND owner_id = $2`, [
    body.document_id,
    user.id,
  ]);
  if (!rowCount) throw notFound();
  return [200, { message: "Deleted" }];
};

const createSession = async ({ db, user, body }: Ctx): Promise<Result> => {
  const requested = parse(modeSchema, body.mode);
  const doc = await ownedDocument(db, user.id, body.document_id);
  if (!doc) throw notFound();
  // Without a mode, a new session keeps the mode of the latest one.
  const { rows } = await db.query(
    `INSERT INTO draft_sessions (document_id, user_id, mode)
     VALUES ($1, $2, COALESCE($3::text,
       (SELECT mode FROM draft_sessions WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1),
       'draft'))
     RETURNING *`,
    [doc.id, user.id, requested ?? null]
  );
  return [201, { session: toSession(rows[0]!) }];
};

const setAttachments = ({ db, user, body }: Ctx): Promise<Result> =>
  withTransaction(db, async (client) => {
    const session = await ownedSession(client, user.id, body, true);
    if (!session) throw notFound();
    const attachments = attachmentRows(body.attachments, session.attachments ?? []);
    const { rows } = await client.query(
      `UPDATE draft_sessions SET attachments = $1::jsonb WHERE id = $2 RETURNING *`,
      [JSON.stringify(attachments), session.id]
    );
    return [200, { session: toSession(rows[0]!) }];
  });

const getSession = async ({ db, user, body }: Ctx): Promise<Result> => {
  const session = await ownedSession(db, user.id, body);
  if (!session) throw notFound();
  const snapshots = Boolean(body.snapshots);
  const [messages, edits] = await Promise.all([
    db.query(
      `SELECT id, role, content, status, error_message, sources, created_at
         ${snapshots ? ", document_snapshot" : ""}
       FROM draft_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.id]
    ),
    db.query(`SELECT * FROM draft_edits WHERE session_id = $1 ORDER BY created_at ASC`, [session.id]),
  ]);

  const editIdsByMessage = new Map<string, string[]>();
  for (const e of edits.rows) {
    editIdsByMessage.set(e.message_id, [...(editIdsByMessage.get(e.message_id) ?? []), e.id]);
  }
  return [
    200,
    {
      session: toSession(session),
      messages: messages.rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        status: r.status,
        errorMessage: r.error_message,
        sources: r.sources ?? [],
        editIds: editIdsByMessage.get(r.id) ?? [],
        createdAt: r.created_at,
        ...(snapshots && { documentSnapshot: r.document_snapshot }),
      })),
      edits: edits.rows.map(toEdit),
    },
  ];
};

const deleteSession = async ({ db, user, body }: Ctx): Promise<Result> => {
  const session = await ownedSession(db, user.id, body);
  if (!session) throw notFound();
  await db.query(`DELETE FROM draft_sessions WHERE id = $1`, [session.id]);
  return [200, { message: "Deleted" }];
};

const decideEdit = async ({ db, user, body }: Ctx): Promise<Result> => {
  const status = parse(decisionSchema, body.status);
  return withTransaction(db, async (client) => {
    // The lock orders this against start_turn, so a decision is either sent with
    // a turn or timestamped after it, and never marked reported without being sent.
    const session = await ownedSession(client, user.id, body, true);
    if (!session || !body.edit_id) throw notFound();

    // Only open edits can be decided. The model is told on the next turn.
    const { rows } = await client.query(
      `UPDATE draft_edits
       SET status = $1, decided_by = $2, decided_at = clock_timestamp(), decision_reported = false
       WHERE id = $3 AND session_id = $4 AND status = 'open'
       RETURNING *`,
      [status, user.id, body.edit_id, session.id]
    );
    if (rows[0]) return [200, { edit: toEdit(rows[0]) }] as Result;

    const existing = await client.query(`SELECT 1 FROM draft_edits WHERE id = $1 AND session_id = $2`, [
      body.edit_id,
      session.id,
    ]);
    if (existing.rowCount) throw new HttpError(409, "Edit already decided", "already_decided");
    throw notFound();
  });
};

const startTurn = async ({ db, user, body }: Ctx): Promise<Result> => {
  const messageError = "message is required";
  const message = parse(text(messageError).refine((v) => v.trim().length > 0, messageError), body.message);
  const document = parse(text("document is required (may be an empty string)"), body.document);
  if (document.length > MAX_DOC_CHARS) {
    throw new HttpError(413, `document exceeds ${MAX_DOC_CHARS} characters`, "payload_too_large");
  }

  return withTransaction(db, async (client) => {
    const session = await ownedSession(client, user.id, body, true);
    if (!session) throw notFound();

    // One turn at a time. A lock older than TURN_LOCK_MS belongs to a closed tab and is taken over.
    // clock_timestamp(), not now(): now() is frozen at BEGIN, and these rows are ordered by time.
    const claimed = await client.query(
      `UPDATE draft_sessions SET active_turn_started_at = clock_timestamp()
       WHERE id = $1 AND (active_turn_started_at IS NULL
         OR active_turn_started_at < clock_timestamp() - make_interval(secs => $2))
       RETURNING id`,
      [session.id, TURN_LOCK_MS / 1000]
    );
    if (!claimed.rowCount) throw new HttpError(409, "A turn is already running", "turn_in_progress");

    // A reply still "streaming" here belongs to a turn that never finished.
    await client.query(
      `UPDATE draft_messages SET status = 'failed', error_message = $1
       WHERE session_id = $2 AND status = 'streaming'`,
      ["Avbröts innan svaret var klart.", session.id]
    );

    // History from completed turns only, and decisions the model hasn't been told about.
    const recent = await client.query(
      `SELECT role, content, status FROM draft_messages
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [session.id, HISTORY_MESSAGES * 4]
    );
    const decided = await client.query(
      `SELECT id, status, reason, new_text FROM draft_edits
       WHERE session_id = $1 AND status IN ('accepted', 'rejected') AND decision_reported = false
       ORDER BY decided_at ASC`,
      [session.id]
    );

    const rows = [...recent.rows].reverse();
    const history: { role: string; content: string }[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].role === "user" && rows[i + 1].role === "assistant" && rows[i + 1].status === "complete") {
        history.push(
          { role: "user", content: rows[i].content },
          { role: "assistant", content: rows[i + 1].content }
        );
        i++;
      }
    }

    const userMsg = await client.query(
      `INSERT INTO draft_messages (session_id, role, content, document_snapshot, created_at)
       VALUES ($1, 'user', $2, $3, clock_timestamp()) RETURNING id`,
      [session.id, message, document]
    );
    await client.query(`UPDATE draft_documents SET content = $1 WHERE id = $2`, [document, session.document_id]);
    const reply = await client.query(
      `INSERT INTO draft_messages (session_id, role, content, status, created_at)
       VALUES ($1, 'assistant', '', 'streaming', clock_timestamp()) RETURNING id`,
      [session.id]
    );

    const attachments = (session.attachments ?? []) as Row[];
    return [
      200,
      {
        userMessageId: userMsg.rows[0].id,
        assistantMessageId: reply.rows[0].id,
        llmRequest: {
          mode: session.mode ?? "draft",
          message,
          ...(attachments.length > 0 && {
            attachments: attachments.map((a) => ({ name: a.name, content: a.content })),
          }),
          document,
          history: history.slice(-HISTORY_MESSAGES),
          lastSeenDocument: session.last_seen_document ?? undefined,
          editDecisions: decided.rows.map((r) => ({
            editId: r.id,
            status: r.status,
            reason: r.reason || undefined,
            newText: r.new_text,
          })),
        },
      },
    ] as Result;
  });
};

const saveEdit = async (ctx: Ctx): Promise<Result> => {
  const cols = editColumns(ctx.body.edit);
  return withTransaction(ctx.db, async (client) => {
    const { session, reply } = await runningTurn(client, ctx);
    // Saving the same edit twice (a retry) is fine.
    await client.query(
      `INSERT INTO draft_edits (id, session_id, message_id, type, old_text, heading, new_text, reason, sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        cols.id,
        session.id,
        reply.id,
        cols.type,
        cols.old_text,
        cols.heading,
        cols.new_text,
        cols.reason,
        JSON.stringify(cols.sources),
      ]
    );
    return [200, { message: "Saved" }] as Result;
  });
};

const finishTurn = async (ctx: Ctx): Promise<Result> => {
  const { body } = ctx;
  const status = parse(finishStatusSchema, body.status);
  const content = parse(optionalText("content must be a string"), body.content);
  const errorMessage = parse(
    z.string({ invalid_type_error: "error_message must be a string" }).nullish(),
    body.error_message
  );
  const sources = Array.isArray(body.sources)
    ? body.sources.filter((s) => s && typeof s === "object").slice(0, MAX_SOURCES)
    : [];

  return withTransaction(ctx.db, async (client) => {
    const { session, reply } = await runningTurn(client, ctx);
    await client.query(
      `UPDATE draft_messages SET content = $1, sources = $2::jsonb, status = $3, error_message = $4 WHERE id = $5`,
      [content ?? "", JSON.stringify(sources), status, status === "complete" ? null : (errorMessage ?? null), reply.id]
    );

    // Timestamps are compared in SQL: a JS Date would drop the microseconds.
    const replyCreatedAt = `(SELECT created_at FROM draft_messages WHERE id = $2)`;
    if (status === "complete") {
      // The user message of this turn holds the document the model saw.
      const { rows } = await client.query(
        `SELECT content, document_snapshot FROM draft_messages
         WHERE session_id = $1 AND role = 'user' AND created_at <= ${replyCreatedAt}
         ORDER BY created_at DESC LIMIT 1`,
        [session.id, reply.id]
      );
      const userMsg = rows[0];
      await client.query(`UPDATE draft_sessions SET last_seen_document = $1, title = $2 WHERE id = $3`, [
        userMsg?.document_snapshot ?? null,
        !session.title && userMsg ? titleFrom(userMsg.content) : session.title,
        session.id,
      ]);
      // Decisions made before this turn started were sent with it.
      await client.query(
        `UPDATE draft_edits SET decision_reported = true
         WHERE session_id = $1 AND decision_reported = false
           AND status IN ('accepted', 'rejected') AND decided_at <= ${replyCreatedAt}`,
        [session.id, reply.id]
      );
    }

    // Release the lock, unless a newer turn has taken it over meanwhile.
    await client.query(
      `UPDATE draft_sessions SET active_turn_started_at = NULL
       WHERE id = $1 AND active_turn_started_at <= ${replyCreatedAt}`,
      [session.id, reply.id]
    );
    return [200, { message: "Saved" }] as Result;
  });
};

const actions = new Map<string, (ctx: Ctx) => Promise<Result>>([
  ["list", list],
  ["create", create],
  ["get", get],
  ["update", update],
  ["delete", deleteDocument],
  ["create_session", createSession],
  ["set_attachments", setAttachments],
  ["get_session", getSession],
  ["delete_session", deleteSession],
  ["decide_edit", decideEdit],
  ["start_turn", startTurn],
  ["save_edit", saveEdit],
  ["finish_turn", finishTurn],
]);

export const draftsRouter = Router({ mergeParams: true });

draftsRouter.post("/drafts", requirePermission("draft_documents"), async (req, res) => {
  const body = parse(payloadSchema, req.body);
  // Malformed ids can't exist; answer 404 instead of a database error.
  for (const key of ID_KEYS) {
    if (body[key] !== undefined && !UUID_RE.test(String(body[key]))) throw notFound();
  }
  const action = typeof body.action === "string" ? actions.get(body.action) : undefined;
  if (!action) throw badRequest("Unknown action");
  const [status, result] = await action({ db: req.db, user: req.user, body });
  res.status(status).json(result);
});

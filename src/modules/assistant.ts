import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import type pg from "pg";
import { z } from "zod";
import type { AuthUser } from "../http/context.js";
import { requirePermission } from "../http/context.js";
import { forbidden, HttpError, notFound, parse } from "../http/errors.js";
import { query, type ChatMessage } from "../rag/chain.js";
import type { DraftModel } from "../rag/draft/agent.js";
import { createDraftChatHandler } from "../rag/draft/handler.js";
import { describeError, getEmbedder, type Embedder } from "../rag/embeddings.js";
import { getChatModel } from "../rag/llm.js";
import { startReindex, type ReindexOverrides } from "../rag/reindex.js";

const HISTORY_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 100_000;
const AI_REQUESTS_PER_WINDOW = 60;
const AI_WINDOW_MS = 15 * 60_000;
// Failure placeholders the old client stored as assistant replies. They are not conversation.
const STORED_FAILURES = ["Fel: kunde inte nå servern.", "Internal server error", "Inget svar"];

const sessionParams = z.object({ id: z.string().uuid() });
const messageBody = z.object({
  message: z
    .string()
    .max(MAX_MESSAGE_CHARS)
    .refine((s) => s.trim().length > 0, "message is required"),
});

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  sources: string[] | null;
  created_at: string;
}

const MESSAGE_COLUMNS = "id, session_id, role, content, sources, created_at";

async function assertChatSessionWritable(db: pg.Pool, user: AuthUser, sessionId: string): Promise<void> {
  if (!user.permissions.has("send_chat")) throw forbidden("Missing permission: send_chat");
  const { rowCount } = await db.query("SELECT 1 FROM chat_sessions WHERE id = $1 AND user_id = $2", [
    sessionId,
    user.id,
  ]);
  if (!rowCount) throw notFound("Chat session not found");
}

async function recentHistory(db: pg.Pool, sessionId: string, beforeId: string): Promise<ChatMessage[]> {
  const { rows } = await db.query<ChatMessage>(
    `SELECT role, content FROM chat_messages
     WHERE session_id = $1 AND id <> $2
       AND created_at <= (SELECT created_at FROM chat_messages WHERE id = $2)
       AND NOT (content = ANY($3::text[]))
     ORDER BY created_at DESC
     LIMIT $4`,
    [sessionId, beforeId, STORED_FAILURES, HISTORY_MESSAGES]
  );
  return rows.reverse();
}

export interface AssistantDeps {
  embedder?: Embedder;
  chatModel?: BaseChatModel;
  draftModel?: DraftModel;
  reindex?: ReindexOverrides;
}

export function createAssistantRouter(deps: AssistantDeps = {}): Router {
  const router = Router({ mergeParams: true });

  // Per user, shared by chat and drafting, because each request spends paid tokens.
  const aiLimiter = rateLimit({
    windowMs: AI_WINDOW_MS,
    limit: AI_REQUESTS_PER_WINDOW,
    keyGenerator: (req) => req.user.id,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many AI requests, try again later", code: "rate_limited" },
  });

  router.post("/chat/sessions/:id/messages", aiLimiter, async (req, res) => {
    const { id: sessionId } = parse(sessionParams, req.params);
    const { message } = parse(messageBody, req.body);
    const { db, user } = req;
    await assertChatSessionWritable(db, user, sessionId);

    // Resolved first, so an unconfigured server stores nothing.
    const embedder = deps.embedder ?? getEmbedder();
    const llm = deps.chatModel ?? getChatModel();

    const { rows: saved } = await db.query<ChatMessageRow>(
      `INSERT INTO chat_messages (session_id, role, content)
       VALUES ($1, 'user', $2) RETURNING ${MESSAGE_COLUMNS}`,
      [sessionId, message]
    );
    const userMessage = saved[0]!;

    try {
      const history = await recentHistory(db, sessionId, userMessage.id);
      const { answer, sources } = await query({ db, embedder, llm }, user.id, message, history);
      const { rows } = await db.query<ChatMessageRow>(
        `INSERT INTO chat_messages (session_id, role, content, sources)
         VALUES ($1, 'assistant', $2, $3::jsonb) RETURNING ${MESSAGE_COLUMNS}`,
        [sessionId, answer, JSON.stringify(sources)]
      );
      res.status(201).json({ userMessage, assistantMessage: rows[0], sources });
    } catch (err) {
      // Leave no unanswered question behind, so the client can simply retry.
      await db.query("DELETE FROM chat_messages WHERE id = $1", [userMessage.id]).catch(() => undefined);
      console.error(`[assistant] chat failed: ${describeError(err)}`);
      throw new HttpError(502, "The AI service could not answer. Try again.", "ai_upstream_error");
    }
  });

  router.post(
    "/draft/chat",
    requirePermission("draft_documents"),
    aiLimiter,
    createDraftChatHandler({ embedder: deps.embedder, draftModel: deps.draftModel })
  );

  router.post("/reindex", requirePermission("manage_settings"), async (req, res) => {
    const { logId, done } = await startReindex("api", { embedder: deps.embedder, ...deps.reindex });
    done.catch((err) => console.error(`[reindex] failed: ${describeError(err)}`));
    res.status(202).json({ message: "Reindex started", syncLogId: logId });
  });

  return router;
}

export const assistantRouter = createAssistantRouter();

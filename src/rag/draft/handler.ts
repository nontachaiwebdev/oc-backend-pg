import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { HttpError, parse } from "../../http/errors.js";
import { ragConfig } from "../config.js";
import { describeError, getEmbedder, type Embedder } from "../embeddings.js";
import { getDraftModel } from "../llm.js";
import { formatContext, retrieve, userHasVisibleFiles } from "../retrieval.js";
import { runDraftTurn, type DraftModel } from "./agent.js";
import type { Attachment, ChatMessage, DraftEvent, DraftTurnInput, EditDecision } from "./types.js";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_NAME = 200;

const bodySchema = z.object({
  mode: z.enum(["draft", "review"]).nullish(),
  message: z.string().refine((s) => s.trim().length > 0, "message is required"),
  attachments: z
    .array(z.object({ name: z.string(), content: z.string() }))
    .max(MAX_ATTACHMENTS, `at most ${MAX_ATTACHMENTS} attachments are allowed`)
    .nullish(),
  document: z.string({ required_error: "document is required (may be an empty string)" }),
  lastSeenDocument: z.string().nullish(),
  // As in typit-llm, malformed entries in these two lists are dropped, not rejected.
  history: z.unknown(),
  editDecisions: z.unknown(),
});

const historyItem = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
const decisionItem = z.object({
  editId: z.string(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.unknown(),
  newText: z.unknown(),
});

function parseBody(body: unknown): DraftTurnInput {
  const b = parse(bodySchema, body ?? {});
  // The name goes into a tag attribute in the prompt, so keep it tame.
  const attachments: Attachment[] = (b.attachments ?? []).map((a) => ({
    name: a.name.replace(/["<>]/g, "").trim().slice(0, MAX_ATTACHMENT_NAME) || "bilaga",
    content: a.content,
  }));
  const total = attachments.reduce((n, f) => n + f.content.length, 0);
  if (total > ragConfig.draftMaxAttachmentChars) {
    throw new HttpError(413, `attachments exceed ${ragConfig.draftMaxAttachmentChars} characters in total`, "payload_too_large");
  }
  if (Math.max(b.document.length, b.lastSeenDocument?.length ?? 0) > ragConfig.draftMaxDocChars) {
    throw new HttpError(413, `document exceeds ${ragConfig.draftMaxDocChars} characters`, "payload_too_large");
  }
  const history: ChatMessage[] = (Array.isArray(b.history) ? b.history : []).flatMap((m) => {
    const item = historyItem.safeParse(m);
    return item.success ? [{ role: item.data.role, content: item.data.content }] : [];
  });
  const editDecisions: EditDecision[] = (Array.isArray(b.editDecisions) ? b.editDecisions : []).flatMap((d) => {
    const item = decisionItem.safeParse(d);
    if (!item.success) return [];
    const { editId, status, reason, newText } = item.data;
    return [{
      editId,
      status,
      reason: typeof reason === "string" ? reason : undefined,
      newText: typeof newText === "string" ? newText : undefined,
    }];
  });
  return {
    mode: b.mode === "review" ? "review" : "draft",
    message: b.message,
    attachments,
    history,
    document: b.document,
    lastSeenDocument: b.lastSeenDocument ?? undefined,
    editDecisions,
  };
}

export interface DraftHandlerDeps {
  embedder?: Embedder;
  draftModel?: DraftModel;
}

/** Stateless drafting turn over SSE. Storing the turn is the caller's job, as before. */
export function createDraftChatHandler(deps: DraftHandlerDeps = {}): RequestHandler {
  return async (req: Request, res: Response) => {
    const input = parseBody(req.body);
    const model = deps.draftModel ?? (getDraftModel() as unknown as DraftModel);
    const embedder = deps.embedder ?? getEmbedder();
    const { db, user } = req;
    const hasAccess = await userHasVisibleFiles(db, user.id);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering (nginx)
    res.flushHeaders();

    // Stop the model (and stop paying for tokens) if the client disconnects.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const emit = (e: DraftEvent) => {
      if (res.writableEnded || abort.signal.aborted) return;
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    };

    const docSearch = {
      hasAccess,
      retrieve: (query: string) => retrieve(db, embedder, user.id, query),
      formatContext,
    };

    try {
      await runDraftTurn(input, emit, abort.signal, docSearch, model);
      emit({ event: "done", data: {} });
    } catch (err) {
      if (!abort.signal.aborted) {
        console.error(`draft chat failed: ${describeError(err)}`);
        emit({ event: "error", data: { message: "Något gick fel. Försök igen." } });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  };
}

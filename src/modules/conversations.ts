import { Router, type NextFunction, type Request, type Response } from "express";
import { badRequest } from "../http/errors.js";
import { assertChatSessionWritable, chatRouter } from "./conversations/chat.js";
import { draftsRouter } from "./conversations/drafts.js";

export { assertChatSessionWritable };

// Postgres rejects NUL characters in text (22021) and jsonb (22P05). That is bad input, not a 500.
const INVALID_TEXT_CODES = new Set(["22021", "22P05"]);

export const conversationsRouter = Router({ mergeParams: true });
conversationsRouter.use(chatRouter);
conversationsRouter.use(draftsRouter);
conversationsRouter.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  next(code && INVALID_TEXT_CODES.has(code) ? badRequest("Text contains invalid characters") : err);
});

import { Router } from "express";
import { assistantRouter } from "./assistant.js";
import { contentRouter } from "./content.js";
import { conversationsRouter } from "./conversations.js";
import { filesRouter } from "./files.js";
import { usersRouter } from "./users.js";

// Domain routers are mounted here. Everything is under /api and authenticated.
export const domainRouter = Router({ mergeParams: true });

domainRouter.use(usersRouter);
domainRouter.use(filesRouter);
domainRouter.use(contentRouter);
domainRouter.use(conversationsRouter);
domainRouter.use(assistantRouter);

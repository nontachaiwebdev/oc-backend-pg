import { Router } from "express";
import { activitiesRouter } from "./content/activities.js";
import { faqRouter } from "./content/faq.js";
import { syncLogsRouter } from "./content/syncLogs.js";

/** FAQ, activity calendar and sync log routes. Mounted under /api behind requireAuth. */
export const contentRouter = Router({ mergeParams: true });

contentRouter.use("/faq", faqRouter);
contentRouter.use("/activities", activitiesRouter);
contentRouter.use("/sync-logs", syncLogsRouter);

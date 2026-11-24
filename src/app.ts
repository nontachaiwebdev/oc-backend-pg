import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { authRouter } from "./auth/routes.js";
import { config } from "./config.js";
import { checkDatabase } from "./db/pool.js";
import { dbContext, requireAuth } from "./http/context.js";
import { errorHandler, notFound } from "./http/errors.js";
import { domainRouter } from "./modules/index.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
      allowedHeaders: ["Authorization", "Content-Type", "X-Requested-With"],
      exposedHeaders: ["Content-Disposition", "Content-Length", "X-Source-Ambiguous"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    })
  );
  app.use(cookieParser());
  // Draft requests carry whole documents, so this matches the existing chat API limit.
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", async (_req, res) => {
    const ok = await checkDatabase();
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", service: config.serviceName, database: ok });
  });

  app.use("/api", dbContext);
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth, domainRouter);

  app.use((_req, _res, next) => next(notFound("Route not found")));
  app.use(errorHandler);
  return app;
}

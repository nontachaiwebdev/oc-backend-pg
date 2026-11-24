import { createApp } from "./app.js";
import { config } from "./config.js";
import { closePool } from "./db/pool.js";
import { startNightlyReindex } from "./rag/nightly.js";

const server = createApp().listen(config.port, () => {
  console.log(`oc-pg-api listening on port ${config.port}`);
});

const stopNightlyReindex = startNightlyReindex();

const shutdown = () => {
  stopNightlyReindex();
  server.close(() => {
    closePool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

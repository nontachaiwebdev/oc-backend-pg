import { closePool } from "../db/pool.js";
import { HttpError } from "../http/errors.js";
import { describeError } from "./embeddings.js";
import { startReindex } from "./reindex.js";

try {
  const { logId, done } = await startReindex("cli");
  console.log(`[reindex] started, sync log ${logId}`);
  console.log("[reindex] finished", await done);
} catch (err) {
  const message = err instanceof HttpError ? err.message : describeError(err);
  console.error(`[reindex] failed: ${message}`);
  process.exitCode = err instanceof HttpError && err.status === 409 ? 2 : 1;
} finally {
  await closePool();
}

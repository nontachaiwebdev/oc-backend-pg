import { config } from "../config.js";
import { HttpError } from "../http/errors.js";
import { describeError } from "./embeddings.js";
import { startReindex } from "./reindex.js";

const TIME_ZONE = "Europe/Stockholm";
const CHECK_INTERVAL_MS = 30_000;

/** The Stockholm date and HH:MM of an instant. */
export function stockholmClock(now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Due once per Stockholm day, during the configured minute. */
export function isNightlyDue(now: Date, scheduledTime: string, lastRunDate: string | null): boolean {
  const { date, time } = stockholmClock(now);
  return time === scheduledTime && date !== lastRunDate;
}

async function runNightly(): Promise<void> {
  try {
    const { logId, done } = await startReindex("schedule");
    console.log(`[reindex] nightly run started, sync log ${logId}`);
    console.log("[reindex] nightly run finished", await done);
  } catch (err) {
    // Another instance or a manual run holds the lock, so the index is already being updated.
    if (err instanceof HttpError && err.status === 409) {
      console.log("[reindex] nightly run skipped: a reindex is already running");
      return;
    }
    console.error(`[reindex] nightly run failed: ${err instanceof HttpError ? err.message : describeError(err)}`);
  }
}

/** Starts the nightly schedule and returns a function that stops it. */
export function startNightlyReindex(): () => void {
  const scheduledTime = config.reindexNightlyTime;
  if (!scheduledTime) {
    console.log("[reindex] nightly job is off");
    return () => undefined;
  }
  console.log(`[reindex] nightly job scheduled for ${scheduledTime} ${TIME_ZONE}`);

  let lastRunDate: string | null = null;
  const timer = setInterval(() => {
    const now = new Date();
    if (!isNightlyDue(now, scheduledTime, lastRunDate)) return;
    lastRunDate = stockholmClock(now).date;
    void runNightly();
  }, CHECK_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

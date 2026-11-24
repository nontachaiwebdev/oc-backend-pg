import { OpenAIEmbeddings } from "@langchain/openai";
import { unavailable } from "../http/errors.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, ragConfig } from "./config.js";

export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

interface ProviderError {
  status?: number;
  code?: string;
  name?: string;
  response?: { status?: number };
  error?: { code?: string };
  headers?: Record<string, string> | { get?: (k: string) => string | null };
}

export const errorStatus = (err: unknown): number | undefined => {
  const e = err as ProviderError;
  return e?.status ?? e?.response?.status;
};

const errorCode = (err: unknown) => {
  const e = err as ProviderError;
  return e?.code ?? e?.error?.code;
};

/** Rate limits and server faults are retried. An exhausted quota never recovers by waiting. */
export function isRetryable(err: unknown): boolean {
  if (errorCode(err) === "insufficient_quota") return false;
  const status = errorStatus(err);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  const code = String(errorCode(err) ?? "");
  const name = (err as ProviderError)?.name ?? "";
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR)/.test(code) ||
    /connection|timeout/i.test(name);
}

/** The input itself was rejected, so only the texts in this request are affected. */
export const isBadInput = (err: unknown) => [400, 413, 422].includes(errorStatus(err) ?? 0);

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as ProviderError)?.headers;
  if (!headers) return undefined;
  const value =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get: (k: string) => string | null }).get("retry-after")
      : (headers as Record<string, string>)["retry-after"];
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export interface BackoffOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withBackoff<T>(fn: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
  const { retries = 6, baseMs = 1000, maxMs = 60_000, signal, sleep = defaultSleep } = options;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      await sleep(Math.min(maxMs, Math.max(jittered, retryAfterMs(err) ?? 0)));
    }
  }
}

let embedder: Embedder | undefined;

/** The OpenAI embedder. Retries live in withBackoff. Throws a 503 without a key. */
export function getEmbedder(): Embedder {
  if (embedder) return embedder;
  if (!ragConfig.openaiApiKey) throw unavailable("AI search is not configured: OPENAI_API_KEY is missing");
  embedder = new OpenAIEmbeddings({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    apiKey: ragConfig.openaiApiKey,
    maxRetries: 0,
  });
  return embedder;
}

/** A failure of our own, whose message is safe to log and store. */
export class SafeError extends Error {}

/** A log-safe description: provider messages can echo request content or key fragments. */
export function describeError(err: unknown): string {
  if (err instanceof SafeError) return err.message;
  const status = errorStatus(err);
  const code = errorCode(err);
  if (status) return `Upstream error (HTTP ${status}${code ? `, ${code}` : ""})`;
  if (code) return `Error (${code})`;
  return (err as Error)?.name || "Unknown error";
}

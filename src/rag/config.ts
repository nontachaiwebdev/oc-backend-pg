import "dotenv/config";
import { z } from "zod";

export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;
/** Bump when parsing, chunking or embedding changes, to force a full re-embed. */
export const PIPELINE_VERSION = 1;
/** Written to sync_logs.pinecone_index, which is kept for the admin UI. */
export const INDEX_NAME = "pgvector";

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = z.preprocess(blank, z.string().optional());

const env = z
  .object({
    OPENAI_API_KEY: optional,
    LLM_PROVIDER: optional,
    ANTHROPIC_API_KEY: optional,
    ANTHROPIC_MODEL: optional,
    DRAFT_MODEL: optional,
    DRAFT_ALLOWED_DOMAINS: optional,
    DRAFT_MAX_DOC_CHARS: optional,
    DRAFT_MAX_ATTACHMENT_CHARS: optional,
  })
  .parse(process.env);

export const ragConfig = {
  openaiApiKey: env.OPENAI_API_KEY,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  // Same rule as typit-llm: anything other than "anthropic" means OpenAI.
  llmProvider: (env.LLM_PROVIDER ?? "openai").toLowerCase() === "anthropic" ? "anthropic" : "openai",
  anthropicModel: env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  openaiChatModel: "gpt-4o-mini",
  draftModel: env.DRAFT_MODEL ?? "claude-sonnet-5-5",
  draftAllowedDomains: env.DRAFT_ALLOWED_DOMAINS,
  draftMaxDocChars: Number(env.DRAFT_MAX_DOC_CHARS) || 100_000,
  draftMaxAttachmentChars: Number(env.DRAFT_MAX_ATTACHMENT_CHARS) || 100_000,
} as const;

import type { Document } from "@langchain/core/documents";
import type pg from "pg";
import type { Embedder } from "./embeddings.js";
import { withBackoff } from "./embeddings.js";

export const TOP_K = 15;
export const MAX_CONTEXT_CHUNKS = 8;
export const MIN_SCORE = 0.35;
export const SCORE_WINDOW = 0.15;

/**
 * Files a user may read, as in typit-llm's permissions.ts: direct grants plus
 * grants to their groups, any access level, with a folder grant covering every
 * descendant. No role bypasses this, and no rows means no access.
 * UNION (not UNION ALL) also stops the walk if the tree ever contains a cycle.
 */
export const VISIBLE_FILES = `
  grants AS (
    SELECT fp.file_id FROM file_permissions fp WHERE fp.user_id = $1
    UNION
    SELECT fp.file_id FROM file_permissions fp
    JOIN group_members gm ON gm.group_id = fp.group_id
    WHERE gm.user_id = $1
  ),
  visible AS (
    SELECT f.id, f.is_directory FROM files f JOIN grants g ON g.file_id = f.id
    UNION
    SELECT c.id, c.is_directory FROM files c
    JOIN visible v ON c.parent_id = v.id
    WHERE v.is_directory
  )`;

export async function userHasVisibleFiles(db: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `WITH RECURSIVE ${VISIBLE_FILES}
     SELECT EXISTS (SELECT 1 FROM visible WHERE NOT is_directory) AS ok`,
    [userId]
  );
  return rows[0]?.ok === true;
}

export interface ScoredChunk {
  id: string;
  file_id: string;
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

/**
 * Exact cosine search over the permitted chunks only. The MATERIALIZED CTE keeps
 * the filter ahead of the sort, so an ANN index added later could not be chosen
 * here and silently drop permitted results.
 */
export async function searchChunks(
  db: pg.Pool,
  userId: string,
  embedding: number[],
  limit = TOP_K
): Promise<ScoredChunk[]> {
  const { rows } = await db.query<ScoredChunk>(
    `WITH RECURSIVE ${VISIBLE_FILES},
     candidates AS MATERIALIZED (
       SELECT dc.id, dc.embedding <=> $2::vector AS distance
       FROM document_chunks dc
       WHERE dc.file_id IN (SELECT id FROM visible WHERE NOT is_directory)
     ),
     top_hits AS (
       SELECT id, distance FROM candidates ORDER BY distance, id LIMIT $3
     )
     SELECT dc.id, dc.file_id, dc.source, dc.content, dc.metadata,
            (1 - t.distance)::float8 AS score
     FROM top_hits t JOIN document_chunks dc ON dc.id = t.id
     ORDER BY t.distance, t.id`,
    [userId, JSON.stringify(embedding), limit]
  );
  return rows;
}

/** Keep hits within a reasonable range of the best score, at most 8. */
export function applyDynamicThreshold<T extends { score: number }>(hits: T[]): T[] {
  const topScore = hits[0]?.score ?? 0;
  const threshold = Math.max(MIN_SCORE, topScore - SCORE_WINDOW);
  return hits.filter((h) => h.score >= threshold).slice(0, MAX_CONTEXT_CHUNKS);
}

export async function retrieve(
  db: pg.Pool,
  embedder: Embedder,
  userId: string,
  searchQuery: string
): Promise<Document[]> {
  const embedding = await withBackoff(() => embedder.embedQuery(searchQuery), { retries: 3 });
  const hits = applyDynamicThreshold(await searchChunks(db, userId, embedding));
  return hits.map((h) => ({
    pageContent: h.content,
    metadata: { ...h.metadata, source: h.source },
  }));
}

export function formatContext(docs: Document[]): string {
  return docs
    .map((doc, i) => {
      const m = doc.metadata;
      const header = [m.docTitle, m.section].filter(Boolean).join(" > ");
      return `--- Dokument ${i + 1}: ${header || m.source || "okänd"} ---\n${doc.pageContent}`;
    })
    .join("\n\n");
}

# Assistant API

RAG chat, AI drafting and reindexing. All routes are under `/api` and need `Authorization: Bearer <access token>`.

Errors are JSON: `{ "error": "...", "code": "..." }`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid body or id |
| 401 | Missing or invalid token |
| 403 | Missing permission |
| 404 | Session not found or not owned by the caller |
| 409 | A reindex is already running |
| 413 | Draft document or attachments too large |
| 502 | The AI provider failed (`ai_upstream_error`) |
| 503 | The AI key is not configured (`service_unavailable`) |

## POST /chat/sessions/:id/messages

Requires `send_chat` and ownership of the session.

```json
{ "message": "Vad gäller för kost?" }
```

The server stores the question, answers it, stores the reply and returns `201`:

```json
{
  "userMessage": { "id": "...", "session_id": "...", "role": "user", "content": "...", "sources": null, "created_at": "..." },
  "assistantMessage": { "id": "...", "session_id": "...", "role": "assistant", "content": "...", "sources": ["D Genomförande/Rutin.docx"], "created_at": "..." },
  "sources": ["D Genomförande/Rutin.docx"]
}
```

- History comes from the last 5 stored messages. Any `history` in the body is ignored.
- If answering fails, the stored question is removed and the response is `502`, so the client can retry.
- A user with no permitted files gets the standard "no information" answer, with no AI calls.

## POST /draft/chat

Requires `draft_documents`. Stateless: the caller stores the turn.

```json
{
  "mode": "draft",
  "message": "Skriv en rutin för kost",
  "document": "",
  "lastSeenDocument": "",
  "attachments": [{ "name": "underlag.txt", "content": "..." }],
  "history": [{ "role": "user", "content": "..." }],
  "editDecisions": [{ "editId": "...", "status": "accepted", "reason": "...", "newText": "..." }]
}
```

`message` and `document` are required (`document` may be empty). `mode` is `draft`
(default) or `review`. At most 5 attachments.

The response is `text/event-stream`, with frames of `event: <name>\ndata: <json>\n\n`:

| Event | Data |
| --- | --- |
| `status` | `{ "message": string }` |
| `text` | `{ "delta": string }` |
| `source` | `{ "kind": "internal" \| "web" \| "law", "title", "url?", "file?", "reference?" }` |
| `edit` | `{ "editId", "type": "replace" \| "insert_after_heading" \| "append", "oldText?", "heading?", "newText", "reason", "sources" }` |
| `done` | `{}` |
| `error` | `{ "message": string }` |

Validation, permission and 503 errors are returned as JSON before the stream starts.
Closing the connection aborts the model call.

## Reindex

`POST /reindex` requires `manage_settings` and returns `202`:

```json
{ "message": "Reindex started", "syncLogId": "..." }
```

Progress is in that `sync_logs` row: `files_found`, `files_downloaded`, `files_failed`
and `chunks_indexed` update during the run; `details` is written at the end and lists
indexed and failed files (unchanged files are not listed).

From the command line:

```sh
npx tsx src/rag/reindex-cli.ts
```

Exit codes: `0` finished, `1` failed, `2` already running, `64` bad usage.

How a run behaves:

- One run per service, enforced by a PostgreSQL advisory lock across processes.
- Each file's SHA-256 is stored in `rag_file_index_state`. Unchanged files are not embedded.
- Each file's old chunks are replaced in one transaction, so a run can stop at any point and resume by running it again.
- After a rename or partial edit, chunks whose text is unchanged keep their vectors.
- Embeddings are sent in batches of 100, with backoff on 408, 429, 5xx and connection errors. An exhausted quota or an auth error stops the run.
- A file that cannot be downloaded or parsed is reported and keeps its existing chunks.
- Chunks of deleted or no-longer-docx files are removed. The index is never cleared up front.

To re-embed everything after changing parsing, chunking or the embedding model, bump
`PIPELINE_VERSION` in `src/rag/config.ts`.

## Retrieval

Exact cosine search in pgvector (`score = 1 - distance`), filtered first to the files the
user may read: direct grants and group grants, with a folder grant covering all its
descendants. It takes the top 15, keeps hits scoring at least `max(0.35, best - 0.15)`,
and uses at most 8. No vector index is used: about 90 ms at 30,000 chunks.

## Environment

| Variable | Default | Used for |
| --- | --- | --- |
| `OPENAI_API_KEY` | none | Embeddings (all AI endpoints) and chat when the provider is OpenAI |
| `LLM_PROVIDER` | `openai` | Chat provider: `openai` or `anthropic` |
| `ANTHROPIC_API_KEY` | none | Drafting, and chat when the provider is Anthropic |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Chat model when the provider is Anthropic |
| `DRAFT_MODEL` | `claude-sonnet-5-5` | Drafting model |
| `DRAFT_ALLOWED_DOMAINS` | Swedish authorities | Comma-separated web search allowlist |
| `DRAFT_MAX_DOC_CHARS` | `100000` | Document size limit |
| `DRAFT_MAX_ATTACHMENT_CHARS` | `100000` | Total attachment size limit |

The OpenAI chat model is `gpt-4o-mini`. The server boots without these keys; the
endpoints that need a missing key return `503`.

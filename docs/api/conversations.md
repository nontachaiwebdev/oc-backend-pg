# Conversations API (chat and drafts)

All paths are under `/api` and need `Authorization: Bearer <token>`.
Router: `conversationsRouter` from `src/modules/conversations.ts`.

Errors are `{ error, code? }`. A malformed or inaccessible id returns 404.

## Chat

Rows use the database's snake_case columns, as the Supabase client returned them.

| Old frontend call | New call | Body or query | Success response | Access |
|---|---|---|---|---|
| `chat_sessions.select().eq('user_id', me)` | `GET /chat/sessions` | Optional `?user_id=<uuid>` or `?all=true` | `{ sessions: ChatSession[] }`, newest `updated_at` first | Own. Other users or all: `view_chat` |
| Read one session (RLS) | `GET /chat/sessions/:id` | None | `{ session }` | Owner or `view_chat` |
| `chat_sessions.insert({ user_id, title })` | `POST /chat/sessions` | `{ title? }`, 1-500 chars | **201** `{ session }` | `send_chat`; the owner is always the caller |
| `chat_sessions.update({ title })` | `PATCH /chat/sessions/:id` | `{ title }`, 1-500 chars | `{ session }` | Owner only |
| `chat_sessions.delete()` | `DELETE /chat/sessions/:id` | None | **204** | Owner or `manage_chat` |
| `chat_messages.select()` + `chat_message_feedback.select().in(...)` | `GET /chat/sessions/:id/messages` | None | `{ messages: ChatMessageRow[], feedback: ChatMessageFeedback[] }` | Owner or `view_chat`. Feedback: own, or all with `view_chat` |
| `chat_messages.delete()` (RLS) | `DELETE /chat/sessions/:id/messages/:messageId` | None | **204** | Owner or `delete_chat_messages` |
| `chat_message_feedback.upsert(...)` | `PUT /chat/messages/:messageId/feedback` | `{ rating: "like" \| "dislike" }` | `{ feedback }` | Caller must be able to read the message |
| `chat_message_feedback.delete()` | `DELETE /chat/messages/:messageId/feedback` | None | **204**, also when there was none | Own feedback only |
| `chat_messages.insert(user or assistant)` + LLM call | `POST /chat/sessions/:id/messages` | Owned by the assistant module | | Uses `assertChatSessionWritable` |

There is deliberately no client endpoint for inserting chat messages.

`assertChatSessionWritable(db, user, sessionId)` is exported from `src/modules/conversations.ts`. It returns the session, or throws 403 (no `send_chat`, or another user's session the caller can see) or 404.

## Drafts

Every `manage-drafts` action is now:

```
POST /drafts
{ "action": "<action>", ...same fields as before }
```

It requires `draft_documents` and only touches the caller's own documents. Responses are the same camelCase shapes `manage-drafts` returned, so `callDrafts` in `draftApi.ts` only changes its URL and auth. Timestamps are ISO 8601 UTC strings.

| `manage-drafts` action | Body (besides `action`) | Success response |
|---|---|---|
| `list` | None | `{ documents: DocumentSummary[] }`, newest first |
| `create` | `title?`, `content?`, `mode?`, `attachments?`, `source_file_id?`, `saved_file_id?` | **201** `{ document, session }` |
| `get` | `document_id` | `{ document, sessions: SessionSummary[] }` |
| `update` | `document_id`, `title?`, `content?`, `saved_file_id?` (uuid or null) | `{ document }` |
| `delete` | `document_id` | `{ message: "Deleted" }` |
| `create_session` | `document_id`, `mode?` (default: latest session's mode) | **201** `{ session }` |
| `set_attachments` | `document_id`, `session_id`, `attachments: { fileId?, name, content? }[]` | `{ session }` |
| `get_session` | `document_id`, `session_id`, `snapshots?` | `{ session, messages, edits }` |
| `delete_session` | `document_id`, `session_id` | `{ message: "Deleted" }` |
| `decide_edit` | `document_id`, `session_id`, `edit_id`, `status: "accepted" \| "rejected"` | `{ edit }` |
| `start_turn` | `document_id`, `session_id`, `message`, `document` | `{ userMessageId, assistantMessageId, llmRequest }` |
| `save_edit` | `document_id`, `session_id`, `assistant_message_id`, `edit` | `{ message: "Saved" }`; retry is safe |
| `finish_turn` | `document_id`, `session_id`, `assistant_message_id`, `status: "complete" \| "failed" \| "aborted"`, `content?`, `sources?`, `error_message?` | `{ message: "Saved" }` |

`POST /draft/chat` (the SSE stream) belongs to the assistant module.

### Draft errors

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Invalid input, with the same message text as `manage-drafts` |
| 403 | `forbidden` | Missing `draft_documents` |
| 404 | `not_found` | Id doesn't exist, isn't yours, or is malformed |
| 409 | `turn_in_progress` | `start_turn` while another turn holds the lock |
| 409 | `turn_finished` | `save_edit` or `finish_turn` on an ended turn |
| 409 | `already_decided` | `decide_edit` on a decided edit |
| 413 | `payload_too_large` | `document` over 100,000 chars, or attachments over 100,000 chars in total |

### Limits and rules

- Title: at most 200 chars. Document: at most 100,000 chars.
- Attachments: at most 5 per session, 100,000 chars in total. Their content is never returned, except in `llmRequest`.
- Turn lock: one running turn per session. A lock older than **3 minutes** can be taken over. This matches `TURN_LOCK_MS` in both `manage-drafts` and the frontend's `useDraftChat`. The "5 minutes" in the database column comment is out of date.
- Decisions are sent on the next turn and marked reported only when a turn that included them completes.

### Differences from `manage-drafts`

- `update` with a non-null `saved_file_id` now requires the file to be visible to the caller (`manage_files`), as `create` already did.
- A non-string `error_message` in `finish_turn` is a 400.
- Turn steps are transactional and serialized per session with a row lock.

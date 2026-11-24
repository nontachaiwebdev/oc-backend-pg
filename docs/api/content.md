# Content API: FAQ, activities, sync logs

All paths are under `/api` and need `Authorization: Bearer <access token>`.

Errors are `{ "error": string, "code": string }`. Timestamps are ISO 8601 UTC (`...Z`). `due_date` is `YYYY-MM-DD`.

Router: `contentRouter` from `src/modules/content.ts`.

## FAQ

| Old frontend call | New call | Permission | Body / query | Response |
|---|---|---|---|---|
| `functions.invoke('list-faq')` (`useFaqPublic`) | `GET /faq` | `view_faq` or `manage_faq` | none | `{ sections: [{ ...section, faq_items: [item] }] }` |
| `faq_sections.select('*').eq('group_id', g).order('sort_order')` (`useFaqSections`) | `GET /faq/sections?group_id=g` | `manage_faq` or `manage_file_access` | `group_id` optional | `[section]` |
| `faq_items.select('*, faq_permissions(count)')`, optional `.eq('section_id', s)` (`useFaqItems`) | `GET /faq/items?section_id=s` | `manage_faq` or `manage_file_access` | `section_id` optional | `[{ ...item, faq_permissions: [{ count }] }]` |
| `faq_sections.insert(...)` (`CreateSectionModal`) | `POST /faq/sections` | `manage_faq` | `{ title, description?, sort_order?, is_active?, group_id }` | `201` section |
| `faq_sections.update(...).eq('id', id)` (`EditSectionModal`) | `PATCH /faq/sections/:id` | `manage_faq` | any of `title, description, sort_order, is_active, group_id` | section, `404` if missing |
| `faq_sections.delete().eq('id', id)` (`DeleteSectionModal`) | `DELETE /faq/sections/:id` | `manage_faq` | none | `204`; cascades to items and grants |
| `faq_items.insert(...)` (`CreateItemModal`) | `POST /faq/items` | `manage_faq` | `{ section_id, question, answer, sort_order?, is_active? }` | `201` item |
| `faq_items.update(...).eq('id', id)` (`EditItemModal`) | `PATCH /faq/items/:id` | `manage_faq` | any of `section_id, question, answer, sort_order, is_active` | item, `404` if missing |
| `faq_items.delete().eq('id', id)` (`DeleteItemModal`) | `DELETE /faq/items/:id` | `manage_faq` | none | `204` |
| `faq_sections.select('id, title, group_id, is_active, items:faq_items(...)')` (`useFaqAccess`) | `GET /faq/access/sections` | `manage_faq` or `manage_file_access` | none | `[{ id, title, group_id, is_active, items: [{ id, question, is_active }] }]` |
| `faq_permissions.select('item_id').eq('user_id' or 'group_id', x)` (`fetchGrants`) | `GET /faq/permissions?user_id=x` or `?group_id=x` | `manage_faq` or `manage_file_access` | exactly one subject | `[{ item_id }]` |
| `faq_permissions.delete()` + `.upsert()` (`saveGrants`) | `PUT /faq/permissions` | `manage_file_access` | `{ user_id` or `group_id, add: [itemId], remove: [itemId] }` | `{ error: null }` |

`PUT /faq/permissions` runs removals then additions in one transaction. `granted_by` is always the caller, so the frontend no longer sends it.

`GET /faq` returns only active questions granted to the caller directly or through a group, inside active sections. `manage_faq` holders get every active question. Grants are never included.

## Activities

| Old frontend call | New call | Permission | Body / query | Response |
|---|---|---|---|---|
| `functions.invoke('list-activities', { body: { year } })` (`useActivities`) | `GET /activities?year=2026` | any user | `year` 2000-2100 | `{ types, activities: [{ ...activity, restricted }], instances }` |
| `activity_types.select(...)` (`useActivityTypes`) | `GET /activities/types` | any user | none | `[{ id, code, name, color, sort_order }]` |
| `manage-activities` `list` | `GET /activities/manage` | `manage_activities` | none | `{ activities: [{ ...activity, is_active, created_at, updated_at, type, activity_visibility_grants, has_history }] }` |
| `manage-activities` `create` | `POST /activities` | `manage_activities` | `ActivityInput` | `201 { id, message: "Saved" }` |
| `manage-activities` `update` | `PUT /activities/:id` | `manage_activities` | `ActivityInput` (full replace) | `{ id, message: "Saved" }` |
| `manage-activities` `archive` | `POST /activities/:id/archive` | `manage_activities` | none | `{ message: "Archived" }` |
| `manage-activities` `restore` | `POST /activities/:id/restore` | `manage_activities` | none | `{ message: "Restored" }` |
| `manage-activities` `delete` | `DELETE /activities/:id` | `manage_activities` | none | `{ message: "Deleted" }`, or `409` with `code: "has_history"` |
| `functions.invoke('acknowledge-activity', { body })` (`useAcknowledgeActivity`) | `POST /activities/acknowledge` | anyone who can see the activity | `{ activity_id, due_date, status: "in_progress" or "done", note?, evidence_file_id? }` | `{ instance }` |

`ActivityInput`: `{ name, type_id, responsible_role, document_ref, file_id, frequency, recur_month, recur_day, requires_evidence, visibility, group_ids, user_ids }`.

Sign-off errors:

| Status | `code` | When |
|---|---|---|
| 400 | `evidence_required` | `done` on an evidence activity with no note or file |
| 400 | `bad_request` | Invalid input, or the activity is archived |
| 403 | `already_signed_off` | A non-admin tries to reopen a `done` occurrence |
| 404 | `not_found` | The activity is missing or not visible to the caller |

## Sync logs

| Old frontend call | New call | Permission | Body / query | Response |
|---|---|---|---|---|
| `sync_logs.select(LIST_COLUMNS, { count: 'exact' })` + `files.select('id, name')` (`useSyncLogs`) | `GET /sync-logs?target=all&status=all&page=0` | `view_sync_logs` | `target`, `status`, zero-based `page` (50 per page) | `{ logs, total, directory_names: { [id]: name } }` |
| `sync_logs.select('details').eq('id', id).single()` (`fetchSyncLogDetails`) | `GET /sync-logs/:id/details` | `view_sync_logs` | none | `{ details: [...] }` |

`directory_names` is empty unless the caller also has `manage_files`, matching the `files` read policy. The page then shows the id. Build a `Map` from it with `new Map(Object.entries(directory_names))`.

## Differences from Supabase

- Reads the caller may not make return `403`. RLS returned an empty list with `200`.
- `PATCH` on a missing FAQ row returns `404`. PostgREST reported success with no rows.
- A sign-off on an archived activity the caller cannot see returns `404`. The edge function returned the archived message, which revealed that the activity exists.
- An impossible `due_date` such as `2026-02-31` returns the normal date validation error.
- Activity saves and FAQ grant saves are atomic.

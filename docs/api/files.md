# Files API

Replaces Supabase access to `files`, `file_groups`, `file_permissions`, the `knowledge-base` bucket, and the `manage-files`, `get-source-file` and `list-templates` edge functions.

All paths are under `/api` and need `Authorization: Bearer <access token>`. Errors are `{ "error": string, "code": string }`.

## Frontend call mapping

| Frontend source | Old Supabase call | New call | Body or query | Response |
|---|---|---|---|---|
| `useFiles.fetchFiles` | `files.select('*')` by group and parent, then `profiles` | `GET /files` | `?group_id&parent_id&limit&offset` (omit `parent_id` for root) | `FileEntryWithUploader[]`, with `uploader: { full_name, email } \| null` |
| `useFiles.buildBreadcrumbs` | Repeated `files.select('id, name, parent_id')` | `GET /files/:id/breadcrumbs` | | `[{ id, name }]`, root to current. Add the group root crumb client-side |
| `useFiles.createDirectory` | `files.insert({ is_directory: true })` | `POST /files/directories` | `{ name, group_id, parent_id }` | `201` `FileEntry` |
| `useFiles.uploadFiles` (folder lookup and create) | `files.select` and `files.insert` per folder | `POST /files/directories/ensure` | `{ group_id, parent_id, paths: ["Rapporter/2026"] }` | `{ directories: { "Rapporter": id, "Rapporter/2026": id } }` |
| `uploadFileToKnowledgeBase` | `storage.upload` and `files.insert` | `POST /files/upload` | Query `name, group_id, parent_id, mime_type`; raw body | `201` `FileEntry` |
| `useFiles.renameEntry` | `files.update({ name })` | `PATCH /files/:id` | `{ name }` | `FileEntry` |
| `useFiles.moveEntry` | `files.update({ parent_id })` | `PATCH /files/:id` | `{ parent_id }` (`null` for root) | `FileEntry` |
| `useFiles.deleteEntry` | `manage-files` `{ action: 'delete', file_id }` | `DELETE /files/:id` | | `{ message, deleted }` |
| Batch delete (no current UI) | Not available | `POST /files/batch-delete` | `{ ids: uuid[] }`, up to 1000 | `{ message, deleted }` |
| `useFiles.downloadFile` | `storage.createSignedUrl(path, 60, { download })` | `GET /files/:id/content` | | File stream. Pass the file id, not `storage_path` |
| `useDocxFile` load | `files.select('*').single()` | `GET /files/:id` | | `FileEntry` |
| `useDocxFile` load | `createSignedUrl` and `fetch` | `GET /files/:id/content` | | File stream |
| `useDocxFile.saveFile` | `storage.update` and `files.update({ size_bytes })` | `PUT /files/:id/content` | Query `mime_type`; raw body | `FileEntry` |
| `replaceKnowledgeBaseFile` | `storage.update` and `files.update({ size_bytes })` | `PUT /files/:id/content` | Query `mime_type`; raw body | `FileEntry` |
| `getKnowledgeBaseFile` | `files.select('id, name, group_id')` | `GET /files/:id` | | `FileEntry`, or `404` |
| `knowledgeBaseFileToMarkdown` | `files.select` and `storage.download` | `GET /files/:id`, then `GET /files/:id/content` | | `FileEntry`, then file stream |
| `DirectoryPicker` | `files.select('id, name, parent_id, is_directory')` | `GET /files/tree` | `?group_id&directories_only=true&limit&offset` | `[{ id, name, is_directory, parent_id }]` |
| `useFileAccess` tree | Paged `files.select(...)` | `GET /files/tree` | `?group_id&limit&offset` | Same rows, ordered directories first, then name and id |
| `useSyncLogs` | `files.select('id, name').in('id', ids)` | `GET /files/lookup` | `?ids=a,b,c` | `[{ id, name, group_id }]` |
| `useFileAccess.fetchGrants` | Paged `file_permissions.select('file_id, access_level, files(group_id, is_directory)')` | `GET /file-permissions` | `?user_id` or `?group_id`, plus `limit&offset` | `[{ file_id, access_level, files: { group_id, is_directory } \| null }]` |
| `useFileAccess.saveGrants` | Batched `delete` and `upsert` | `PUT /file-permissions` | `{ user_id` or `group_id, view_file_ids, manage_file_ids, remove_file_ids }` | `{ saved, removed }`, atomic |
| `useFileGroups` load | `file_groups.select('*')` | `GET /file-groups` | | `FileGroup[]`, default first, then name |
| `useFileGroups.createFileGroup` | `file_groups.insert` | `POST /file-groups` | `{ name }` | `201` `FileGroup` |
| `useFileGroups.renameFileGroup` | `file_groups.update({ name })` | `PATCH /file-groups/:id` | `{ name }` | `FileGroup` |
| `useSourceDownload` | `get-source-file` `{ source }` returning `{ url, name, ambiguous }` | `POST /source-files/download` | `{ source }` | File stream. Name is in `Content-Disposition` |
| `useTemplates` | `list-templates` | `GET /templates` | `?limit&offset` | `{ files: TemplateEntry[], total }` |

## Access rules

| Operation | Required permission |
|---|---|
| Read file metadata | `manage_files`. Otherwise lists are `[]` and `GET /files/:id` is `404`, matching RLS |
| Read, write or delete file content; create, move, rename or delete entries | `manage_files`, otherwise `403` |
| List file groups | Any of `manage_files`, `manage_faq`, `manage_file_access`, `manage_content_groups`. Otherwise `[]` |
| Create or rename file groups | `manage_content_groups` |
| Read grants | `manage_file_access`, or `user_id` equal to the caller. The embedded `files` is `null` without `manage_files` |
| Change grants | `manage_file_access` |
| `POST /source-files/download`, `GET /templates` | Files granted to the user or their groups, including through a folder. `manage_files` sees all |

File groups have no delete endpoint because there was no delete policy.

## Client changes

**Uploads.** Send the raw file with `Content-Type: application/octet-stream`, and put the real type in the `mime_type` query parameter. Other content types get `415`, because the global JSON parser would otherwise consume `.json` uploads. The limit is 50 MB (`413`).

```ts
const query = new URLSearchParams({ name: file.name, group_id: groupId, mime_type: file.type })
if (parentId) query.set('parent_id', parentId)
await fetch(`${api}/files/upload?${query}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
  body: file,
})
```

**Downloads.** These endpoints need the bearer token, so `window.open(url)` and plain links no longer work. Fetch the response as a blob, then click a temporary object URL. Read the file name from `Content-Disposition`, preferring `filename*`.

**Folder upload.** Collect each file's directory from `webkitRelativePath`, call `/files/directories/ensure` once, then upload each file with its `parent_id`. A file occupying a folder's name returns `409` and creates nothing.

**Paging.** List endpoints return at most 1000 rows per request. Keep requesting with `offset` until a page is shorter than `limit`. `DirectoryPicker` and `useTemplates` do not page today, so they must, or large knowledge bases results are truncated.

**Duplicate names.** Check `code === 'unique_violation'` instead of the Postgres code `23505`.

**Storage paths.** `PUT /files/:id/content` writes a new blob and changes `storage_path`. Do not cache that value. Use file ids for all content calls.

**Ambiguous sources.** `POST /source-files/download` reports `X-Source-Ambiguous: true|false`. The browser can read it only if the header is added to the CORS `exposedHeaders`. The current frontend does not use this value.

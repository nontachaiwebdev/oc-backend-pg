# Users, roles and groups API

All paths are under `/api` and need `Authorization: Bearer <access_token>`.
Errors are `{ "error": string, "code": string }`. The modals can show `error` the same way they show `data.error` today.

Router: `usersRouter` from `src/modules/users.ts`.

## Call mapping

| Frontend source | Old Supabase call | New call | Access | Body | Response |
| --- | --- | --- | --- | --- | --- |
| `useUsers` | `from('profiles').select('*, user_roles!user_roles_user_id_fkey(role:roles(id,name,description))').order('created_at', desc)` | `GET /users` | Any signed-in user | | `200 UserWithRoles[]` |
| `useRoles` | `from('roles').select('*').order('name')` | `GET /roles` | Any signed-in user | | `200 Role[]` |
| `useFiles` (uploaders) | `from('profiles').select('id, full_name, email').in('id', ids)` | `GET /profiles?ids=<uuid>,<uuid>` | Any signed-in user | | `200 { id, full_name, email }[]` (1 to 200 ids) |
| `AuthContext` | `from('profiles')`, `from('user_roles')`, `from('role_permissions')` for the current user | `GET /auth/me` (auth router) | Signed-in user | | `200 { user, profile, permissions }` |
| `ProfilePage` | `from('profiles').update(...).eq('id', user.id)` | `PATCH /profiles/me` | Signed-in user | Any of `full_name`, `avatar_url`, `department`, `position` (string or null) | `200 Profile` |
| `EditUserModal` | `from('profiles').update(...).eq('id', user.id)` | `PATCH /users/:id` | `manage_users` | Any of `full_name`, `department`, `position`, `status` | `200 UserWithRoles` |
| `CreateUserModal` | `functions.invoke('create-user')` | `POST /users` | `manage_users` | `{ email, password, full_name?, department?, position? }` | `201 { user: { id, email }, message }` |
| `InviteUserModal` | `functions.invoke('invite-user')` | `POST /users/invite` | `manage_users` | `{ email, full_name?, department?, position? }` | `201 { user: { id, email }, email_sent, message }` |
| `DeleteUserModal` | `functions.invoke('delete-user', { user_id })` | `DELETE /users/:id` | `manage_users`, not yourself | | `200 { message }` |
| `ResetPasswordModal` | `functions.invoke('generate-recovery-link', { user_id })` | `POST /users/:id/recovery-link` | `manage_users` | | `200 { action_link, email }` (`Cache-Control: no-store`) |
| `RoleAssignmentModal` | `from('user_roles').insert(...)` and `.delete()` per role | `PUT /users/:id/roles` | `manage_users` | `{ role_ids: uuid[] }`, the full selected set | `200 UserWithRoles` |
| `useGroups.fetchGroups` | `from('groups').select('*, group_members(user:profiles!group_members_user_id_fkey(*))').order('name')` | `GET /groups` | Any signed-in user; `[]` without `manage_groups` | | `200 GroupWithMembers[]` |
| `useGroups.createGroup` | `from('groups').insert(...)`, then `from('group_members').insert(...)` | `POST /groups` | `manage_groups` | `{ name, description?, member_ids? }` | `201 GroupWithMembers` |
| `useGroups.updateGroup` | `from('groups').update(...).eq('id', id)` | `PATCH /groups/:id` | `manage_groups` | Any of `name`, `description` | `200 GroupWithMembers` |
| `useGroups.deleteGroup` | `from('groups').delete().eq('id', id)` | `DELETE /groups/:id` | `manage_groups` | | `204` |
| `useGroups.saveMembers` | `from('group_members').insert(...)` and `.delete()` per user | `PATCH /groups/:id/members` | `manage_groups` | `{ add?: uuid[], remove?: uuid[] }` | `200 GroupWithMembers` |

## Response shapes

```ts
UserWithRoles = Profile & { user_roles: { role: { id, name, description } }[] }
GroupWithMembers = Group & { group_members: { user: Profile }[] }
```

## Behavior notes

- `GET /groups` returns `200 []` without `manage_groups`, as RLS did. The activity and access pages load groups for users who may lack that permission.
- `PATCH /profiles/me` rejects `status`, `email` and every other field. RLS allowed users to change them on their own row.
- `PUT /users/:id/roles` returns 400 if you remove your own `super_admin`. This was previously enforced only in the UI.
- Role and group member changes are now atomic. A failure changes nothing.
- A duplicate email or group name returns 409. A nonexistent member id returns 409.
- `POST /users/invite`: if sending fails, the new account is removed and the call returns an error. When mail is not configured outside production, the account is kept and `email_sent` is `false`. Use a recovery link to give that user access.
- Roles and permissions have no write endpoints, because the frontend has no such calls.

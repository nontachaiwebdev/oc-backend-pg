-- view_chat reads every user's conversations, so only administrators may hold it.
DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND p.name = 'view_chat'
  AND r.name IN ('member', 'manager');

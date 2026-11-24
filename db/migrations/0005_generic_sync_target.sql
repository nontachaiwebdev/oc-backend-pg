-- A service serves one client, so the sync target is that deployment's name.
ALTER TABLE public.sync_logs DROP CONSTRAINT sync_logs_target_check;

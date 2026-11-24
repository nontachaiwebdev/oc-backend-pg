-- The API now runs its own nightly reindex.
ALTER TABLE public.sync_logs DROP CONSTRAINT sync_logs_trigger_check;
ALTER TABLE public.sync_logs ADD CONSTRAINT sync_logs_trigger_check
  CHECK ("trigger" = ANY (ARRAY['cli'::text, 'api'::text, 'schedule'::text]));
COMMENT ON COLUMN public.sync_logs."trigger" IS 'cli = reindex command, api = POST /api/reindex, schedule = nightly job';

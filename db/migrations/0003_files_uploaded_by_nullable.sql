-- The foreign key is ON DELETE SET NULL, so a NOT NULL column made it impossible
-- to delete any user who had uploaded a file.
ALTER TABLE public.files ALTER COLUMN uploaded_by DROP NOT NULL;

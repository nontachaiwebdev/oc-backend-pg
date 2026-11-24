-- Baseline generated from the live Supabase schema (identical in both projects).
-- Row-level security is replaced by authorization in the API.

-- Function bodies reference tables created later in this file.
SET LOCAL check_function_bodies = false;

CREATE EXTENSION IF NOT EXISTS vector;

-- Replaces Supabase auth.users. IDs and bcrypt hashes are preserved by the seed.
CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    email text NOT NULL,
    password_hash text,
    email_confirmed_at timestamptz,
    invited_at timestamptz,
    last_sign_in_at timestamptz,
    banned_until timestamptz,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX idx_users_email_lower ON public.users (lower(email));

CREATE TYPE public."activity_frequency" AS ENUM (
    'yearly',
    'quarterly',
    'monthly'
);

CREATE TYPE public."activity_instance_status" AS ENUM (
    'planned',
    'in_progress',
    'done',
    'overdue'
);

CREATE TYPE public."activity_visibility" AS ENUM (
    'all',
    'selected'
);

CREATE TYPE public."file_access_level" AS ENUM (
    'view',
    'manage'
);

CREATE TYPE public."user_status" AS ENUM (
    'active',
    'inactive',
    'suspended'
);

CREATE OR REPLACE FUNCTION public."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."prevent_activity_delete_with_history"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.activity_instances
    WHERE activity_id = OLD.id AND status = 'done'
  ) THEN
    RAISE EXCEPTION 'Activity % has signed-off occurrences and cannot be deleted; archive it instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public."prevent_activity_delete_with_history"() IS 'Blocks DELETE on an activity that has any signed-off occurrence, preserving the audit trail';

CREATE OR REPLACE FUNCTION public."user_has_permission"("p_user_id" "uuid", "p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p      ON p.id = rp.permission_id
    WHERE ur.user_id = p_user_id
      AND p.name = p_permission
  );
$$;

COMMENT ON FUNCTION public."user_has_permission"("p_user_id" "uuid", "p_permission" "text") IS 'Returns true if the given user holds the permission via any role. Service role only.';

CREATE TABLE IF NOT EXISTS public."activities" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "name" "text" NOT NULL,
    "type_id" "uuid" NOT NULL,
    "responsible_role" "text" NOT NULL,
    "document_ref" "text",
    "file_id" "uuid",
    "frequency" public."activity_frequency" DEFAULT 'yearly'::public."activity_frequency" NOT NULL,
    "recur_month" smallint,
    "recur_day" smallint NOT NULL,
    "requires_evidence" boolean DEFAULT false NOT NULL,
    "visibility" public."activity_visibility" DEFAULT 'all'::public."activity_visibility" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chk_activities_recur_day" CHECK ((("recur_day" >= 1) AND ("recur_day" <= 28))),
    CONSTRAINT "chk_activities_recurrence" CHECK (
CASE "frequency"
    WHEN 'yearly'::public."activity_frequency" THEN (("recur_month" IS NOT NULL) AND (("recur_month" >= 1) AND ("recur_month" <= 12)))
    WHEN 'quarterly'::public."activity_frequency" THEN (("recur_month" IS NOT NULL) AND (("recur_month" >= 1) AND ("recur_month" <= 3)))
    WHEN 'monthly'::public."activity_frequency" THEN ("recur_month" IS NULL)
    ELSE NULL::boolean
END)
);

COMMENT ON TABLE public."activities" IS 'Recurring activity definitions; the calendar derives occurrences from these';

COMMENT ON COLUMN public."activities"."responsible_role" IS 'Business label for who performs it ("Kundansvarig", "HR"). Free text on purpose -- unrelated to public.roles, which carries permissions.';

COMMENT ON COLUMN public."activities"."document_ref" IS 'Human-readable id of the governing document, e.g. OCA-K03-MAL. Kept even when file_id is set, since the ref is what staff quote.';

COMMENT ON COLUMN public."activities"."file_id" IS 'Optional link to the actual document in public.files';

COMMENT ON COLUMN public."activities"."recur_month" IS 'yearly: calendar month 1-12. quarterly: month WITHIN the quarter, 1-3 (1 = Jan/Apr/Jul/Oct). monthly: NULL.';

COMMENT ON COLUMN public."activities"."requires_evidence" IS 'Sign-off must carry a note or an attached file; marking it done is not enough';

COMMENT ON COLUMN public."activities"."is_active" IS 'false = arkiverad: no new occurrences are generated, but past sign-offs stay readable';

CREATE TABLE IF NOT EXISTS public."activity_instances" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "activity_id" "uuid" NOT NULL,
    "due_date" "date" NOT NULL,
    "status" public."activity_instance_status" DEFAULT 'in_progress'::public."activity_instance_status" NOT NULL,
    "completed_at" timestamp with time zone,
    "completed_by" "uuid",
    "completed_by_name" "text",
    "note" "text",
    "evidence_file_id" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chk_activity_instances_done" CHECK ((("status" = 'done'::public."activity_instance_status") = ("completed_at" IS NOT NULL)))
);

COMMENT ON TABLE public."activity_instances" IS 'Occurrences a user has acted on; absence of a row means nobody has touched that date yet';

COMMENT ON COLUMN public."activity_instances"."due_date" IS 'The occurrence this row belongs to. Fixed at sign-off: editing the activity''s recurrence later does not move existing history.';

COMMENT ON COLUMN public."activity_instances"."status" IS 'Only ''in_progress'' and ''done'' are stored. ''planned'' and ''overdue'' are derived at read time for occurrences with no row, so they must never be written here.';

COMMENT ON COLUMN public."activity_instances"."completed_by_name" IS 'Who signed off, captured as text at the time. completed_by goes NULL when the employee is deleted; an audit trail that cannot say who performed the check is worthless, so the name is snapshotted.';

COMMENT ON COLUMN public."activity_instances"."note" IS 'Free-text evidence; required together with evidence_file_id when the activity has requires_evidence';

CREATE TABLE IF NOT EXISTS public."activity_types" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chk_activity_types_color" CHECK (("color" ~ '^#[0-9A-Fa-f]{6}$'::"text"))
);

COMMENT ON TABLE public."activity_types" IS 'Categories an activity can belong to, with the colour used in the calendar';

COMMENT ON COLUMN public."activity_types"."code" IS 'Short letter shown on the calendar marker (U/A/P/D). A second, colour-blind-safe encoding of the category -- never rely on colour alone.';

COMMENT ON COLUMN public."activity_types"."color" IS 'Hex colour for the marker, #RRGGBB. Validated against colour blindness before being added.';

CREATE TABLE IF NOT EXISTS public."activity_visibility_grants" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "activity_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "group_id" "uuid",
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chk_activity_visibility_grants_subject" CHECK (("num_nonnulls"("user_id", "group_id") = 1))
);

COMMENT ON TABLE public."activity_visibility_grants" IS 'Which users or groups may see an activity whose visibility is ''selected''';

CREATE TABLE IF NOT EXISTS public."chat_message_feedback" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "message_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "rating" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chat_message_feedback_rating_check" CHECK (("rating" = ANY (ARRAY['like'::"text", 'dislike'::"text"])))
);

COMMENT ON TABLE public."chat_message_feedback" IS 'User feedback (like/dislike) on assistant messages';

COMMENT ON COLUMN public."chat_message_feedback"."rating" IS 'like or dislike';

CREATE TABLE IF NOT EXISTS public."chat_messages" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "sources" "jsonb",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chat_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);

COMMENT ON TABLE public."chat_messages" IS 'Individual messages within a chat session';

COMMENT ON COLUMN public."chat_messages"."sources" IS 'Source files/URLs returned by LLM (JSON array)';

CREATE TABLE IF NOT EXISTS public."chat_sessions" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" DEFAULT 'New Chat'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."chat_sessions" IS 'One row per chat conversation';

COMMENT ON COLUMN public."chat_sessions"."title" IS 'Auto-set from first user message, editable';

CREATE TABLE IF NOT EXISTS public."draft_documents" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "title" "text" DEFAULT 'Nytt dokument'::"text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "saved_file_id" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "source_file_id" "uuid"
);

COMMENT ON TABLE public."draft_documents" IS 'Documents drafted with the AI assistant';

COMMENT ON COLUMN public."draft_documents"."content" IS 'Current editor markdown';

COMMENT ON COLUMN public."draft_documents"."saved_file_id" IS 'Knowledge-base file this draft was saved as, if any';

COMMENT ON COLUMN public."draft_documents"."source_file_id" IS 'Knowledge-base file this draft was opened from (review), if any';

CREATE TABLE IF NOT EXISTS public."draft_edits" (
    "id" "uuid" NOT NULL,
    "session_id" "uuid" NOT NULL,
    "message_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "old_text" "text",
    "heading" "text",
    "new_text" "text" NOT NULL,
    "reason" "text" DEFAULT ''::"text" NOT NULL,
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "decided_by" "uuid",
    "decided_at" timestamp with time zone,
    "decision_reported" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "draft_edits_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'accepted'::"text", 'rejected'::"text"]))),
    CONSTRAINT "draft_edits_type_check" CHECK (("type" = ANY (ARRAY['replace'::"text", 'insert_after_heading'::"text", 'append'::"text"])))
);

COMMENT ON TABLE public."draft_edits" IS 'Edits suggested by the assistant; id is the editId sent to the client';

COMMENT ON COLUMN public."draft_edits"."message_id" IS 'Assistant message that proposed the edit';

COMMENT ON COLUMN public."draft_edits"."decision_reported" IS 'True once the accept/reject decision has been sent to the model';

CREATE TABLE IF NOT EXISTS public."draft_messages" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" DEFAULT ''::"text" NOT NULL,
    "document_snapshot" "text",
    "sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'complete'::"text" NOT NULL,
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "draft_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"]))),
    CONSTRAINT "draft_messages_status_check" CHECK (("status" = ANY (ARRAY['streaming'::"text", 'complete'::"text", 'failed'::"text", 'aborted'::"text"])))
);

COMMENT ON TABLE public."draft_messages" IS 'Messages within a draft chat session';

COMMENT ON COLUMN public."draft_messages"."document_snapshot" IS 'User messages: the document exactly as sent with this message';

COMMENT ON COLUMN public."draft_messages"."sources" IS 'Assistant messages: sources used (JSON array of {kind,title,url?,file?,reference?})';

COMMENT ON COLUMN public."draft_messages"."status" IS 'Assistant messages: streaming while running, then complete/failed/aborted';

CREATE TABLE IF NOT EXISTS public."draft_sessions" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "document_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text",
    "last_seen_document" "text",
    "active_turn_started_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "mode" "text" DEFAULT 'draft'::"text" NOT NULL,
    "attachments" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "draft_sessions_mode_check" CHECK (("mode" = ANY (ARRAY['draft'::"text", 'review'::"text"])))
);

COMMENT ON TABLE public."draft_sessions" IS 'Chat sessions on a draft document; a document can have several';

COMMENT ON COLUMN public."draft_sessions"."title" IS 'Auto-set from the first user message';

COMMENT ON COLUMN public."draft_sessions"."last_seen_document" IS 'Document as sent with the last completed turn; diffed to tell the model what changed';

COMMENT ON COLUMN public."draft_sessions"."active_turn_started_at" IS 'Set while a chat turn is running (lock); stale after 5 minutes';

COMMENT ON COLUMN public."draft_sessions"."mode" IS '''draft'' = write with the user; ''review'' = check the document against current law';

COMMENT ON COLUMN public."draft_sessions"."attachments" IS 'Read-only reference files sent with every turn: [{ fileId, name, content }]';

CREATE TABLE IF NOT EXISTS public."faq_items" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "section_id" "uuid" NOT NULL,
    "question" "text" NOT NULL,
    "answer" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."faq_items" IS 'Individual FAQ question-answer pairs';

CREATE TABLE IF NOT EXISTS public."faq_permissions" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "user_id" "uuid",
    "group_id" "uuid",
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "item_id" "uuid" NOT NULL,
    CONSTRAINT "chk_faq_permissions_subject" CHECK (("num_nonnulls"("user_id", "group_id") = 1))
);

COMMENT ON TABLE public."faq_permissions" IS 'Grants an FAQ question to a user or a user group (view only). Questions without grants are visible to no one but FAQ managers';

CREATE TABLE IF NOT EXISTS public."faq_sections" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "group_id" "uuid" DEFAULT '00000000-0000-0000-0000-000000000001'::"uuid" NOT NULL
);

COMMENT ON TABLE public."faq_sections" IS 'FAQ category/section groupings';

COMMENT ON COLUMN public."faq_sections"."group_id" IS 'Group (public.file_groups) this section is organised under; shared with knowledge-base files';

CREATE TABLE IF NOT EXISTS public."file_groups" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "name" "text" NOT NULL,
    "is_default" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "chk_file_groups_name_not_blank" CHECK (("btrim"("name") <> ''::"text"))
);

COMMENT ON TABLE public."file_groups" IS 'Named, separate trees of knowledge-base files; unrelated to public.groups (user groups)';

COMMENT ON COLUMN public."file_groups"."is_default" IS 'The "Main" group that pre-existing files live in. Renameable, so never look it up by name';

CREATE TABLE IF NOT EXISTS public."file_permissions" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "file_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "access_level" public."file_access_level" DEFAULT 'view'::public."file_access_level" NOT NULL,
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "group_id" "uuid",
    CONSTRAINT "chk_file_permissions_subject" CHECK (("num_nonnulls"("user_id", "group_id") = 1))
);

CREATE TABLE IF NOT EXISTS public."files" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "name" "text" NOT NULL,
    "is_directory" boolean DEFAULT false NOT NULL,
    "parent_id" "uuid",
    "storage_path" "text",
    "mime_type" "text",
    "size_bytes" bigint,
    "uploaded_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "group_id" "uuid" DEFAULT '00000000-0000-0000-0000-000000000001'::"uuid" NOT NULL,
    CONSTRAINT "chk_directory_no_storage" CHECK ((("is_directory" = false) OR (("storage_path" IS NULL) AND ("mime_type" IS NULL) AND ("size_bytes" IS NULL))))
);

COMMENT ON COLUMN public."files"."group_id" IS 'File group this entry belongs to; always equal to its parent''s group (files_parent_group_fkey)';

CREATE TABLE IF NOT EXISTS public."group_members" (
    "group_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."group_members" IS 'Assigns users to groups; a user can belong to multiple groups';

CREATE TABLE IF NOT EXISTS public."groups" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."groups" IS 'Named groups of users';

CREATE TABLE IF NOT EXISTS public."permissions" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."permissions" IS 'Granular permission definitions';

CREATE TABLE IF NOT EXISTS public."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "department" "text",
    "position" "text",
    "status" public."user_status" DEFAULT 'active'::public."user_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."profiles" IS 'Employee profiles linked 1:1 to public.users';

CREATE TABLE IF NOT EXISTS public."role_permissions" (
    "role_id" "uuid" NOT NULL,
    "permission_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."role_permissions" IS 'Maps permissions to roles';

CREATE TABLE IF NOT EXISTS public."roles" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."roles" IS 'Application roles';

COMMENT ON COLUMN public."roles"."is_system" IS 'System roles cannot be deleted by users';

CREATE TABLE IF NOT EXISTS public."sync_logs" (
    "id" "uuid" DEFAULT gen_random_uuid() NOT NULL,
    "target" "text" NOT NULL,
    "trigger" "text" NOT NULL,
    "directory_id" "uuid",
    "pinecone_index" "text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "files_found" integer,
    "files_downloaded" integer,
    "files_failed" integer,
    "chunks_indexed" integer,
    "error_message" "text",
    "details" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT now() NOT NULL,
    "finished_at" timestamp with time zone,
    "duration_ms" integer GENERATED ALWAYS AS (((EXTRACT(epoch FROM ("finished_at" - "started_at")) * (1000)::numeric))::integer) STORED,
    CONSTRAINT "sync_logs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'success'::"text", 'failed'::"text"]))),
    CONSTRAINT "sync_logs_target_check" CHECK (("target" = ANY (ARRAY['ledningssystem'::"text", 'boende'::"text"]))),
    CONSTRAINT "sync_logs_trigger_check" CHECK (("trigger" = ANY (ARRAY['cli'::"text", 'api'::"text"])))
);

COMMENT ON TABLE public."sync_logs" IS 'History of knowledge-base syncs (Supabase files -> Pinecone index)';

COMMENT ON COLUMN public."sync_logs"."target" IS 'Knowledge base that was synced';

COMMENT ON COLUMN public."sync_logs"."trigger" IS 'cli = npm run reindex:*, api = POST /<target>/reindex';

COMMENT ON COLUMN public."sync_logs"."directory_id" IS 'Directory the sync was scoped to; NULL = all files';

COMMENT ON COLUMN public."sync_logs"."status" IS 'running while in progress; a row stuck in running means the process died';

COMMENT ON COLUMN public."sync_logs"."files_found" IS '.docx rows found in public.files';

COMMENT ON COLUMN public."sync_logs"."files_failed" IS 'Files that could not be downloaded from Storage';

COMMENT ON COLUMN public."sync_logs"."details" IS 'Per-file results: [{file_id, name, status, chunks, error}]';

CREATE TABLE IF NOT EXISTS public."user_roles" (
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "assigned_by" "uuid",
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public."user_roles" IS 'Assigns roles to users; a user can hold multiple roles';

ALTER TABLE ONLY public."activities"
    ADD CONSTRAINT "activities_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."activity_instances"
    ADD CONSTRAINT "activity_instances_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."activity_types"
    ADD CONSTRAINT "activity_types_code_key" UNIQUE ("code");

ALTER TABLE ONLY public."activity_types"
    ADD CONSTRAINT "activity_types_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."activity_visibility_grants"
    ADD CONSTRAINT "activity_visibility_grants_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."chat_message_feedback"
    ADD CONSTRAINT "chat_message_feedback_message_id_user_id_key" UNIQUE ("message_id", "user_id");

ALTER TABLE ONLY public."chat_message_feedback"
    ADD CONSTRAINT "chat_message_feedback_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."chat_sessions"
    ADD CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."draft_documents"
    ADD CONSTRAINT "draft_documents_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."draft_edits"
    ADD CONSTRAINT "draft_edits_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."draft_messages"
    ADD CONSTRAINT "draft_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."draft_sessions"
    ADD CONSTRAINT "draft_sessions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."faq_items"
    ADD CONSTRAINT "faq_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."faq_permissions"
    ADD CONSTRAINT "faq_permissions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."faq_sections"
    ADD CONSTRAINT "faq_sections_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."file_groups"
    ADD CONSTRAINT "file_groups_name_key" UNIQUE ("name");

ALTER TABLE ONLY public."file_groups"
    ADD CONSTRAINT "file_groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."file_permissions"
    ADD CONSTRAINT "file_permissions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."files"
    ADD CONSTRAINT "files_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."group_members"
    ADD CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id", "user_id");

ALTER TABLE ONLY public."groups"
    ADD CONSTRAINT "groups_name_key" UNIQUE ("name");

ALTER TABLE ONLY public."groups"
    ADD CONSTRAINT "groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."permissions"
    ADD CONSTRAINT "permissions_name_key" UNIQUE ("name");

ALTER TABLE ONLY public."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id");

ALTER TABLE ONLY public."roles"
    ADD CONSTRAINT "roles_name_key" UNIQUE ("name");

ALTER TABLE ONLY public."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."sync_logs"
    ADD CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY public."activity_instances"
    ADD CONSTRAINT "uq_activity_instances_occurrence" UNIQUE ("activity_id", "due_date");

ALTER TABLE ONLY public."activity_visibility_grants"
    ADD CONSTRAINT "uq_activity_visibility_grants_subject" UNIQUE NULLS NOT DISTINCT ("activity_id", "user_id", "group_id");

ALTER TABLE ONLY public."faq_permissions"
    ADD CONSTRAINT "uq_faq_permissions_subject" UNIQUE NULLS NOT DISTINCT ("item_id", "user_id", "group_id");

ALTER TABLE ONLY public."file_permissions"
    ADD CONSTRAINT "uq_file_permissions_subject" UNIQUE NULLS NOT DISTINCT ("file_id", "user_id", "group_id");

ALTER TABLE ONLY public."files"
    ADD CONSTRAINT "uq_files_id_group" UNIQUE ("id", "group_id");

ALTER TABLE ONLY public."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role_id");

CREATE INDEX "idx_activities_is_active" ON public."activities" USING "btree" ("is_active");

CREATE INDEX "idx_activities_type_id" ON public."activities" USING "btree" ("type_id");

CREATE INDEX "idx_activity_instances_due_date" ON public."activity_instances" USING "btree" ("due_date");

CREATE INDEX "idx_activity_visibility_grants_group_id" ON public."activity_visibility_grants" USING "btree" ("group_id");

CREATE INDEX "idx_activity_visibility_grants_user_id" ON public."activity_visibility_grants" USING "btree" ("user_id");

CREATE INDEX "idx_chat_message_feedback_message" ON public."chat_message_feedback" USING "btree" ("message_id");

CREATE INDEX "idx_chat_message_feedback_rating" ON public."chat_message_feedback" USING "btree" ("rating");

CREATE INDEX "idx_chat_messages_session" ON public."chat_messages" USING "btree" ("session_id", "created_at");

CREATE INDEX "idx_chat_sessions_updated" ON public."chat_sessions" USING "btree" ("updated_at" DESC);

CREATE INDEX "idx_chat_sessions_user" ON public."chat_sessions" USING "btree" ("user_id");

CREATE INDEX "idx_draft_documents_owner" ON public."draft_documents" USING "btree" ("owner_id", "updated_at" DESC);

CREATE INDEX "idx_draft_edits_message" ON public."draft_edits" USING "btree" ("message_id");

CREATE INDEX "idx_draft_edits_session" ON public."draft_edits" USING "btree" ("session_id", "created_at");

CREATE INDEX "idx_draft_messages_session" ON public."draft_messages" USING "btree" ("session_id", "created_at");

CREATE INDEX "idx_draft_sessions_document" ON public."draft_sessions" USING "btree" ("document_id", "updated_at" DESC);

CREATE INDEX "idx_faq_items_active" ON public."faq_items" USING "btree" ("is_active");

CREATE INDEX "idx_faq_items_section" ON public."faq_items" USING "btree" ("section_id");

CREATE INDEX "idx_faq_items_sort" ON public."faq_items" USING "btree" ("section_id", "sort_order");

CREATE INDEX "idx_faq_permissions_group_id" ON public."faq_permissions" USING "btree" ("group_id");

CREATE INDEX "idx_faq_permissions_user_id" ON public."faq_permissions" USING "btree" ("user_id");

CREATE INDEX "idx_faq_sections_active" ON public."faq_sections" USING "btree" ("is_active");

CREATE INDEX "idx_faq_sections_group_sort" ON public."faq_sections" USING "btree" ("group_id", "sort_order");

CREATE INDEX "idx_faq_sections_sort" ON public."faq_sections" USING "btree" ("sort_order");

CREATE UNIQUE INDEX "idx_file_groups_single_default" ON public."file_groups" USING "btree" ("is_default") WHERE "is_default";

CREATE INDEX "idx_file_permissions_group_id" ON public."file_permissions" USING "btree" ("group_id");

CREATE INDEX "idx_file_permissions_user_id" ON public."file_permissions" USING "btree" ("user_id");

CREATE INDEX "idx_files_group_id" ON public."files" USING "btree" ("group_id");

CREATE INDEX "idx_files_parent_id" ON public."files" USING "btree" ("parent_id");

CREATE UNIQUE INDEX "idx_files_unique_name_in_parent" ON public."files" USING "btree" ("parent_id", "name") WHERE ("parent_id" IS NOT NULL);

CREATE UNIQUE INDEX "idx_files_unique_root_name_in_group" ON public."files" USING "btree" ("group_id", "name") WHERE ("parent_id" IS NULL);

CREATE INDEX "idx_files_uploaded_by" ON public."files" USING "btree" ("uploaded_by");

CREATE INDEX "idx_group_members_user" ON public."group_members" USING "btree" ("user_id");

CREATE INDEX "idx_permissions_category" ON public."permissions" USING "btree" ("category");

CREATE INDEX "idx_profiles_department" ON public."profiles" USING "btree" ("department");

CREATE INDEX "idx_profiles_email" ON public."profiles" USING "btree" ("email");

CREATE INDEX "idx_profiles_status" ON public."profiles" USING "btree" ("status");

CREATE INDEX "idx_role_permissions_permission" ON public."role_permissions" USING "btree" ("permission_id");

CREATE INDEX "idx_sync_logs_target_started" ON public."sync_logs" USING "btree" ("target", "started_at" DESC);

CREATE INDEX "idx_user_roles_role" ON public."user_roles" USING "btree" ("role_id");

CREATE OR REPLACE TRIGGER "prevent_activity_delete_with_history" BEFORE DELETE ON public."activities" FOR EACH ROW EXECUTE FUNCTION public."prevent_activity_delete_with_history"();

CREATE OR REPLACE TRIGGER "set_activities_updated_at" BEFORE UPDATE ON public."activities" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_activity_instances_updated_at" BEFORE UPDATE ON public."activity_instances" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_activity_types_updated_at" BEFORE UPDATE ON public."activity_types" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_chat_message_feedback_updated_at" BEFORE UPDATE ON public."chat_message_feedback" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_chat_sessions_updated_at" BEFORE UPDATE ON public."chat_sessions" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_draft_documents_updated_at" BEFORE UPDATE ON public."draft_documents" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_draft_sessions_updated_at" BEFORE UPDATE ON public."draft_sessions" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_faq_items_updated_at" BEFORE UPDATE ON public."faq_items" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_faq_sections_updated_at" BEFORE UPDATE ON public."faq_sections" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_file_groups_updated_at" BEFORE UPDATE ON public."file_groups" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_file_permissions_updated_at" BEFORE UPDATE ON public."file_permissions" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_files_updated_at" BEFORE UPDATE ON public."files" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_groups_updated_at" BEFORE UPDATE ON public."groups" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_profiles_updated_at" BEFORE UPDATE ON public."profiles" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

CREATE OR REPLACE TRIGGER "set_roles_updated_at" BEFORE UPDATE ON public."roles" FOR EACH ROW EXECUTE FUNCTION public."handle_updated_at"();

ALTER TABLE ONLY public."activities"
    ADD CONSTRAINT "activities_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."activities"
    ADD CONSTRAINT "activities_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES public."files"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."activities"
    ADD CONSTRAINT "activities_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES public."activity_types"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY public."activity_instances"
    ADD CONSTRAINT "activity_instances_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES public."activities"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."activity_instances"
    ADD CONSTRAINT "activity_instances_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."activity_instances"
    ADD CONSTRAINT "activity_instances_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES public."files"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."activity_visibility_grants"
    ADD CONSTRAINT "activity_visibility_grants_activity_id_fkey" FOREIGN KEY ("activity_id") REFERENCES public."activities"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."activity_visibility_grants"
    ADD CONSTRAINT "activity_visibility_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."activity_visibility_grants"
    ADD CONSTRAINT "activity_visibility_grants_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES public."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."activity_visibility_grants"
    ADD CONSTRAINT "activity_visibility_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."chat_message_feedback"
    ADD CONSTRAINT "chat_message_feedback_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES public."chat_messages"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."chat_message_feedback"
    ADD CONSTRAINT "chat_message_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."chat_messages"
    ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES public."chat_sessions"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."chat_sessions"
    ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."draft_documents"
    ADD CONSTRAINT "draft_documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES public."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."draft_documents"
    ADD CONSTRAINT "draft_documents_saved_file_id_fkey" FOREIGN KEY ("saved_file_id") REFERENCES public."files"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."draft_documents"
    ADD CONSTRAINT "draft_documents_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES public."files"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."draft_edits"
    ADD CONSTRAINT "draft_edits_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."draft_edits"
    ADD CONSTRAINT "draft_edits_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES public."draft_messages"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."draft_edits"
    ADD CONSTRAINT "draft_edits_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES public."draft_sessions"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."draft_messages"
    ADD CONSTRAINT "draft_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES public."draft_sessions"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."draft_sessions"
    ADD CONSTRAINT "draft_sessions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES public."draft_documents"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."draft_sessions"
    ADD CONSTRAINT "draft_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."faq_items"
    ADD CONSTRAINT "faq_items_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES public."faq_sections"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."faq_permissions"
    ADD CONSTRAINT "faq_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES public."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."faq_permissions"
    ADD CONSTRAINT "faq_permissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES public."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."faq_permissions"
    ADD CONSTRAINT "faq_permissions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES public."faq_items"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."faq_permissions"
    ADD CONSTRAINT "faq_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."faq_sections"
    ADD CONSTRAINT "faq_sections_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES public."file_groups"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY public."file_groups"
    ADD CONSTRAINT "file_groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."file_permissions"
    ADD CONSTRAINT "file_permissions_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES public."files"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."file_permissions"
    ADD CONSTRAINT "file_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES public."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."file_permissions"
    ADD CONSTRAINT "file_permissions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES public."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."file_permissions"
    ADD CONSTRAINT "file_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."files"
    ADD CONSTRAINT "files_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES public."file_groups"("id") ON DELETE RESTRICT;

ALTER TABLE ONLY public."files"
    ADD CONSTRAINT "files_parent_group_fkey" FOREIGN KEY ("parent_id", "group_id") REFERENCES public."files"("id", "group_id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public."files"
    ADD CONSTRAINT "files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES public."users"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."group_members"
    ADD CONSTRAINT "group_members_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."group_members"
    ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES public."groups"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."group_members"
    ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."profiles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."groups"
    ADD CONSTRAINT "groups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES public."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES public."permissions"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES public."roles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."user_roles"
    ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES public."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY public."user_roles"
    ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES public."roles"("id") ON DELETE CASCADE;

ALTER TABLE ONLY public."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."profiles"("id") ON DELETE CASCADE;

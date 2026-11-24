-- Single-use tokens for invite and password-recovery links.
CREATE TABLE public.auth_tokens (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('invite', 'recovery')),
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX idx_auth_tokens_user ON public.auth_tokens (user_id, type);

-- Rotating refresh tokens. Only the hash is stored.
CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    family_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX idx_refresh_tokens_user ON public.refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_family ON public.refresh_tokens (family_id);

-- RAG chunks, replacing Pinecone. Deleting a file removes its chunks.
CREATE TABLE public.document_chunks (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
    chunk_index integer NOT NULL,
    source text NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding vector(1536) NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    UNIQUE (file_id, chunk_index)
);
CREATE INDEX idx_document_chunks_source ON public.document_chunks (source);

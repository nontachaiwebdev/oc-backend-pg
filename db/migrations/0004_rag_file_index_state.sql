-- Per-file reindex state, so an interrupted or repeated run never pays to embed
-- unchanged content. Written in the same transaction as the file's chunks.
CREATE TABLE public.rag_file_index_state (
    file_id uuid PRIMARY KEY REFERENCES public.files(id) ON DELETE CASCADE,
    content_hash text NOT NULL,
    source text NOT NULL,
    pipeline_version integer NOT NULL,
    chunk_count integer NOT NULL,
    indexed_at timestamptz DEFAULT now() NOT NULL
);

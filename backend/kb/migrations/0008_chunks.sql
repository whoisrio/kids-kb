-- 检索期：chunks（向量化单元=条目）+ pgvector
CREATE TABLE chunks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id uuid NOT NULL UNIQUE REFERENCES items(id) ON DELETE CASCADE,
    document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_md text NOT NULL,
    meta jsonb NOT NULL DEFAULT '{}',
    embedding vector(1024) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

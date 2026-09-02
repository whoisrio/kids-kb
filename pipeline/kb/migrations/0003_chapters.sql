CREATE TABLE chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chapter_no INTEGER NOT NULL,
    title TEXT NOT NULL,
    print_page INTEGER,
    taxonomy TEXT,
    tags TEXT[],
    page_start INTEGER,
    page_end INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, chapter_no)
);

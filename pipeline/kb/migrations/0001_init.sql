CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    subject TEXT,
    grade TEXT,
    term TEXT,
    edition TEXT,
    doc_type TEXT NOT NULL DEFAULT 'workbook'
        CHECK (doc_type IN ('workbook', 'exam')),
    source_path TEXT NOT NULL UNIQUE,
    page_count INTEGER NOT NULL DEFAULT 0,
    has_text_layer BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'rendered', 'parsed', 'failed')),
    parse_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, page_no)
);

CREATE TABLE blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL
        CHECK (block_type IN ('page', 'text', 'formula', 'figure', 'table', 'header', 'footer')),
    bbox JSONB,
    crop_path TEXT NOT NULL,
    content_md TEXT,
    qc_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL
        CHECK (content_type IN ('example', 'exercise', 'answer')),
    label TEXT,
    content_md TEXT,
    paired_item_id UUID REFERENCES items(id),
    subject TEXT,
    grade TEXT,
    chapter TEXT,
    taxonomy TEXT,
    tags TEXT[],
    difficulty INTEGER,
    page_start INTEGER,
    page_end INTEGER,
    qc_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (qc_status IN ('pending', 'auto_passed', 'needs_review', 'approved', 'rejected')),
    qc_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE item_blocks (
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('stem', 'figure', 'solution')),
    PRIMARY KEY (item_id, block_id, role)
);

CREATE TABLE item_embeddings (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    embedding vector(1024)
);

CREATE TABLE review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    block_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

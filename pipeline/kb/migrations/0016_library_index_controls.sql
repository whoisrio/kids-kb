-- 资料库管理：显式区分自动审核/人工复核，支持页级排除与 chunk 溯源。
ALTER TABLE pages ADD COLUMN auto_review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (auto_review_status IN ('pending', 'passed', 'needs_review', 'failed'));
ALTER TABLE pages ADD COLUMN manual_review_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (manual_review_status IN ('unreviewed', 'approved', 'rejected'));
ALTER TABLE pages ADD COLUMN excluded_from_index BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pages ADD COLUMN index_error TEXT;

ALTER TABLE chapters ADD COLUMN auto_review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (auto_review_status IN ('pending', 'passed', 'needs_review', 'failed'));
ALTER TABLE chapters ADD COLUMN manual_review_status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (manual_review_status IN ('unreviewed', 'approved', 'rejected'));

UPDATE pages SET
    auto_review_status = CASE review_status
        WHEN 'auto_passed' THEN 'passed'
        WHEN 'approved' THEN 'passed'
        WHEN 'rejected' THEN 'failed'
        ELSE 'pending'
    END,
    manual_review_status = CASE review_status
        WHEN 'approved' THEN 'approved'
        WHEN 'rejected' THEN 'rejected'
        ELSE 'unreviewed'
    END;

UPDATE chapters SET
    auto_review_status = CASE review_status
        WHEN 'auto_passed' THEN 'passed'
        WHEN 'approved' THEN 'passed'
        WHEN 'rejected' THEN 'failed'
        ELSE 'pending'
    END,
    manual_review_status = CASE review_status
        WHEN 'approved' THEN 'approved'
        WHEN 'rejected' THEN 'rejected'
        ELSE 'unreviewed'
    END;

CREATE TABLE block_annotations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    author text NOT NULL DEFAULT 'admin',
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chunks ADD COLUMN source_block_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE chunks ADD COLUMN page_no integer;

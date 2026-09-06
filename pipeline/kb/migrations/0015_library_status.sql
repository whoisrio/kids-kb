-- 0015_library_status.sql：status 改名 + 新增审核/索引状态
ALTER TABLE documents RENAME COLUMN status TO parse_status;
ALTER TABLE pages RENAME COLUMN status TO parse_status;

ALTER TABLE documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE pages ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'auto_passed', 'approved', 'rejected'));
ALTER TABLE chapters ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'auto_passed', 'approved', 'rejected'));

ALTER TABLE pages ADD COLUMN index_status TEXT NOT NULL DEFAULT 'not_indexed'
    CHECK (index_status IN ('not_indexed', 'indexed', 'stale'));
ALTER TABLE chapters ADD COLUMN index_status TEXT NOT NULL DEFAULT 'not_indexed'
    CHECK (index_status IN ('not_indexed', 'indexed', 'stale'));

ALTER TABLE documents ADD COLUMN uploaded_by TEXT;

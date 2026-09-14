-- 0023_page_type.sql：页类型（content 正文 / toc 目录 / ad 广告 / cover 封面）。
-- 非内容页由 ingest 自动判定并置 excluded_from_index=true：页图/块原文保留，不参与向量化；
-- 人工可经 /internal/page-exclusion 恢复。
ALTER TABLE pages ADD COLUMN page_type TEXT NOT NULL DEFAULT 'content'
    CHECK (page_type IN ('content', 'toc', 'ad', 'cover'));

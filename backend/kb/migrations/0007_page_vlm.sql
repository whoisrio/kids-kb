-- 页级第二解析产物：远端整页 VLM 转录 + 人工选择采用版本
ALTER TABLE pages ADD COLUMN page_md text;
ALTER TABLE pages ADD COLUMN page_md_model text;
ALTER TABLE pages ADD COLUMN adopted_source text NOT NULL DEFAULT 'blocks'
    CHECK (adopted_source IN ('blocks', 'page_md'));

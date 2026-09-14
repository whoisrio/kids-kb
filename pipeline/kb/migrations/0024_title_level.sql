-- 0024_title_level.sql：标题层级（1/2/3），由 ingest 的 heading 阶段用本地模型判定。
-- NULL=未判定或非标题块（title/text 候选块判定后回写；其余块恒为 NULL）。
-- 一级标题用于无目录文档的章节合成（structure 的 heading 模式），层级也供整页稿
-- 呈现加 Markdown 标题前缀。
ALTER TABLE blocks ADD COLUMN title_level SMALLINT
    CHECK (title_level BETWEEN 1 AND 3);

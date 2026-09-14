-- 0025_struct_mode_heading.sql：structure 模式加 'heading'（无目录文档用一级标题合成章节）。
ALTER TABLE documents DROP CONSTRAINT documents_struct_mode_check;
ALTER TABLE documents ADD CONSTRAINT documents_struct_mode_check
    CHECK (struct_mode IN ('toc', 'flat', 'heading'));

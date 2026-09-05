-- 0014_documents_struct_mode.sql：structure 模式显式化（toc=按目录拆章拆条 / flat=整卷按页）
-- 可空：0014 之前入库的旧文档无值；重跑 structure 会补上
ALTER TABLE documents ADD COLUMN struct_mode text CHECK (struct_mode IN ('toc', 'flat'));

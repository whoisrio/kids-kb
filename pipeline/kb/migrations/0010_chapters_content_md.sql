-- docx 入库：章节原文（PDF 章节为 NULL）
ALTER TABLE chapters ADD COLUMN content_md TEXT;

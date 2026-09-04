-- 0013_chapter_chunks.sql:chunks 支持章节级向量(docx/md 未拆条内容的检索底座)
-- item_id 可空 + chapter_id/seg_no;条目向量与章节分段向量共存
ALTER TABLE chunks ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE chunks ADD COLUMN chapter_id UUID REFERENCES chapters(id) ON DELETE CASCADE;
ALTER TABLE chunks ADD COLUMN seg_no INTEGER;
-- Postgres UNIQUE 视 NULL 互不相等:既有 chunks_item_id_key 原样保留(多条章节行 item_id=NULL 不冲突)
CREATE UNIQUE INDEX chunks_chapter_seg_key ON chunks(chapter_id, seg_no) WHERE chapter_id IS NOT NULL;
-- 一行恰挂一个单元:条目(item_id)或章节分段(chapter_id+seg_no)
ALTER TABLE chunks ADD CONSTRAINT chunks_unit_ref CHECK (
  (item_id IS NOT NULL AND chapter_id IS NULL AND seg_no IS NULL)
  OR (item_id IS NULL AND chapter_id IS NOT NULL AND seg_no IS NOT NULL)
);
-- item_embeddings 自 0008(chunks)起无代码引用,清理死表
DROP TABLE IF EXISTS item_embeddings;

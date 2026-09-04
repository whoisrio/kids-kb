-- 0012_papers_attempts_unique.sql:同一 paper_question 至多一条 attempt(改判走 UPDATE)
-- 先清历史重复(同 paper_question_id 保留最新一条),再建唯一约束;存量库可安全重放
DELETE FROM attempts a USING attempts b
WHERE a.paper_question_id IS NOT NULL
  AND a.paper_question_id = b.paper_question_id
  AND a.created_at < b.created_at;

-- created_at 完全相同的重复行:保留 ctid 最小的一条(物理位置决胜,确定性去重)
DELETE FROM attempts a
WHERE a.paper_question_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM attempts b
              WHERE b.paper_question_id = a.paper_question_id
                AND b.created_at = a.created_at
                AND b.ctid < a.ctid);

CREATE UNIQUE INDEX attempts_paper_question_id_key ON attempts(paper_question_id);

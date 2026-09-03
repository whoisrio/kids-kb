-- 0011_papers.sql：试卷管线(papers/paper_questions)+ attempts 放宽 + llm_calls.paper_id
CREATE TABLE papers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    title text NOT NULL,
    subject text NOT NULL CHECK (subject IN ('语文', '数学', '英语', '其他')),
    source_path text NOT NULL DEFAULT '',
    page_count int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'ready_for_review', 'done', 'failed')),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE paper_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    page_no int NOT NULL,
    seq_in_page int NOT NULL,
    content_md text NOT NULL,
    answer_excerpt text,
    mark_desc text,
    recognized_result text CHECK (recognized_result IN ('correct', 'wrong', 'partial')),
    confirmed_result text CHECK (confirmed_result IN ('correct', 'wrong', 'partial')),
    error_cause text CHECK (error_cause IN ('粗心', '概念不清', '方法不会', '计算错')),
    note text,
    bbox jsonb,
    image_path text,
    matched_item_id uuid REFERENCES items(id) ON DELETE SET NULL,
    match_score real,
    matched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (paper_id, page_no, seq_in_page)
);
CREATE INDEX idx_paper_questions_paper ON paper_questions(paper_id);

-- attempts 放宽:试卷题来源入库(同一 paper_question 至多一条,改判 UPDATE)
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_item_id_check;
ALTER TABLE attempts ADD COLUMN paper_question_id uuid
    REFERENCES paper_questions(id) ON DELETE CASCADE;
ALTER TABLE attempts ADD CONSTRAINT attempts_source_check
    CHECK (item_id IS NOT NULL OR paper_question_id IS NOT NULL);

-- token 计量挂试卷
ALTER TABLE llm_calls ADD COLUMN paper_id uuid REFERENCES papers(id) ON DELETE SET NULL;

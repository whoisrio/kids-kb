-- 0021_quizzes.sql：薄弱点自动出题（quizzes/quiz_questions）+ attempts 第三种来源
CREATE TABLE quizzes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    title text NOT NULL,
    tags text[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'submitted')),
    created_at timestamptz NOT NULL DEFAULT now(),
    submitted_at timestamptz
);

CREATE TABLE quiz_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    seq int NOT NULL,
    type text NOT NULL CHECK (type IN ('single', 'multiple', 'short_answer')),
    question text NOT NULL,
    options jsonb,           -- [{value,label}]，short_answer 为 NULL
    answer text[],           -- 选择题正确值；short_answer 为 NULL
    analysis text,           -- 解析，判分后展示
    comment_prompt text,     -- 简答评分要点（rubric）
    points int NOT NULL DEFAULT 10,
    UNIQUE (quiz_id, seq)
);
CREATE INDEX idx_quiz_questions_quiz ON quiz_questions(quiz_id);
CREATE INDEX idx_quizzes_child ON quizzes(child_id);

-- attempts 放宽：AI 出题来源入库（item_id / paper_question_id / quiz_question_id 三选一）
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_source_check;
ALTER TABLE attempts ADD COLUMN quiz_question_id uuid
    REFERENCES quiz_questions(id) ON DELETE CASCADE;
ALTER TABLE attempts ADD CONSTRAINT attempts_source_check
    CHECK (item_id IS NOT NULL OR paper_question_id IS NOT NULL OR quiz_question_id IS NOT NULL);

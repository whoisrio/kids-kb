-- 孩子档案 + 做题记录（唯一事实表，追加式历史）
CREATE TABLE children (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    grade text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    item_id uuid REFERENCES items(id) ON DELETE CASCADE,
    result text NOT NULL CHECK (result IN ('correct', 'wrong', 'partial')),
    error_cause text CHECK (error_cause IN ('粗心', '概念不清', '方法不会', '计算错')),
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (item_id IS NOT NULL)  -- Phase 2 放宽：试卷题来源（paper_question_id）入库
);

-- token 计量区分文本/图像（试卷关联 paper_id 随 Phase 2 papers 表一起加）
ALTER TABLE llm_calls ADD COLUMN modality text CHECK (modality IN ('text', 'image'));

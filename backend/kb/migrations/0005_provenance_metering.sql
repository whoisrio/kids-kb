-- 解析来源（本地引擎/远端模型）+ 远端 token 消耗
ALTER TABLE blocks ADD COLUMN source_model text;
ALTER TABLE blocks ADD COLUMN prompt_tokens integer;
ALTER TABLE blocks ADD COLUMN completion_tokens integer;

-- 不锚定块的远端调用流水（目录解析/章节拆条/交叉校验）
CREATE TABLE llm_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
    purpose text NOT NULL,
    model text NOT NULL,
    prompt_tokens integer,
    completion_tokens integer
);

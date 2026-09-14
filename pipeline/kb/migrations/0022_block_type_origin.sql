-- 0022：block_type 血缘记账——layout 版面检测（默认）| vlm VLM 改判（parse 阶段确认整块是公式）
ALTER TABLE blocks ADD COLUMN block_type_origin TEXT NOT NULL DEFAULT 'layout';

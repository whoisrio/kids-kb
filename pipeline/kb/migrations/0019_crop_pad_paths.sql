-- 0019：裁图 padding 记账 + 图片路径基准统一到 KB_STORAGE_DIR（spec §5.3/§7.1）
-- 存量形态假设：KB_STORAGE_DIR 为默认相对值 storage（pipeline/.env 未覆盖）。
ALTER TABLE blocks ADD COLUMN crop_pad JSONB;  -- [dx, dy] 实际生效的外扩量（页图像素），NULL=无 padding
COMMENT ON COLUMN blocks.bbox IS '页图像素坐标 (x0,y0,x1,y1)，存检测/人工原始值，padding 只在裁图时加（见 crop_pad）';

-- pages：storage/<doc_id>/pages/... -> <doc_id>/pages/...
UPDATE pages SET image_path = substring(image_path from 9)
WHERE image_path LIKE 'storage/%';

-- blocks 形态一：storage/blocks/<page_id>/x.png -> <doc_id>/blocks/<page_id>/x.png
UPDATE blocks b SET crop_path = p.document_id::text || '/blocks/' || b.page_id::text
                                || '/' || split_part(b.crop_path, '/', 4)
FROM pages p
WHERE p.id = b.page_id AND b.crop_path LIKE 'storage/blocks/%';

-- blocks 其余（含整页块随页图、旧 fixture 形态 storage/<doc_id>/blocks/...）：仅去前缀
UPDATE blocks SET crop_path = substring(crop_path from 9)
WHERE crop_path LIKE 'storage/%';

-- paper_questions：相对形态去前缀 + 绝对形态（str(rel.resolve()) 存量）去掉 storage 之前所有前缀
UPDATE paper_questions SET image_path = substring(image_path from 9)
WHERE image_path LIKE 'storage/%';
UPDATE paper_questions SET image_path = regexp_replace(image_path, '^.*/storage/', '')
WHERE image_path LIKE '%/storage/%';

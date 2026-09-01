-- 页级复核行（版面问题/缺题等不锚定具体块）
ALTER TABLE review_queue ADD COLUMN page_id uuid REFERENCES pages(id) ON DELETE CASCADE;

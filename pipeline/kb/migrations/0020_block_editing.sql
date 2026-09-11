-- 0020：块编辑血缘/几何记账（spec §4/§6）+ chunks 失效状态（§6.4）
ALTER TABLE blocks ADD COLUMN origin TEXT NOT NULL DEFAULT 'layout';
  -- layout 版面检测 | manual 人工补画 | merged 合并生成 | split 拆分生成
ALTER TABLE blocks ADD COLUMN parent_block_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE blocks ADD COLUMN geometry_revision INTEGER NOT NULL DEFAULT 1;
  -- bbox 每次变更 +1；>1 表示几何被人动过，内容与版面检测输出不再等价

ALTER TABLE chunks ADD COLUMN state TEXT NOT NULL DEFAULT 'indexed';
  -- indexed | stale（源块变动待重建） | excluded（子系统 5 用）

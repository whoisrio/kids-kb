"""一次性数据迁移：storage/blocks/<page_id>/ -> storage/<doc_id>/blocks/<page_id>/。

配合 0019_crop_pad_paths.sql（先跑 migration 重写 DB 路径，再跑本脚本移文件）。
幂等：目标已存在跳过；storage/blocks 腾空后删除。
执行：cd pipeline && uv run python scripts/migrate_0019_blocks_dirs.py
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kb.core.config import load_config


def main() -> None:
    cfg = load_config()
    root = Path(cfg.storage_dir)
    legacy = root / "blocks"
    if not legacy.is_dir():
        print("无 storage/blocks/，无需迁移")
        return
    moved = skipped = 0
    with psycopg.connect(cfg.database_url, autocommit=True) as conn, conn.cursor() as cur:
        for page_dir in sorted(p for p in legacy.iterdir() if p.is_dir()):
            cur.execute("SELECT document_id::text FROM pages WHERE id::text=%s", (page_dir.name,))
            row = cur.fetchone()
            if not row:
                print(f"跳过 {page_dir.name}：pages 表无此 id（孤儿目录，人工核对）")
                skipped += 1
                continue
            target = root / row[0] / "blocks" / page_dir.name
            if target.exists():
                print(f"跳过 {page_dir.name}：目标已存在")
                skipped += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(page_dir), str(target))
            moved += 1
    try:
        legacy.rmdir()  # 仅在腾空时删除
    except OSError:
        print("storage/blocks/ 未腾空（有跳过项），保留")
    print(f"迁移 {moved} 个页块目录，跳过 {skipped} 个")


if __name__ == "__main__":
    main()

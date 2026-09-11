# 裁图 padding / clamp / 图片路径统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 裁图按物理毫米加 padding（text 0.8/0.5mm、figure 1.5/1.0mm）并做页边界+相邻块 clamp；`pages.image_path` / `blocks.crop_path` / `paper_questions.image_path` 统一为相对 `KB_STORAGE_DIR` 的路径，前后端解析基准随之钉死。

**Architecture:** 新增纯函数模块 `kb/ocr/pad.py`（padding 计算）与 `kb/core/paths.py`（路径基准换算）；migration `0019_crop_pad_paths.sql` 加 `blocks.crop_pad` 列 + bbox 单位注释 + 存量路径重写；blocks 裁图物理位置从 `storage/blocks/<page_id>/` 挪到 `storage/<doc_id>/blocks/<page_id>/`（配合一次性搬家脚本）；backend 提取共享 `resolveStoragePath`，`paperQuestions.ts` 不再绕过解析。

**Tech Stack:** Python 3.13 / pytest / psycopg / pymupdf；backend TS (Hono + vitest)。

**Spec:** `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §5、§7.1、§12 用例 3–5、§13（bbox 单位注释）。

**前置状态（phase 1 审核结论）：** 子系统 1 已实现且 234 测试全绿，与计划高度一致。审核发现一处实质缺口（`_LABEL_MAP` 未覆盖 V3 全部标签）与一处 spec 口径漂移（空输出兜底），并入本计划 Task 1 修补；验收 19/20（慢测试 + 黄金集回归）未实证，并入 Task 9 收尾。

**锁定决策（执行者不要改动，有异议先回报）：**

1. 路径基准 = `KB_STORAGE_DIR`（即 `pipeline/storage/`）。DB 新存形态：
   - `pages.image_path` → `<doc_id>/pages/pNNNN.png`
   - `blocks.crop_path` → `<doc_id>/blocks/<page_id>/bNNN.png`
   - `paper_questions.image_path` → `papers/<paper_id>/questions/pNNNN_qNN.png`
   - `papers.source_path` / `documents.source_path` **保持绝对路径不动**（幂等键/加工产物，不参与呈现）。
2. `blocks.crop_pad` 记 `[dx, dy]`（页图像素）：dx = 水平外扩；dy = 上下两侧邻居 clamp 后的**较小值**；页边界 clamp 不回写（那是物理限制不是"加了多少"）。
3. 非 `figure` 块一律按 text 档 padding（spec §5.2 只定义两档）；题图（paper_pipeline）按 text 档。
4. 邻居 = 同页阅读序（ordinal/模型输出序）相邻的前/后块，只 clamp 垂直方向：`pad_top = min(pad_v, gap_to_prev / 2)`，gap 为负（块重叠）时夹到 0。
5. 存量迁移假设 dev 环境 `KB_STORAGE_DIR` 为默认相对值 `storage`（`pipeline/.env` 未覆盖该键）；migration 只处理 `'storage/%'` 相对形态与 paper_questions 的 `%/storage/%` 绝对形态，其他形态报错人工核对。

---

### Task 1: phase 1 审核修补——`_LABEL_MAP` 补 V3 标签 + spec 口径修正

**Files:**
- Modify: `pipeline/kb/ocr/layout.py:22-43`（`_LABEL_MAP`）
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md`（§3.1 空输出口径）
- Test: `pipeline/tests/test_layout_paddleocr.py`

背景：PP-DocLayoutV3 的 `inference.yml` `label_list` 共 25 个标签（V2 同），当前 `_LABEL_MAP` 缺 8 个：`abstract, algorithm, aside_text, content, formula_number, reference, reference_content, vertical_text`，会静默归 text。spec §3.1 要求按 V3 实际标签集核对补齐。另有 `figure/formula/title` 三个非 V3 遗留键，无害保留（兼容 V2 老输出与手造数据）。

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_layout_paddleocr.py` 末尾追加：

```python
def test_label_map_covers_doclayout_v3_labelset():
    """_LABEL_MAP 显式覆盖 PP-DocLayoutV3 全部 25 个标签（spec §3.1，审核缺口）。"""
    from kb.ocr.layout import _LABEL_MAP

    v3_labels = {
        "abstract", "algorithm", "aside_text", "chart", "content",
        "display_formula", "doc_title", "figure_title", "footer",
        "footer_image", "footnote", "formula_number", "header",
        "header_image", "image", "inline_formula", "number",
        "paragraph_title", "reference", "reference_content", "seal",
        "table", "text", "vertical_text", "vision_footnote",
    }
    missing = v3_labels - set(_LABEL_MAP)
    assert not missing, f"V3 标签无显式映射（会静默归 text）: {missing}"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_layout_paddleocr.py::test_label_map_covers_doclayout_v3_labelset -v
```

预期：FAIL，missing 含上述 8 个标签。

- [ ] **Step 3: 补映射**

`pipeline/kb/ocr/layout.py` 的 `_LABEL_MAP` 末尾（`"text": "text",` 一行之前）追加，并给整个 dict 加注释标明来源：

```python
# 标签集来源：~/.paddlex/official_models/PP-DocLayoutV3/inference.yml 的 label_list（V2 同为这 25 个）
_LABEL_MAP = {
    # ... 现有键保持不动 ...
    # V3 有而此前未映射的 8 个：内容不能丢，全部显式归 text
    "abstract": "text",
    "algorithm": "text",
    "aside_text": "text",
    "content": "text",
    "formula_number": "text",
    "reference": "text",
    "reference_content": "text",
    "vertical_text": "text",
    "text": "text",
}
```

- [ ] **Step 4: 修 spec 口径（空输出）**

spec §3.1 倒数第二条 bullet 末尾「仅在模型输出缺失/为空时退回 y/x 兜底」改为「模型输出为空时不产生块（与 y/x 兜底行为等价，不保留死代码）」。同文件 §12 用例 18 的「模型输出为空时退回 y/x 兜底」同步改为「模型输出为空时不产生块」。

同时更新 §14 状态表：子系统 1 行状态改为「已实现（本计划 Task 1 修补 _LABEL_MAP；验收 19/20 随计划二 Task 9 收尾）」；子系统 2 行状态改为「**已出计划**：`docs/superpowers/plans/2026-09-09-crop-padding-path-unification.md`，未执行」。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_layout_paddleocr.py -v
```

预期：全 PASS。

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/ocr/layout.py pipeline/tests/test_layout_paddleocr.py docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "fix(pipeline): _LABEL_MAP 补齐 PP-DocLayoutV3 全部 25 标签（8 个新增显式归 text）；spec 空输出口径对齐实现"
```

---

### Task 2: migration 0019——crop_pad 列 + bbox 注释 + 存量路径重写 + 搬家脚本

**Files:**
- Create: `pipeline/kb/migrations/0019_crop_pad_paths.sql`
- Create: `pipeline/scripts/migrate_0019_blocks_dirs.py`
- Test: `pipeline/tests/test_migration_0019.py`

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_migration_0019.py`：

```python
"""0019：crop_pad 列 + 存量路径重写到 KB_STORAGE_DIR 相对基准。"""
from kb.core.db import MIGRATIONS_DIR


def _apply_before(clean_db, stop_name: str) -> None:
    """按文件名顺序手工应用 0019 之前的全部 migration（不经 schema_migrations 记账）。"""
    with clean_db.cursor() as cur:
        for p in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if p.name >= stop_name:
                break
            cur.execute(p.read_text(encoding="utf-8"))


def test_0019_rewrites_legacy_paths(clean_db):
    _apply_before(clean_db, "0019_crop_pad_paths.sql")
    with clean_db.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/a.pdf') RETURNING id::text"
        )
        doc_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO pages (document_id, page_no, image_path)"
            " VALUES (%s, 1, 'storage/' || %s || '/pages/p0001.png') RETURNING id::text",
            (doc_id, doc_id),
        )
        page_id = cur.fetchone()[0]
        # 形态一：layout.py 旧产物 storage/blocks/<page_id>/b000.png
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal)"
            " VALUES (%s, 'text', 'storage/blocks/' || %s || '/b000.png', 1)",
            (page_id, page_id),
        )
        # 形态二：旧 fixture 形态 storage/<doc_id>/blocks/b1.png
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal)"
            " VALUES (%s, 'text', 'storage/' || %s || '/blocks/b1.png', 2)",
            (page_id, doc_id),
        )
        cur.execute("INSERT INTO children (name) VALUES ('试') RETURNING id::text")
        child_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO papers (child_id, title, subject) VALUES (%s, '卷', '数学') RETURNING id::text",
            (child_id,),
        )
        paper_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, image_path)"
            " VALUES (%s, 1, 1, 'q', '/Users/x/pipeline/storage/papers/' || %s || '/questions/p0001_q01.png')",
            (paper_id, paper_id),
        )
        cur.execute((MIGRATIONS_DIR / "0019_crop_pad_paths.sql").read_text(encoding="utf-8"))

        cur.execute("SELECT image_path FROM pages WHERE id=%s", (page_id,))
        assert cur.fetchone()[0] == f"{doc_id}/pages/p0001.png"
        cur.execute("SELECT crop_path FROM blocks WHERE page_id=%s ORDER BY ordinal", (page_id,))
        crops = [r[0] for r in cur.fetchall()]
        assert crops[0] == f"{doc_id}/blocks/{page_id}/b000.png"  # 拼上 doc_id 前缀
        assert crops[1] == f"{doc_id}/blocks/b1.png"              # 仅去 storage/ 前缀
        cur.execute("SELECT image_path FROM paper_questions WHERE paper_id=%s", (paper_id,))
        assert cur.fetchone()[0] == f"papers/{paper_id}/questions/p0001_q01.png"
        # crop_pad 列存在、存量默认 NULL
        cur.execute("SELECT crop_pad FROM blocks WHERE page_id=%s LIMIT 1", (page_id,))
        assert cur.fetchone()[0] is None
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_migration_0019.py -v
```

预期：FAIL，`column "crop_pad" does not exist` 或路径断言不成立。

- [ ] **Step 3: 写 migration**

新建 `pipeline/kb/migrations/0019_crop_pad_paths.sql`：

```sql
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
```

- [ ] **Step 4: 写搬家脚本**

新建 `pipeline/scripts/migrate_0019_blocks_dirs.py`：

```python
"""一次性数据迁移：storage/blocks/<page_id>/ -> storage/<doc_id>/blocks/<page_id>/。

配合 0019_crop_pad_paths.sql（先跑 migration 重写 DB 路径，再跑本脚本移文件）。
幂等：目标已存在跳过；storage/blocks 腾空后删除。执行：cd pipeline && uv run python scripts/migrate_0019_blocks_dirs.py
"""
from __future__ import annotations

import shutil
from pathlib import Path

import psycopg

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
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_migration_0019.py tests/test_db.py -v
```

预期：全 PASS（`test_db.py` 的 conn fixture 跑全量 migration，顺带验证 0019 在干净库上可应用）。

- [ ] **Step 6: 应用到 dev 库并搬家**

```bash
cd pipeline && uv run python -c "from kb.core.config import load_config; from kb.core.db import connect, migrate; cfg = load_config(); print(migrate(connect(cfg.database_url)))"
cd pipeline && uv run python scripts/migrate_0019_blocks_dirs.py
```

预期：第一条输出含 `0019_crop_pad_paths.sql`；第二条输出迁移/跳过计数。注意：migration 与脚本之间图片暂时 404，两步连着跑，中间不要用产品。

- [ ] **Step 7: Commit**

```bash
git add pipeline/kb/migrations/0019_crop_pad_paths.sql pipeline/scripts/migrate_0019_blocks_dirs.py pipeline/tests/test_migration_0019.py
git commit -m "feat(pipeline): migration 0019——blocks.crop_pad + bbox 单位注释 + 图片路径基准统一 KB_STORAGE_DIR（含 blocks 目录搬家脚本）"
```

---

### Task 3: `kb/core/paths.py` 路径基准 helper + render.py 相对化 + 读取侧切换

**Files:**
- Create: `pipeline/kb/core/paths.py`
- Modify: `pipeline/kb/ocr/render.py:60-70`
- Modify: `pipeline/kb/ocr/pagelvl.py:31`、`pipeline/kb/ocr/parse.py:132`、`pipeline/kb/ocr/toc.py:105`、`pipeline/kb/ocr/qc.py:146-156`、`pipeline/kb/ocr/golden.py:83`、`pipeline/kb/ocr/crosscheck.py:47`
- Test: `pipeline/tests/test_paths.py`（新建）、`pipeline/tests/test_render.py`

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_paths.py`：

```python
"""路径基准：DB 存相对 KB_STORAGE_DIR，读取侧解析回文件系统路径。"""
from pathlib import Path

from kb.core.config import Config
from kb.core.paths import resolve_storage_path, storage_rel


def _cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


def test_resolve_storage_path_relative(tmp_path):
    cfg = _cfg(tmp_path)
    assert resolve_storage_path(cfg, "abc/pages/p0001.png") == tmp_path / "storage" / "abc/pages/p0001.png"


def test_resolve_storage_path_absolute_passthrough(tmp_path):
    cfg = _cfg(tmp_path)
    assert resolve_storage_path(cfg, "/abs/x.png") == Path("/abs/x.png")


def test_storage_rel_roundtrip(tmp_path):
    cfg = _cfg(tmp_path)
    abs_p = tmp_path / "storage" / "abc" / "blocks" / "p1" / "b000.png"
    assert storage_rel(cfg, abs_p) == "abc/blocks/p1/b000.png"
    assert resolve_storage_path(cfg, storage_rel(cfg, abs_p)) == abs_p
```

`pipeline/tests/test_render.py:56` 的断言从 `(cfg.storage_dir.parent / img)` 改为 `(cfg.storage_dir / img)`，并加一条断言新存形态：

```python
        assert img == f"{doc_id}/pages/p{pno:04d}.png"
```

（按该测试现有变量名调整；核心是断言 DB 值不再带 `storage/` 前缀。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_paths.py tests/test_render.py -v
```

预期：FAIL（`ModuleNotFoundError: kb.core.paths`；render 断言仍带前缀）。

- [ ] **Step 3: 实现 helper + render.py**

新建 `pipeline/kb/core/paths.py`：

```python
"""图片路径基准：DB 一律存相对 KB_STORAGE_DIR 的 POSIX 相对路径（spec §7.1）。

绝对路径原样透传（兼容 documents.source_path / papers.source_path 与历史数据）。
"""
from __future__ import annotations

from pathlib import Path


def resolve_storage_path(cfg, p: str) -> Path:
    """DB 路径 -> 文件系统路径。相对者以 storage_dir 为基准。"""
    path = Path(p)
    return path if path.is_absolute() else Path(cfg.storage_dir) / path


def storage_rel(cfg, p) -> str:
    """文件系统路径 -> 落库形态（相对 storage_dir 的 POSIX 字符串）。"""
    return Path(p).resolve().relative_to(Path(cfg.storage_dir).resolve()).as_posix()
```

`pipeline/kb/ocr/render.py`：第 60 行后，入库值改为相对形态：

```python
            img_abs = pages_dir / f"p{page_no:04d}.png"
            img_rel = img_abs.relative_to(cfg.storage_dir).as_posix()
            if page_no not in done:
                pix = doc[i].get_pixmap(dpi=cfg.dpi)
                pix.save(str(img_abs))
                cur.execute(
                    """INSERT INTO pages (document_id, page_no, image_path, parse_status)
                       VALUES (%s,%s,%s,'rendered')
                       ON CONFLICT (document_id, page_no)
                       DO UPDATE SET image_path=EXCLUDED.image_path, parse_status='rendered'""",
                    (doc_id, page_no, img_rel),
                )
```

（原 `img_rel = str(pages_dir / ...)` 一行删除；`pix.save(img_rel)` 改为 `pix.save(str(img_abs))`。）

- [ ] **Step 4: 读取侧 6 处切换**

模式统一：从 DB 取出后立刻过 `resolve_storage_path`，再传给文件读取。

- `pipeline/kb/ocr/pagelvl.py:31` 之后加一行：`image_path = str(resolve_storage_path(cfg, image_path))`（顶部 import `from kb.core.paths import resolve_storage_path`）。
- `pipeline/kb/ocr/parse.py` 的 `run_parse` 循环内（:132）`for block_id, crop_path, page_id, block_type in rows:` 之后加一行：`crop_path = str(resolve_storage_path(cfg, crop_path))`。
- `pipeline/kb/ocr/toc.py:105` 取出 `image_path` 后同样过一道（按该函数现有变量名接入）。
- `pipeline/kb/ocr/qc.py:150` 循环内 `image_path = str(resolve_storage_path(cfg, image_path))`。
- `pipeline/kb/ocr/golden.py:83` 取出后同样过一道。
- `pipeline/kb/ocr/crosscheck.py:47` 循环内 `crop_path = str(resolve_storage_path(cfg, crop_path))`。

- [ ] **Step 5: 跑全量 pipeline 测试**

```bash
cd pipeline && uv run pytest tests/ -q
```

预期：全 PASS。若有测试因 fixture 插了 `storage/...` 相对路径并断言 fake ocr/VLM 收到的实参字符串而失败，把该 fixture 改为新基准形态（去 `storage/` 前缀并让 helper 拼出同一绝对路径），不改回 CWD 相对语义。

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/core/paths.py pipeline/kb/ocr/render.py pipeline/kb/ocr/pagelvl.py pipeline/kb/ocr/parse.py pipeline/kb/ocr/toc.py pipeline/kb/ocr/qc.py pipeline/kb/ocr/golden.py pipeline/kb/ocr/crosscheck.py pipeline/tests/test_paths.py pipeline/tests/test_render.py
git commit -m "feat(pipeline): 图片路径基准统一 KB_STORAGE_DIR——paths helper + render 相对化 + 读取侧 6 处解析"
```

---

### Task 4: `kb/ocr/pad.py` padding 纯函数

**Files:**
- Create: `pipeline/kb/ocr/pad.py`
- Test: `pipeline/tests/test_pad.py`

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_pad.py`：

```python
"""裁图 padding：物理毫米定义（spec §5.2），页边界 + 相邻块 clamp（§5.3）。

A4@200dpi 基准值（spec 表）：text 6px 横/4px 纵，figure 12px 横/8px 纵。
"""
from kb.ocr.pad import mm_to_px, padded_px_bbox, pad_mm_for

A4_200 = (1654, 2339)  # 页图像素


def test_pad_mm_for():
    assert pad_mm_for("figure") == (1.5, 1.0)
    assert pad_mm_for("text") == (0.8, 0.5)
    assert pad_mm_for("table") == (0.8, 0.5)   # 未列出类型按 text 档


def test_mm_to_px():
    assert mm_to_px(0.8, 200) == 6
    assert mm_to_px(1.5, 200) == 12
    assert mm_to_px(1.0, 200) == 8


def test_padded_no_neighbors():
    bbox, pad = padded_px_bbox((100, 210, 500, 500), "figure", 200, A4_200)
    assert bbox == (88, 202, 512, 508)
    assert pad == [12, 8]


def test_padded_neighbor_clamp():
    """与上块 gap=10 → pad_top=min(8,5)=5；与下块 gap=14 → pad_bottom=min(8,7)=7；dy 记较小侧。"""
    prev = (100, 100, 500, 200)
    nxt = (100, 514, 500, 600)
    bbox, pad = padded_px_bbox((100, 210, 500, 500), "figure", 200, A4_200,
                               prev_bbox=prev, next_bbox=nxt)
    assert bbox == (88, 205, 512, 507)
    assert pad == [12, 5]


def test_padded_overlapping_neighbor_clamps_to_zero():
    """块重叠（gap 为负）时外扩夹到 0，不反向内缩。"""
    prev = (100, 100, 500, 220)  # 与 (100,210,...) 重叠 10px
    bbox, pad = padded_px_bbox((100, 210, 500, 500), "text", 200, A4_200, prev_bbox=prev)
    assert bbox[1] == 210
    assert pad == [6, 0]


def test_padded_page_bounds_clamp():
    """贴页边的块外扩被页边界裁掉，bbox 不出页。"""
    bbox, _pad = padded_px_bbox((0, 0, 100, 100), "figure", 200, A4_200)
    assert bbox == (0, 0, 112, 108)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_pad.py -v
```

预期：FAIL，`ModuleNotFoundError`。

- [ ] **Step 3: 实现**

新建 `pipeline/kb/ocr/pad.py`：

```python
"""裁图外扩（padding）：按物理毫米定义（spec §5.2），页边界 + 相邻块 clamp（§5.3）。

bbox 存库一律是原始值，padding 只在裁图时加，实际生效量记 blocks.crop_pad。
dy 取上下两侧 clamp 后的较小值（邻居夹紧时两侧可不等）。
"""
from __future__ import annotations

# (水平 mm, 垂直 mm)；纵向比横向保守——块间距在纵向更小
PAD_MM = {"figure": (1.5, 1.0)}
_DEFAULT_PAD_MM = (0.8, 0.5)  # text 及未列出类型


def pad_mm_for(block_type: str) -> tuple[float, float]:
    return PAD_MM.get(block_type, _DEFAULT_PAD_MM)


def mm_to_px(mm: float, dpi: int) -> int:
    return round(mm / 25.4 * dpi)


def padded_px_bbox(
    bbox: tuple[float, float, float, float],
    block_type: str,
    dpi: int,
    page_size: tuple[int, int],
    prev_bbox: tuple[float, float, float, float] | None = None,
    next_bbox: tuple[float, float, float, float] | None = None,
) -> tuple[tuple[float, float, float, float], list[int]]:
    """页图像素坐标。prev/next 为同页阅读序相邻块的原始 bbox。
    返回 (外扩并 clamp 后的 bbox, [dx, dy] 实际生效外扩量)。"""
    pad_h_mm, pad_v_mm = pad_mm_for(block_type)
    dx = mm_to_px(pad_h_mm, dpi)
    top = bottom = mm_to_px(pad_v_mm, dpi)
    x0, y0, x1, y1 = bbox
    if prev_bbox is not None:
        top = max(0, min(top, int((y0 - prev_bbox[3]) / 2)))
    if next_bbox is not None:
        bottom = max(0, min(bottom, int((next_bbox[1] - y1) / 2)))
    w, h = page_size
    padded = (max(0.0, x0 - dx), max(0.0, y0 - top),
              min(float(w), x1 + dx), min(float(h), y1 + bottom))
    return padded, [dx, min(top, bottom)]
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_pad.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/pad.py pipeline/tests/test_pad.py
git commit -m "feat(pipeline): pad.py 裁图外扩纯函数（毫米定义 + 邻居/页边界 clamp，spec §5）"
```

---

### Task 5: layout.py 接入 padding + blocks 目录挪到 doc 下 + crop_pad 落库

**Files:**
- Modify: `pipeline/kb/ocr/layout.py`
- Modify: `pipeline/kb/pdf_ingest.py:29`
- Test: `pipeline/tests/test_layout_paddleocr.py`、`pipeline/tests/test_layout.py`

设计要点（执行者照此实现，不要自由发挥）：

- `BlockDraft` 末尾加 `crop_pad: list[int] | None = None`。
- `PaddleOCRLayout.__init__` 加 `dpi: int = 200`，存 `self._dpi`；`blocks_dir` 参数保留（现在接收**含 doc_id 的**目录）。
- `analyze()`：先用 `fitz.Pixmap(image_path)` 取页图像素尺寸；raw bbox 列表按模型顺序作为彼此的 prev/next 邻居；每块 `padded_px_bbox` 算外扩框，`crop_image` 裁外扩框，`bbox` 仍存原始值，`crop_pad=pad`。
- `run_layout` 加 keyword 参数 `cfg=None`：cfg 非 None 时——`image_path` 先过 `resolve_storage_path` 再喂 analyzer；`draft.crop_path` 过 `storage_rel` 再落库；INSERT 加 `crop_pad` 列。cfg=None 保持旧行为（现有测试不动）。
- `make_layout_analyzer(cfg, doc_id=None)`：doc_id 传入时 `blocks_dir = cfg.storage_dir / doc_id / "blocks"`，否则维持旧的 `cfg.storage_dir / "blocks"`；透传 `dpi=cfg.dpi`。
- `pdf_ingest.py:29` 改为 `run_layout(conn, doc_id, analyzer=make_layout_analyzer(cfg, doc_id), cfg=cfg)`。

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_layout_paddleocr.py` 追加（文件里已有 `_write_test_page` 与 FakePipeline 模式可参照；页图用 fitz 真渲染一张 A4@200dpi 空白 PNG）：

```python
def _write_blank_a4_png(path):
    import pymupdf as fitz

    d = fitz.open()
    d.new_page(width=595, height=842)  # A4 pt
    d[0].get_pixmap(dpi=200).save(str(path))  # 1654x2339


def test_analyze_applies_padding_with_neighbor_clamp(tmp_path):
    """figure 块 12/8px padding，邻居 gap 夹紧垂直外扩；bbox 存原始值（验收 3）。"""
    from kb.ocr.layout import PaddleOCRLayout

    class _FakeOutput:
        json = {"res": {"boxes": [
            {"label": "text", "coordinate": [100, 100, 500, 200]},
            {"label": "figure", "coordinate": [100, 210, 500, 500]},
            {"label": "text", "coordinate": [100, 514, 500, 600]},
        ]}}

    class FakePipeline:
        def predict(self, _path):
            return [_FakeOutput()]

    src = tmp_path / "p1.png"
    _write_blank_a4_png(src)
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks", pipeline=FakePipeline())
    drafts = layout.analyze("p1", str(src))

    assert drafts[0].crop_pad == [6, 4]            # text，下邻 gap=10 → bottom=min(4,5)=4
    assert drafts[1].crop_pad == [12, 5]           # figure，上 gap=10 → 5，下 gap=14 → 7，记较小侧
    assert list(drafts[1].bbox) == [100.0, 210.0, 500.0, 500.0]  # bbox 存原始值
    # 裁图尺寸 = 原始框 + 实际外扩：宽 400+2*12，高 290+5+7
    import pymupdf as fitz
    pix = fitz.Pixmap(drafts[1].crop_path)
    assert (pix.width, pix.height) == (424, 302)
```

`pipeline/tests/test_layout.py` 追加：

```python
def test_run_layout_with_cfg_writes_relative_paths(doc_id, conn):
    """cfg 传入时：crop_path 落库为 <doc_id>/blocks/... 相对形态（spec §7.1）。"""
    from kb.ocr.layout import BlockDraft

    _id, cfg = doc_id

    class FakeOne:
        def analyze(self, page_id, image_path):
            out = cfg.storage_dir / _id / "blocks" / page_id / "b000.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"png")
            return [BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1),
                               crop_path=str(out), ordinal=1, crop_pad=[6, 4])]

    assert run_layout(conn, _id, analyzer=FakeOne(), cfg=cfg) == 2
    with conn.cursor() as cur:
        cur.execute("SELECT crop_path, crop_pad FROM blocks ORDER BY ordinal LIMIT 1")
        crop_path, crop_pad = cur.fetchone()
    assert crop_path.startswith(f"{_id}/blocks/")
    assert not crop_path.startswith("storage/")
    assert crop_pad == [6, 4]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_layout_paddleocr.py::test_analyze_applies_padding_with_neighbor_clamp tests/test_layout.py::test_run_layout_with_cfg_writes_relative_paths -v
```

预期：FAIL（无 crop_pad / TypeError: unexpected keyword 'cfg'）。

- [ ] **Step 3: 实现**

`pipeline/kb/ocr/layout.py` 按本节开头的设计要点改：

`BlockDraft`：

```python
@dataclass
class BlockDraft:
    page_id: str
    block_type: str
    crop_path: str
    bbox: tuple[float, float, float, float] | None = None
    ordinal: int | None = None
    crop_pad: list[int] | None = None  # [dx, dy] 实际生效外扩量（页图像素）
```

`PaddleOCRLayout.__init__` 签名改为 `(self, blocks_dir: Path, model_name: str = "PP-DocLayoutV3", dpi: int = 200, pipeline=None)`，存 `self._dpi = dpi`。

`analyze` 改为：

```python
    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        output = self._get_pipeline().predict(str(image_path))
        data = output[0].json if hasattr(output[0], "json") else {}
        boxes = (data.get("res") or data).get("boxes", [])
        # PP-DocLayoutV2/V3 自带指针网络，boxes 返回顺序即阅读顺序，直接采用
        out_dir = self._blocks_dir / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        pix = fitz.Pixmap(str(image_path))
        page_size = (pix.width, pix.height)
        del pix
        raw = [tuple(b.get("coordinate") or (0, 0, 0, 0)) for b in boxes]
        drafts = []
        for i, b in enumerate(boxes, start=1):
            bbox = raw[i - 1]
            block_type = map_block_label(b.get("label"))
            padded, pad = padded_px_bbox(
                bbox, block_type, self._dpi, page_size,
                prev_bbox=raw[i - 2] if i > 1 else None,
                next_bbox=raw[i] if i < len(raw) else None,
            )
            crop = out_dir / f"b{i - 1:03d}.png"
            crop_image(image_path, padded, crop)
            drafts.append(BlockDraft(
                page_id=page_id,
                block_type=block_type,
                bbox=tuple(float(v) for v in bbox),  # 存原始值，padding 只在裁图时加
                crop_path=str(crop),
                ordinal=i,
                crop_pad=pad,
            ))
        return drafts
```

`run_layout` 签名与插入循环：

```python
def run_layout(conn, doc_id: str, analyzer: LayoutAnalyzer | None = None,
               force: bool = False, cfg: Config | None = None) -> int:
    """cfg 传入时：页图按 KB_STORAGE_DIR 基准解析、crop_path 落库相对形态并记 crop_pad。
    cfg=None 为旧行为（骨架/测试），路径原样透传。"""
```

循环体改为：

```python
        for page_id, image_path in rows:
            if cfg is not None:
                image_path = str(resolve_storage_path(cfg, image_path))
            for i, draft in enumerate(analyzer.analyze(str(page_id), image_path), start=1):
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, ordinal, crop_pad)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), page_id, draft.block_type,
                     Jsonb(list(draft.bbox)) if draft.bbox is not None else None,
                     storage_rel(cfg, draft.crop_path) if cfg is not None else draft.crop_path,
                     draft.ordinal or i,
                     Jsonb(draft.crop_pad) if draft.crop_pad else None),
                )
                n += 1
```

`make_layout_analyzer`：

```python
def make_layout_analyzer(cfg, doc_id: str | None = None) -> LayoutAnalyzer:
    """按配置选版面引擎。doc_id 传入时块图落 storage/<doc_id>/blocks/（spec §7.1）。"""
    if cfg.layout_engine == "paddleocr":
        blocks_dir = (Path(cfg.storage_dir) / doc_id / "blocks"
                      if doc_id else Path(cfg.storage_dir) / "blocks")
        return PaddleOCRLayout(blocks_dir=blocks_dir, model_name=cfg.layout_model, dpi=cfg.dpi)
    return WholePageLayout()
```

imports 增补：`from kb.core.config import Config`、`from kb.core.paths import resolve_storage_path, storage_rel`、`from kb.ocr.pad import padded_px_bbox`。

`pipeline/kb/pdf_ingest.py:29` 改为：

```python
    run_layout(conn, doc_id, analyzer=make_layout_analyzer(cfg, doc_id), cfg=cfg)
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_layout.py tests/test_layout_paddleocr.py tests/test_qc_layout.py -v
```

预期：全 PASS（cfg=None 旧路径不受影响）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/layout.py pipeline/kb/pdf_ingest.py pipeline/tests/test_layout.py pipeline/tests/test_layout_paddleocr.py
git commit -m "feat(pipeline): 版面切块带 padding 裁图（crop_pad 记账）+ blocks 图挪 storage/<doc_id>/blocks/ 相对落库"
```

---

### Task 6: reprocess.py 同步（padding + doc 下 blocks 目录 + 相对路径）

**Files:**
- Modify: `pipeline/kb/ocr/reprocess.py:53-80`
- Test: `pipeline/tests/test_reprocess.py`

- [ ] **Step 1: 改测试为期望新行为（先红）**

`pipeline/tests/test_reprocess.py` 的 `test_reprocess_replaces_page_blocks`（:58）在现有断言块末尾（:102 之后）追加：

```python
        cur.execute(
            """SELECT b.crop_path, b.crop_pad FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=2 ORDER BY b.ordinal"""
        )
        rows = cur.fetchall()
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s AND page_no=2", (doc_id,))
        page2 = cur.fetchone()[0]
    # 相对新基准落库 + padding 记账（doc3 为 A4@200dpi：text 6/4px，figure 12/8px，
    # 相邻 gap=10px 时垂直外扩夹到 5）
    assert [r[0] for r in rows] == [f"{doc_id}/blocks/{page2}/b{i:03d}.png" for i in range(3)]
    assert [r[1] for r in rows] == [[6, 4], [6, 4], [12, 5]]
```

（FAKE_BLOCKS 三个块依次是 text/formula/figure，纵间距均 10px；formula 按 text 档。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_reprocess.py -v
```

预期：FAIL（crop_path 仍是 `storage/blocks/<page_id>/...`，无 crop_pad）。

- [ ] **Step 3: 实现**

`pipeline/kb/ocr/reprocess.py` 的页循环（:53-80）改为：

```python
            page_id, image_path = row
            abs_img = resolve_storage_path(cfg, image_path)
            cur.execute("DELETE FROM blocks WHERE page_id=%s", (page_id,))
            out_dir = Path(cfg.storage_dir) / doc_id / "blocks" / str(page_id)
            out_dir.mkdir(parents=True, exist_ok=True)
            parsed = _parsing_blocks(pipeline.predict(str(abs_img)))
            pix = fitz.Pixmap(str(abs_img))
            page_size = (pix.width, pix.height)
            del pix
            raw = [tuple(b.get("block_bbox") or (0, 0, 0, 0)) for b in parsed]
            for i, b in enumerate(parsed, start=1):
                bbox = raw[i - 1]
                block_type = map_block_label(b.get("block_label"))
                padded, pad = padded_px_bbox(
                    bbox, block_type, cfg.dpi, page_size,
                    prev_bbox=raw[i - 2] if i > 1 else None,
                    next_bbox=raw[i] if i < len(raw) else None,
                )
                crop = out_dir / f"b{i - 1:03d}.png"
                crop_image(abs_img, padded, crop)
                content = (b.get("block_content") or "").strip() or None
                if content and _needs_vlm_upgrade(block_type, content):
                    block_type, content = "formula", None  # 星号竖式不可信，升级 VLM 重转录
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path,
                                         content_md, source_model, ordinal, crop_pad)
                       VALUES (%s,%s,%s,%s,%s,%s,'paddleocr-vl-1.5',%s,%s)""",
                    (str(uuid.uuid4()), page_id, block_type,
                     Jsonb([float(v) for v in bbox]), storage_rel(cfg, crop), content,
                     i, Jsonb(pad)),
                )
                stats["blocks"] += 1
```

imports 增补：`import pymupdf as fitz`、`from kb.core.paths import resolve_storage_path, storage_rel`、`from kb.ocr.pad import padded_px_bbox`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_reprocess.py tests/test_metering.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/reprocess.py pipeline/tests/test_reprocess.py
git commit -m "feat(pipeline): reprocess 同步 padding 裁图与新路径基准"
```

---

### Task 7: paper_pipeline——题图 padding + clamp + 相对路径

**Files:**
- Modify: `pipeline/kb/paper_pipeline.py:158-167`（`_crop_question`）、:219、:263（`str(rel.resolve())` 两处）
- Test: `pipeline/tests/test_paper_pipeline.py`

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_paper_pipeline.py` 追加：

```python
def test_crop_question_clamps_out_of_range_bbox(tmp_path):
    """整页 bbox 加 padding 后被 clamp 回页内，不崩（验收 4 纵深防御）。"""
    import pymupdf as fitz

    from kb.paper_pipeline import _crop_question

    doc = fitz.open()
    doc.new_page(width=595, height=842)  # A4 pt
    page = doc[0]
    out = tmp_path / "q.png"
    _crop_question(page, 200, [0, 0, 1000, 1000], out)
    pix = fitz.Pixmap(str(out))
    full = page.get_pixmap(dpi=200)
    assert (pix.width, pix.height) == (full.width, full.height)


def test_crop_question_applies_text_padding(tmp_path):
    """题图按 text 档外扩：A4 下水平 4 单位、垂直 2 单位（0-1000 归一化，spec §5.2 表）。"""
    import pymupdf as fitz

    from kb.paper_pipeline import _crop_question

    doc = fitz.open()
    doc.new_page(width=595, height=842)
    page = doc[0]
    out = tmp_path / "q.png"
    _crop_question(page, 200, [100, 100, 200, 200], out)
    pix = fitz.Pixmap(str(out))
    base = page.get_pixmap(dpi=200, clip=fitz.Rect(595 * 0.1, 842 * 0.1, 595 * 0.2, 842 * 0.2))
    assert pix.width > base.width and pix.height > base.height  # 外扩生效
```

并把 `test_拆题落库_裁图_计量_页数回填`（:190）里第 :207 行的断言：

```python
        assert row[5] and Path(row[5]).exists()      # 题图裁切落盘
```

改为：

```python
        assert row[5] == f"papers/{pid}/questions/p0001_q01.png"  # 相对 KB_STORAGE_DIR
        assert (cfg.storage_dir / row[5]).exists()                # 题图裁切落盘
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_paper_pipeline.py -k "clamp or padding or image_path" -v
```

预期：FAIL（无 clamp 时整页 bbox 加 padding 越界 / image_path 仍是绝对路径）。

- [ ] **Step 3: 实现**

`pipeline/kb/paper_pipeline.py` 的 `_crop_question` 改为：

```python
def _crop_question(page: fitz.Page, dpi: int, bbox: list[int], out_path: Path) -> None:
    """按 0-1000 归一化 bbox 裁题图，text 档 padding（spec §5.2）+ clamp 页内（§5.3）。

    用 page.get_pixmap(clip=) 而非 Pixmap(pix, IRect) 二次裁切:后者在 PyMuPDF
    1.28.x 存在 Pixmap 双参构造的兼容问题,前者坐标语义(页面 pt)更干净。
    """
    w, h = page.rect.width, page.rect.height  # pt
    pad_h_mm, pad_v_mm = pad_mm_for("text")
    ux = pad_h_mm / (w * 25.4 / 72) * 1000  # 毫米 -> 0-1000 归一化（x 按页宽）
    uy = pad_v_mm / (h * 25.4 / 72) * 1000  # y 按页高
    x1, y1, x2, y2 = bbox
    rect = fitz.Rect(w * (x1 - ux) / 1000, h * (y1 - uy) / 1000,
                     w * (x2 + ux) / 1000, h * (y2 + uy) / 1000) & page.rect
    page.get_pixmap(dpi=dpi, clip=rect).save(str(out_path))
```

两处 `q["image_path"] = str(rel.resolve())`（:219、:263）改为：

```python
                q["image_path"] = rel.relative_to(cfg.storage_dir).as_posix()
```

imports 增补：`from kb.ocr.pad import pad_mm_for`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_paper_pipeline.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/paper_pipeline.py pipeline/tests/test_paper_pipeline.py
git commit -m "feat(pipeline): 题图裁切加 text 档 padding + 页内 clamp，image_path 改相对 KB_STORAGE_DIR"
```

---

### Task 8: backend——共享 resolveStoragePath + paperQuestions 不再绕过

**Files:**
- Create: `backend/src/storagePath.ts`
- Modify: `backend/src/routes/review.ts:3-24`
- Modify: `backend/src/routes/paperQuestions.ts:34`、:130-141
- Modify: `backend/src/index.ts:63`
- Test: `backend/src/storagePath.test.ts`（新建）、`backend/src/routes/review.test.ts`、`backend/src/routes/paperQuestions.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `backend/src/storagePath.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { resolveStoragePath } from "./storagePath.js";

describe("resolveStoragePath", () => {
  it("相对路径以 storageRoot（KB_STORAGE_DIR）为基准", () => {
    expect(resolveStoragePath("/root/storage", "d1/pages/p0001.png"))
      .toBe("/root/storage/d1/pages/p0001.png");
  });
  it("绝对路径原样透传（兼容存量 source_path 等）", () => {
    expect(resolveStoragePath("/root/storage", "/abs/x.png")).toBe("/abs/x.png");
  });
});
```

`backend/src/routes/review.test.ts` fixture 里所有 `join("storage", docId, ...)` 改为 `join(docId, ...)`（:53、:66、:85 等，全文搜 `join("storage"`），文件写盘位置（`join(storageRoot, docId, ...)`）不动。

`backend/src/routes/paperQuestions.test.ts` 的 beforeAll 挂载改为传 storageRoot，并新增用例（验收 5 的 API 侧）：

```ts
  it("GET /:id/image：相对路径经 resolveStoragePath 解析（不再读原始绝对路径）", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const storageRoot = mkdtempSync(join(tmpdir(), "kb-pq-img-"));
    const rel = join("papers", paperId, "questions", "p0001_q01.png");
    mkdirSync(join(storageRoot, "papers", paperId, "questions"), { recursive: true });
    writeFileSync(join(storageRoot, rel), PNG_1PX);
    await pool.query("UPDATE paper_questions SET image_path=$1 WHERE id=$2", [rel, q1]);
    const a = new Hono();
    a.route("/api/paper-questions", paperQuestionsRoutes(pool, deps, storageRoot));
    const resp = await a.request(`/api/paper-questions/${q1}/image`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("image/png");
  });
```

（`PNG_1PX`、`paperId`、`q1` 按该文件现有变量名对齐；没有 1px PNG 常量就照 `review.test.ts` 的定义补一个。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- storagePath paperQuestions review
```

预期：FAIL（`storagePath.js` 不存在；review fixture 路径带旧前缀解析不到文件；paperQuestionsRoutes 只收 2 参）。

- [ ] **Step 3: 实现**

新建 `backend/src/storagePath.ts`：

```ts
/** DB 里的图片路径一律相对 pipeline storage 根（KB_STORAGE_DIR，spec §7.1）。
    绝对路径原样透传，兼容 source_path 与迁移前的存量行。 */
import { isAbsolute, join } from "node:path";

export function resolveStoragePath(storageRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(storageRoot, p);
}
```

`backend/src/routes/review.ts`：删除本地 `resolveStoragePath`（:22-24），改为 `import { resolveStoragePath } from "../storagePath.js";`；`dirname` 从 :4 的 import 里移除。

`backend/src/routes/paperQuestions.ts`：

```ts
import { resolveStoragePath } from "../storagePath.js";
// ...
export function paperQuestionsRoutes(pool: pg.Pool, deps: PaperJobDeps, storageRoot: string): Hono {
```

image 端点 :137 改为：

```ts
        const buf = await readFile(resolveStoragePath(storageRoot, q.image_path));
```

`backend/src/index.ts:63` 改为：

```ts
  app.route("/api/paper-questions", paperQuestionsRoutes(pool, paperJobs, cfg.storageRoot));
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/storagePath.ts backend/src/storagePath.test.ts backend/src/routes/review.ts backend/src/routes/paperQuestions.ts backend/src/index.ts backend/src/routes/review.test.ts backend/src/routes/paperQuestions.test.ts
git commit -m "fix(backend): 图片路径解析基准改 KB_STORAGE_DIR 本身——提取共享 resolveStoragePath，paperQuestions 不再绕过"
```

---

### Task 9: e2e fixture 路径更新 + 全量回归 + phase 1 验收欠款收尾

**Files:**
- Modify: `e2e/specs/flat-ingest.spec.ts`、`e2e/specs/trajectory.spec.ts`、`e2e/specs/materials-review.spec.ts`、`e2e/specs/exam-structure.spec.ts`（以及 grep 到的其他 `storage/` 前缀 fixture）
- Modify: `AGENTS.md`（边界纪律加一行路径基准）
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §14 状态表

- [ ] **Step 1: 更新 e2e fixture**

`cd e2e && grep -rn '"storage/' specs/`（或 `` `storage/${ `` 模板）逐处把插入 DB 的 `image_path` / `crop_path` 字符串去掉 `storage/` 前缀——文件写盘位置（`STORAGE_ROOT/...` 下）不动，只改 DB 字符串。

- [ ] **Step 2: AGENTS.md 边界纪律加一行**

`AGENTS.md`「边界纪律」追加：

```markdown
- DB 图片路径（pages.image_path / blocks.crop_path / paper_questions.image_path）一律相对 KB_STORAGE_DIR；读取走 `kb/core/paths.py` resolve_storage_path（pipeline）/ `src/storagePath.ts`（backend）。md 是只写镜像，搬目录必须 storage/<doc_id>/ 整目录搬。
```

- [ ] **Step 3: pipeline + backend 全量**

```bash
cd pipeline && uv run pytest tests/ -q
cd backend && npm test
```

预期：全 PASS。

- [ ] **Step 4: e2e 回归**

```bash
cd e2e && npx playwright test specs/materials-review.spec.ts specs/trajectory.spec.ts specs/exam-structure.spec.ts specs/flat-ingest.spec.ts
```

预期：全 PASS（真实三服务断言到 UI/API/DB，覆盖验收 5 的端到端侧）。

- [ ] **Step 5: phase 1 验收欠款（19/20）**

```bash
cd pipeline && KB_RUN_SLOW=1 uv run pytest tests/test_layout_paddleocr.py -v
cd pipeline && uv run python -m kb.cli golden-check 8d1d4ed4-d8e1-4006-8ffe-10f9f841f568
```

预期：慢测试全 PASS（V3 标签覆盖、ordinal 单调）；黄金集指标记录到 commit message。若 V3 单页耗时超 15s 或指标劣化，按 spec §13 回报，不强行通过。

- [ ] **Step 6: spec §14 状态表收尾**

子系统 1 行改为「已完成」；子系统 2 行改为「已完成」。

- [ ] **Step 7: Commit**

```bash
git add e2e/specs AGENTS.md docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "test(e2e): fixture 图片路径去 storage/ 前缀对齐新基准；AGENTS 边界纪律补路径基准"
```

---

## 完成判定

- `cd pipeline && uv run pytest tests/ -q` 全绿（含 KB_RUN_SLOW=1 慢测试）
- `cd backend && npm test` 全绿
- `cd e2e` 相关 spec 全绿
- A4@200dpi 下 figure 块 `crop_pad=[12,8]`（无邻居压迫时），邻居夹紧时垂直外扩 ≤ gap/2；`blocks.bbox` 存原始值
- `_crop_question` 对 [0,0,1000,1000] bbox 加 padding 后不越界
- DB 三类图片路径均为相对 KB_STORAGE_DIR 形态；backend `/api/review/pages/:id/image`、`/api/review/blocks/:id/crop`、`/api/paper-questions/:id/image` 对新路径回传 200
- 黄金集指标不劣于基线

## 范围外（明确不做）

- md 里的图片引用语法与答案折叠（子系统 5）；`items.answer_*` 字段（子系统 4）；块编辑四操作（子系统 3）。
- 两套 bbox 坐标系统一（spec §13 明确本次不做，0019 已加注释标明 blocks.bbox 是页图像素）。

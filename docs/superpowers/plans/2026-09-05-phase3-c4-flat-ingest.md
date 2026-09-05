# Phase 3-C4 flat 入库 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 无目录页的试卷集合（如《学霸提优大试卷》）`structure` 自动回退「整卷按页」模式——建 1 条合成章、不拆条、approve 后按页向量化（chunk meta 带 `page_no`），解锁 3-A Task 13 验收。

**Architecture:** 依据 `docs/superpowers/specs/2026-09-05-phase3-c-design.md`（Workstream D）。新模块 `pipeline/kb/flat.py` 承载 flat 的结构与向量化（`resolve_mode` / `build_flat_chapter` / `embed_flat_pages` / `approve_flat_pages`）；`structure` 编排从 CLI 提取为 `structure.run_structure`（可测）；`documents.struct_mode`（migration 0014）显式标记模式，approve 与 internal API 按它分流；pipeline 新增 `POST /internal/embed-flat-page` 供 3-C2 复核页「整页通过」调用。

**Tech Stack:** Python 3.13 + psycopg + pymupdf + pytest(pipeline/)；Playwright + pg(e2e/)。

**执行顺序:** Task 1-5 按序（数据模型→纯函数）；Task 6-7 是 CLI 接线；Task 8 internal API；Task 9 E2E；Task 10 文档回写与全量回归。

**测试约定:**

- Python:`cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q`
- E2E:`cd e2e && npx playwright test specs/flat-ingest.spec.ts`（真三服务 + ollama + PostgreSQL）

**Spec 偏差记录:**

- `embed_flat_pages` / `approve_flat_pages` / `build_flat_chapter` 抛 `ValueError`（非 spec 里的 SystemExit）：库函数不该杀进程，CLI/SystemExit 留在编排层；internal 端点靠 `except Exception` 转 500。

---

## 文件结构（本计划涉及的全部文件）

- Create: `pipeline/kb/migrations/0014_documents_struct_mode.sql` —— documents 加 struct_mode（toc|flat，可空）
- Create: `pipeline/kb/flat.py` —— flat 模式全部逻辑（模式判定/合成章/按页向量化/批量通过）
- Modify: `pipeline/kb/toc.py` —— `_detect_toc_pages` 转公开 `detect_toc_pages`
- Modify: `pipeline/kb/structure.py` —— 追加 `run_structure` 编排（CLI 逻辑搬入，可测）
- Modify: `pipeline/kb/cli.py` —— structure/approve 两分支改为薄接线 + `--flat` 参数
- Modify: `pipeline/kb/internal_api.py` —— `POST /internal/embed-flat-page`（新注入参数 `embed_client`）
- Test: `pipeline/tests/test_flat.py`（新）
- Test: `pipeline/tests/test_internal_api.py`（追加）
- E2E: `e2e/specs/flat-ingest.spec.ts`（新）
- Docs: `README.md`、`AGENTS.md`、`docs/superpowers/plans/2026-09-03-phase3-a-searchability.md`（Task 13 口径注记）

---

### Task 1: migration 0014——documents.struct_mode

**Files:**

- Create: `pipeline/kb/migrations/0014_documents_struct_mode.sql`
- Test: `pipeline/tests/test_flat.py`

- [ ] **Step 1: 写失败的 schema 测试（创建 tests/test_flat.py）**

```python
"""flat 入库：无目录文档的整卷按页模式——模式判定、合成章、按页对齐向量化、approve 分流。
设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream D）"""
import base64
import uuid

import pytest

_TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def test_documents_struct_mode_schema(conn):
    """0014：struct_mode 受控词表（toc|flat），缺省 NULL（旧文档无值不算错）。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('x', %s) RETURNING id, struct_mode",
            (f"/tmp/{uuid.uuid4()}.pdf",),
        )
        doc_id, mode = cur.fetchone()
        assert mode is None
        cur.execute("UPDATE documents SET struct_mode='flat' WHERE id=%s", (doc_id,))
        with pytest.raises(Exception):
            cur.execute("UPDATE documents SET struct_mode='bogus' WHERE id=%s", (doc_id,))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q`
Expected: FAIL——`column "struct_mode" of relation "documents" does not exist`。

- [ ] **Step 3: 写 migration**

```sql
-- 0014_documents_struct_mode.sql：structure 模式显式化（toc=按目录拆章拆条 / flat=整卷按页）
-- 可空：0014 之前入库的旧文档无值；重跑 structure 会补上
ALTER TABLE documents ADD COLUMN struct_mode text CHECK (struct_mode IN ('toc', 'flat'));
```

- [ ] **Step 4: 跑测试确认通过（含迁移账本一致性回归）**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py tests/test_db.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/migrations/0014_documents_struct_mode.sql pipeline/tests/test_flat.py
git commit -m "feat(pipeline): migration 0014——documents.struct_mode（toc|flat）"
```

---

### Task 2: flat.py——page_contents（按页采用内容）

**Files:**

- Create: `pipeline/kb/flat.py`
- Test: `pipeline/tests/test_flat.py`（追加）

- [ ] **Step 1: 写失败测试（追加；fixture 是后续所有任务的公共底座）**

```python
@pytest.fixture()
def flat_doc(conn, tmp_path):
    """无目录试卷集合：3 页——页 1 块文本（含 header 干扰）、页 2 整页稿、页 3 无内容。"""
    from kb.config import Config

    png = tmp_path / "p.png"
    png.write_bytes(base64.b64decode(_TINY_PNG))
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, doc_type, source_path)
               VALUES (%s, '学霸提优大试卷', '数学', 'exam', %s) RETURNING id""",
            (str(uuid.uuid4()), f"/tmp/{uuid.uuid4()}.pdf"),
        )
        doc_id = str(cur.fetchone()[0])
        spec = [(1, "blocks", None), (2, "page_md", "第二套 素养达标 竖式计算题"), (3, "blocks", None)]
        for page_no, adopted, page_md in spec:
            cur.execute(
                """INSERT INTO pages (id, document_id, page_no, image_path, status, adopted_source, page_md)
                   VALUES (%s,%s,%s,%s,'parsed',%s,%s) RETURNING id""",
                (str(uuid.uuid4()), doc_id, page_no, str(png), adopted, page_md),
            )
            page_id = str(cur.fetchone()[0])
            if page_no == 1:
                for btype, content in [("header", "第 1 页 学霸提优"),
                                       ("text", "一、口算 24+37="),
                                       ("text", "二、竖式 135÷5=")]:
                    cur.execute(
                        "INSERT INTO blocks (id, page_id, block_type, crop_path, content_md) "
                        "VALUES (%s,%s,%s,'/tmp/c.png',%s)",
                        (str(uuid.uuid4()), page_id, btype, content),
                    )
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    return doc_id, cfg


def test_page_contents_adopts_and_skips(conn, flat_doc):
    from kb.flat import page_contents

    doc_id, _cfg = flat_doc
    with conn.cursor() as cur:
        contents = page_contents(cur, doc_id)
    assert contents == [
        (1, "一、口算 24+37=\n二、竖式 135÷5="),  # header 跳过，块按 created_at 序拼接
        (2, "第二套 素养达标 竖式计算题"),           # 整页稿原样
    ]  # 页 3 无内容，不出现
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q -k page_contents`
Expected: FAIL——`ModuleNotFoundError: No module named 'kb.flat'`。

- [ ] **Step 3: 实现（创建 kb/flat.py）**

```python
"""flat 入库：无目录文档（试卷集合等）的整卷按页模式。

structure 探测不到目录页时回退到这里：不抽目录、不拆条，
建 1 条合成章 + 按页对齐向量化（chunk meta 带 page_no，检索可定位到页）。
设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream D）
"""
from __future__ import annotations

import uuid

from psycopg.types.json import Jsonb

from kb.config import Config

_SKIP_TYPES = ("header", "footer")


def page_contents(cur, doc_id: str) -> list[tuple[int, str]]:
    """flat 文档的按页采用内容：page_md 页用整页稿，其余页用块文本（跳 header/footer）。
    与 structure._chapter_blocks 同口径；无内容的页不出现。"""
    cur.execute(
        """SELECT page_no, adopted_source, page_md, id FROM pages
           WHERE document_id=%s ORDER BY page_no""",
        (doc_id,),
    )
    out: list[tuple[int, str]] = []
    for page_no, adopted, page_md, page_id in cur.fetchall():
        if adopted == "page_md" and page_md:
            out.append((page_no, page_md))
            continue
        cur.execute(
            """SELECT content_md FROM blocks
               WHERE page_id=%s AND NOT (block_type = ANY(%s)) AND content_md IS NOT NULL
               ORDER BY created_at""",
            (page_id, list(_SKIP_TYPES)),
        )
        text = "\n".join(r[0] for r in cur.fetchall())
        if text.strip():
            out.append((page_no, text))
    return out
```

（`Jsonb`/`Config`/`uuid` 本任务暂未用到，后续 Task 3-7 会在本文件追加使用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/flat.py pipeline/tests/test_flat.py
git commit -m "feat(pipeline): flat.page_contents——按页采用内容（整页稿/块文本同口径）"
```

---

### Task 3: flat.py——build_flat_chapter（合成章）

**Files:**

- Modify: `pipeline/kb/flat.py`（追加）
- Test: `pipeline/tests/test_flat.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
def test_build_flat_chapter_idempotent(conn, flat_doc):
    from kb.flat import build_flat_chapter

    doc_id, _cfg = flat_doc
    ch1 = build_flat_chapter(conn, doc_id)
    ch2 = build_flat_chapter(conn, doc_id)  # 重跑（页面被复核编辑后）更新内容不重建
    assert ch1 == ch2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT ch.chapter_no, ch.title, ch.content_md, d.struct_mode
               FROM chapters ch JOIN documents d ON d.id = ch.document_id WHERE ch.id=%s""",
            (ch1,),
        )
        no, title, content_md, mode = cur.fetchone()
    assert (no, title, mode) == (1, "学霸提优大试卷", "flat")
    assert "一、口算 24+37=" in content_md
    assert "第二套 素养达标 竖式计算题" in content_md
    assert "\n\n" in content_md  # 页间以空行拼接


def test_build_flat_chapter_refuses_multi_chapter_doc(conn, flat_doc):
    """多章文档（已按目录拆章）不允许混用 flat（防止合成章覆盖真章）。"""
    from kb.flat import build_flat_chapter

    doc_id, _cfg = flat_doc
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO chapters (id, document_id, chapter_no, title) VALUES (%s,%s,2,'真章')",
            (str(uuid.uuid4()), doc_id),
        )
    with pytest.raises(ValueError, match="已有章节"):
        build_flat_chapter(conn, doc_id)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q -k build_flat`
Expected: FAIL——`ImportError: cannot import name 'build_flat_chapter'`。

- [ ] **Step 3: 实现（追加到 kb/flat.py）**

```python
def build_flat_chapter(conn, doc_id: str) -> str:
    """建/更新合成章（chapter_no=1，title=文档名，content_md=全页采用内容拼接）并置
    struct_mode='flat'。返回 chapter_id。幂等：重跑更新 content_md。
    防混用：文档已有第 2+ 章视为 TOC 拆过章，拒绝。"""
    with conn.cursor() as cur:
        cur.execute("SELECT title FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"文档不存在: {doc_id}")
        cur.execute(
            "SELECT chapter_no FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = [r[0] for r in cur.fetchall()]
        if chapters and chapters != [1]:
            raise ValueError("文档已有章节（可能已按目录拆章），--flat 仅用于未拆章文档")
        content_md = "\n\n".join(text for _no, text in page_contents(cur, doc_id))
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,%s,%s)
               ON CONFLICT (document_id, chapter_no) DO UPDATE SET content_md = EXCLUDED.content_md
               RETURNING id""",
            (str(uuid.uuid4()), doc_id, row[0], content_md),
        )
        chapter_id = str(cur.fetchone()[0])
        cur.execute("UPDATE documents SET struct_mode='flat' WHERE id=%s", (doc_id,))
    return chapter_id
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/flat.py pipeline/tests/test_flat.py
git commit -m "feat(pipeline): flat.build_flat_chapter——合成章 + struct_mode=flat（幂等）"
```

---

### Task 4: flat.py——embed_flat_pages（按页对齐向量化）

**Files:**

- Modify: `pipeline/kb/flat.py`（追加）
- Test: `pipeline/tests/test_flat.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
class _FakeEmbed:
    """确定性假 embedding：全 1 向量（1024 维，同 tests/test_embed.py 手法）。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()


def test_embed_flat_pages_per_page_segments(conn, flat_doc):
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    n = embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    assert n == 2  # 页 1、页 2 各一段（页 3 无内容）
    with conn.cursor() as cur:
        cur.execute(
            """SELECT seg_no, meta->>'page_no', meta->>'kind', meta->>'chapter',
                      content_md, vector_dims(embedding)
               FROM chunks WHERE chapter_id IS NOT NULL ORDER BY seg_no"""
        )
        rows = cur.fetchall()
    assert [(r[0], r[1], r[2], r[3]) for r in rows] == [
        (1001, "1", "chapter", "全卷"),
        (2001, "2", "chapter", "全卷"),
    ]
    assert "一、口算" in rows[0][4] and "第二套" in rows[1][4]
    assert "第 1 页" in rows[0][4] and "第 2 页" in rows[1][4]  # content 带页定位前缀
    assert rows[0][5] == 1024


def test_embed_flat_pages_rebuild_single_page(conn, flat_doc):
    """页级重建：只重嵌目标页（删旧插新），其他页 chunk 不动——复核编辑后重发的依据。"""
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:  # 复核编辑：页 2 整页稿改内容
        cur.execute(
            "UPDATE pages SET page_md='第二套 改后内容 退位减法' WHERE document_id=%s AND page_no=2",
            (doc_id,),
        )
    n = embed_flat_pages(conn, cfg, doc_id, page_no=2, client=_FakeEmbed())
    assert n == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT meta->>'page_no', content_md FROM chunks "
            "WHERE chapter_id IS NOT NULL ORDER BY seg_no"
        )
        rows = cur.fetchall()
    assert len(rows) == 2  # 页 1 未动 + 页 2 重建
    assert rows[1] == ("2", "全卷 · 第 2 页\n\n第二套 改后内容 退位减法")


def test_embed_flat_pages_guards(conn, flat_doc):
    """没建合成章 / 非 flat 文档 -> ValueError（internal 端点转 500）。"""
    from kb.flat import embed_flat_pages

    doc_id, cfg = flat_doc
    with pytest.raises(ValueError, match="先跑 structure"):
        embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    from kb.flat import build_flat_chapter
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    with pytest.raises(ValueError, match="非 flat"):
        embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q -k embed_flat`
Expected: FAIL——`ImportError: cannot import name 'embed_flat_pages'`。

- [ ] **Step 3: 实现（追加到 kb/flat.py）**

```python
def embed_flat_pages(conn, cfg: Config, doc_id: str, page_no: int | None = None,
                     client=None) -> int:
    """flat 文档按页对齐向量化（重建式幂等）。
    每页切段（超长页用 segment_chapter 再细分），seg_no = page_no*1000 + 段序
    （确定性编号，单页重建不与其他页冲突）；page_no 给定时只重建该页。
    返回新增 chunk 数。"""
    from kb.embed import embed_texts, segment_chapter

    with conn.cursor() as cur:
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"文档不存在: {doc_id}")
        if row[0] != "flat":
            raise ValueError("非 flat 文档（struct_mode 不是 flat）")
        cur.execute(
            """SELECT ch.id, d.title, d.subject, d.grade
               FROM chapters ch JOIN documents d ON d.id = ch.document_id
               WHERE ch.document_id=%s AND ch.chapter_no=1""",
            (doc_id,),
        )
        ch = cur.fetchone()
        if not ch:
            raise ValueError("flat 章不存在，请先跑 structure")
        chapter_id, doc_title, subject, grade = str(ch[0]), ch[1], ch[2], ch[3]
        contents = [pc for pc in page_contents(cur, doc_id)
                    if page_no is None or pc[0] == page_no]
    label = "全卷"
    payloads: list[tuple[int, int, str]] = []  # (page_no, seg_idx, content)
    for pno, text in contents:
        for i, seg in enumerate(segment_chapter(text), start=1):
            payloads.append((pno, i, f"{label} · 第 {pno} 页\n\n{seg}"))
    if not payloads:
        return 0
    vectors = embed_texts(cfg, [content for _p, _i, content in payloads], client=client)
    by_page: dict[int, list[tuple[tuple[int, int, str], list[float]]]] = {}
    for payload, vec in zip(payloads, vectors, strict=True):
        by_page.setdefault(payload[0], []).append((payload, vec))
    with conn.cursor() as cur:
        for pno, items in by_page.items():
            cur.execute(
                "DELETE FROM chunks WHERE chapter_id=%s AND meta->>'page_no'=%s",
                (chapter_id, str(pno)),
            )
            for (p, i, content), vec in items:
                meta = {
                    "kind": "chapter", "chapter": label, "page_no": pno,
                    "doc_title": doc_title, "subject": subject, "grade": grade, "seg": i,
                }
                cur.execute(
                    """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
                       VALUES (%s,%s,%s,%s,%s,%s)""",
                    (chapter_id, doc_id, pno * 1000 + i, content, Jsonb(meta), vec),
                )
    return len(payloads)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/flat.py pipeline/tests/test_flat.py
git commit -m "feat(pipeline): flat.embed_flat_pages——按页对齐切段向量化（重建式幂等）"
```

---

### Task 5: toc.detect_toc_pages 公开 + flat.resolve_mode

**Files:**

- Modify: `pipeline/kb/toc.py`（`_detect_toc_pages` 改名公开）
- Modify: `pipeline/kb/flat.py`（追加 `resolve_mode`）
- Test: `pipeline/tests/test_flat.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
def test_resolve_mode(conn, flat_doc):
    """优先级：--flat 显式 > --toc-pages 显式 > 自动探测（前 15 页块文本含「目录」= toc）。"""
    from kb.flat import resolve_mode

    doc_id, _cfg = flat_doc
    with conn.cursor() as cur:
        assert resolve_mode(cur, doc_id, flat=True, toc_pages=None) == "flat"
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=[4]) == "toc"
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "flat"  # 无目录块
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录 第 1 套' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "toc"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q -k resolve_mode`
Expected: FAIL——`ImportError: cannot import name 'resolve_mode'`。

- [ ] **Step 3: 实现**

`kb/toc.py` 两处改名（`_detect_toc_pages` → `detect_toc_pages`，docstring 去掉私有语气）：

```python
def detect_toc_pages(cur, doc_id: str) -> list[int]:
    """自动探测目录页：前 15 页里块文本含「目录」的页。"""
```

（`extract_toc` 内的调用点 `pages = toc_pages if ... else _detect_toc_pages(cur, doc_id)` 同步改为 `detect_toc_pages`。）

`kb/flat.py` 追加：

```python
def resolve_mode(cur, doc_id: str, flat: bool, toc_pages: list[int] | None) -> str:
    """structure 模式判定：显式 --flat > 显式 --toc-pages > 自动探测目录页。"""
    if flat:
        return "flat"
    if toc_pages:
        return "toc"
    from kb.toc import detect_toc_pages
    return "toc" if detect_toc_pages(cur, doc_id) else "flat"
```

- [ ] **Step 4: 跑测试确认通过 + toc 回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py tests/test_toc.py -q`
Expected: PASS（改名不动行为）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/toc.py pipeline/kb/flat.py pipeline/tests/test_flat.py
git commit -m "feat(pipeline): flat.resolve_mode——模式判定（显式优先，探测不到回退 flat）"
```

---

### Task 6: structure.run_structure 编排 + CLI 接线（自动回退 / --flat）

**Files:**

- Modify: `pipeline/kb/structure.py`（追加 `run_structure`，逻辑自 CLI 搬入）
- Modify: `pipeline/kb/cli.py:61-64`（parser 加 `--flat`）、`cli.py:133-160`（structure 分支改薄）
- Test: `pipeline/tests/test_flat.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
_FENCE = "`" * 3
TOC_JSON = _FENCE + "json\n" + (
    '[{"chapter_no": 1, "title": "口算", "print_page": 1, "taxonomy": "计算类", "tags": []}]'
) + "\n" + _FENCE


def _client(*texts):
    """按调用顺序弹回预设响应（同 tests/test_toc.py 手法）。"""
    seq = list(texts)

    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = seq.pop(0)

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client()


def test_run_structure_flat_fallback(conn, flat_doc, capsys):
    """自动探测无目录 -> flat：合成 1 章、零 LLM 调用、struct_mode=flat。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    out = run_structure(conn, cfg, doc_id)
    assert out == {"mode": "flat", "chapters": 1, "items": 0}
    assert "回退整卷按页模式" in capsys.readouterr().out
    with conn.cursor() as cur:
        cur.execute(
            """SELECT struct_mode, (SELECT count(*) FROM items WHERE document_id=d.id)
               FROM documents d WHERE id=%s""",
            (doc_id,),
        )
        assert cur.fetchone() == ("flat", 0)
        cur.execute("SELECT count(*) FROM llm_calls WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0


def test_run_structure_flat_flag_overrides_toc(conn, flat_doc):
    """页 1 有「目录」块本会走 toc；--flat 强制 flat。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
    assert run_structure(conn, cfg, doc_id, flat=True)["mode"] == "flat"


def test_run_structure_toc_marks_mode(conn, flat_doc):
    """TOC 路径成功后置 struct_mode='toc'（approve 分流依据）。
    章标题在非目录页找不到 -> 校准 0、拆条跳过，恰好只消耗 1 次 VLM（TOC 抽取）。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录 第 1 讲 口算' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
    out = run_structure(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert out == {"mode": "toc", "chapters": 1, "items": 0}
    with conn.cursor() as cur:
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        assert cur.fetchone()[0] == "toc"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q -k run_structure`
Expected: FAIL——`ImportError: cannot import name 'run_structure'`。

- [ ] **Step 3: 实现**

`kb/structure.py` 末尾追加（`structure_chapter`/`pair_items` 已在文件内，import 收敛到函数体保持模块加载轻）：

```python
def run_structure(conn, cfg: Config, doc_id: str, toc_pages: list[int] | None = None,
                  flat: bool = False, client=None) -> dict:
    """structure 编排（CLI 同款流程，可直接测试）。
    模式判定：--flat 显式 / --toc-pages 显式 / 自动探测目录页，探测不到回退 flat。"""
    from kb.export_md import export_chapter_mds, export_page_mds
    from kb.flat import build_flat_chapter, resolve_mode
    from kb.grounding import run_grounding
    from kb.qc import check_label_continuity
    from kb.toc import calibrate_pages, extract_toc

    with conn.cursor() as cur:
        mode = resolve_mode(cur, doc_id, flat=flat, toc_pages=toc_pages)
    if mode == "flat":
        if not flat:
            print("未找到目录页，回退整卷按页模式（--toc-pages 可显式指定目录页）")
        build_flat_chapter(conn, doc_id)
        print(f"整卷按页模式: 合成 1 章（不拆条,页级通过后按页向量化）; "
              f"落盘 {export_page_mds(conn, cfg, doc_id)} 页 md, "
              f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
        return {"mode": "flat", "chapters": 1, "items": 0}

    n_toc = extract_toc(conn, cfg, doc_id, client=client, toc_pages=toc_pages)
    n_cal = calibrate_pages(conn, doc_id)
    print(f"目录: {n_toc} 章入库, {n_cal} 章完成页码校准")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = [r[0] for r in cur.fetchall()]
    total = 0
    for no in chapters:
        try:
            total += structure_chapter(conn, cfg, doc_id, no, client=client)
        except SystemExit as e:
            print(f"第 {no} 章跳过: {e}")
    print(f"条目: {total} 条入库; 配对 {pair_items(conn, doc_id)} 处; "
          f"题号质检新增 {check_label_continuity(conn, doc_id)} 条; "
          f"接地检查新增 {run_grounding(conn, doc_id)} 条")
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    print(f"落盘: {export_page_mds(conn, cfg, doc_id)} 页 md, "
          f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
    return {"mode": "toc", "chapters": len(chapters), "items": total}
```

`kb/cli.py` parser（`--toc-pages` 之后加一行）：

```python
    p_struct.add_argument("--flat", action="store_true",
                          help="整卷按页模式：不抽目录不拆条，页级通过后按页向量化（无目录页的试卷集合）")
```

`kb/cli.py` structure 分支整体替换为：

```python
    elif args.cmd == "structure":
        from kb.structure import run_structure

        toc_pages = [int(x) for x in args.toc_pages.split(",")] if args.toc_pages else None
        run_structure(conn, cfg, args.doc_id, toc_pages=toc_pages, flat=args.flat)
```

- [ ] **Step 4: 跑测试确认通过 + structure/toc 回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py tests/test_structure.py tests/test_toc.py -q`
Expected: PASS（run_structure 是 CLI 原逻辑搬运，行为不变）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/structure.py pipeline/kb/cli.py pipeline/tests/test_flat.py
git commit -m "feat(pipeline): structure 自动回退 flat + --flat 强制；编排提取为 run_structure 可测"
```

---

### Task 7: flat.approve_flat_pages + CLI approve 分流

**Files:**

- Modify: `pipeline/kb/flat.py`（追加）
- Modify: `pipeline/kb/cli.py:172-175`（approve 分支按 struct_mode 分流）
- Test: `pipeline/tests/test_flat.py`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```python
def test_approve_flat_pages_closes_rows_and_embeds(conn, flat_doc):
    from kb.flat import approve_flat_pages, build_flat_chapter

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:  # 页 1 挂一条 pending 复核行
        cur.execute("SELECT id FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
        page_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO review_queue (id, page_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), page_id),
        )
    out = approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    assert out == {"pages": 2, "chunks": 2, "resolved": 1}
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE page_id=%s", (page_id,))
        assert cur.fetchone()[0] == "approved"
        cur.execute("SELECT count(*) FROM chunks WHERE chapter_id IS NOT NULL")
        assert cur.fetchone()[0] == 2


def test_approve_flat_pages_guards(conn, flat_doc):
    from kb.flat import approve_flat_pages

    doc_id, cfg = flat_doc
    with pytest.raises(ValueError, match="非 flat"):
        approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_flat.py -q -k approve_flat`
Expected: FAIL——`ImportError: cannot import name 'approve_flat_pages'`。

- [ ] **Step 3: 实现（追加到 kb/flat.py）**

```python
def approve_flat_pages(conn, cfg: Config, doc_id: str, client=None) -> dict:
    """flat 文档批量通过：关闭该文档全部 pending 复核行 + 全页向量化（重建式幂等）。
    返回 {pages: 有内容的页数, chunks: 新增 chunk 数, resolved: 关闭的复核行数}。"""
    with conn.cursor() as cur:
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"文档不存在: {doc_id}")
        if row[0] != "flat":
            raise ValueError("非 flat 文档（struct_mode 不是 flat）")
        cur.execute(
            """UPDATE review_queue SET status='approved'
               WHERE status='pending'
                 AND page_id IN (SELECT id FROM pages WHERE document_id=%s)""",
            (doc_id,),
        )
        resolved = cur.rowcount
    chunks = embed_flat_pages(conn, cfg, doc_id, client=client)
    with conn.cursor() as cur:
        n_pages = len(page_contents(cur, doc_id))
    return {"pages": n_pages, "chunks": chunks, "resolved": resolved}
```

`kb/cli.py` approve 分支整体替换为：

```python
    elif args.cmd == "approve":
        from kb.embed import approve_items
        from kb.flat import approve_flat_pages
        with conn.cursor() as cur:
            cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (args.doc_id,))
            row = cur.fetchone()
        if row and row[0] == "flat":
            out = approve_flat_pages(conn, cfg, args.doc_id)
            print(f"通过 {out['pages']} 页,新增向量 {out['chunks']} 条(页级)")
        else:
            out = approve_items(conn, cfg, args.doc_id, chapter_no=args.chapter)
            print(f"通过 {out['approved']} 条,新增向量 {out['embedded']} 条")
```

（flat 文档只有 1 条合成章，`--chapter` 参数对 flat 无意义，忽略。）

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/flat.py pipeline/kb/cli.py pipeline/tests/test_flat.py
git commit -m "feat(pipeline): approve 按 struct_mode 分流——flat 文档全页通过+按页向量化"
```

---

### Task 8: internal API——POST /internal/embed-flat-page

**Files:**

- Modify: `pipeline/kb/internal_api.py`
- Test: `pipeline/tests/test_internal_api.py`（追加）

- [ ] **Step 1: 写失败测试（追加到 test_internal_api.py；fixture 跨文件导入，同 paper 端点先例）**

```python
class TestEmbedFlatPage:
    def test_重建指定页(self, conn, flat_doc):
        """flat_doc fixture 见 tests/test_flat.py。"""
        from fastapi.testclient import TestClient
        from kb.flat import build_flat_chapter
        from kb.internal_api import create_internal_app
        from tests.test_flat import _FakeEmbed

        doc_id, _cfg = flat_doc
        build_flat_chapter(conn, doc_id)
        client = TestClient(create_internal_app(get_conn=lambda: conn, embed_client=_FakeEmbed()))
        r = client.post("/internal/embed-flat-page", json={"doc_id": doc_id, "page_no": 1})
        assert r.status_code == 200 and r.json() == {"chunks": 1}
        rows = conn.execute(
            "SELECT meta->>'page_no' FROM chunks WHERE chapter_id IS NOT NULL"
        ).fetchall()
        assert rows == [("1",)]  # 只重建了页 1

    def test_未建章_500_detail(self, conn, flat_doc):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app

        doc_id, _cfg = flat_doc
        client = TestClient(create_internal_app(get_conn=lambda: conn))
        r = client.post("/internal/embed-flat-page", json={"doc_id": doc_id, "page_no": 1})
        assert r.status_code == 500
        assert "flat" in r.json()["detail"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q -k EmbedFlatPage`
Expected: FAIL——`TypeError: create_internal_app() got an unexpected keyword argument 'embed_client'`。

- [ ] **Step 3: 实现**

`kb/internal_api.py`：

签名加 `embed_client=None`（与 `vlm_client` 并列）：

```python
def create_internal_app(reranker_factory=None, get_conn=None, vlm_client=None, cfg=None,
                        embed_client=None) -> FastAPI:
```

`RecognizePageRequest` 之后加请求模型，`/internal/recognize-page` 端点之后加端点：

```python
class EmbedFlatPageRequest(BaseModel):
    doc_id: str
    page_no: int
```

```python
    @app.post("/internal/embed-flat-page")
    def embed_flat_page(body: EmbedFlatPageRequest):
        """flat 文档单页向量化（复核页「整页通过」时由 TS 调用，重建式幂等）。"""
        from kb.flat import embed_flat_pages
        with conn_ctx() as conn:
            try:
                return {"chunks": embed_flat_pages(conn, _cfg(), body.doc_id,
                                                   page_no=body.page_no, client=embed_client)}
            except Exception as e:  # noqa: BLE001 —— 失败细节透传给编排层
                raise HTTPException(status_code=500, detail=str(e)) from e
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/internal_api.py pipeline/tests/test_internal_api.py
git commit -m "feat(pipeline): /internal/embed-flat-page——复核页整页通过的单页向量化通道"
```

---

### Task 9: E2E——flat 入库到聊天检索全链路

**Files:**

- Create: `e2e/specs/flat-ingest.spec.ts`

- [ ] **Step 1: 写 spec（DB 种子不经 VLM，聚焦 flat 链路；聊天断言复用 searchability 手法）**

```typescript
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** flat 入库全链路 E2E:无目录试卷集合(DB 种子) -> structure 自动回退 -> approve 全页向量化
    -> 聊天检索命中页级内容。真实栈(三服务 + ollama bge-m3/聊天模型 + PostgreSQL);
    种子直插 pages/blocks(不跑 VLM 渲染解析),聚焦 flat 链路本身。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-无目录试卷`;
const KEYWORD = `E2E${RUN}魔法词`; // 只出现在页 1 内容里,模型必须检索才知道
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let docId = "";

test.beforeAll(async () => {
  // 1) 种子:1 文档 2 页块文本(无「目录」字样),页 1 带唯一关键词
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path)
     VALUES ($1,'数学','exam',$2) RETURNING id::text`,
    [TITLE, `/tmp/e2e-flat-${RUN}.pdf`],
  );
  docId = doc.id;
  const pages: Array<[number, Array<[string, string]>]> = [
    [1, [[`${KEYWORD} 15-9= 竖式退位减法`, "text"], ["页眉 学霸提优", "header"]]],
    [2, [["第二套 口算 24+37=", "text"]]],
  ];
  for (const [pageNo, contents] of pages) {
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, status)
       VALUES ($1,$2,'/tmp/x.png','parsed') RETURNING id::text`,
      [docId, pageNo],
    );
    for (const [content, type] of contents) {
      await pool.query(
        `INSERT INTO blocks (page_id, block_type, crop_path, content_md) VALUES ($1,$2,'/tmp/c.png',$3)`,
        [page.id, type, content],
      );
    }
  }
});

test("structure 自动回退 flat,approve 后页级可检索", async ({ page }) => {
  // 2) structure:无目录 -> 自动 flat(合成 1 章,不拆条,零 LLM)
  const out = execSync(`uv run python -m kb.cli structure ${docId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  expect(out).toContain("回退整卷按页模式");
  const { rows: [doc] } = await pool.query(
    `SELECT struct_mode,
            (SELECT count(*) FROM chapters WHERE document_id = d.id) AS chapters,
            (SELECT count(*) FROM items WHERE document_id = d.id) AS items
     FROM documents d WHERE d.id = $1`, [docId]);
  expect(doc.struct_mode).toBe("flat");
  expect(doc.chapters).toBe(1);
  expect(doc.items).toBe(0);

  // 3) approve:关复核行 + 全页向量化(seg_no 按页对齐,meta 带 page_no)
  const appr = execSync(`uv run python -m kb.cli approve ${docId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  expect(appr).toContain("通过 2 页");
  const { rows: chunks } = await pool.query(
    `SELECT seg_no, meta->>'page_no' AS page_no, meta->>'kind' AS kind
     FROM chunks WHERE document_id = $1 ORDER BY seg_no`, [docId]);
  expect(chunks.map((c) => [c.seg_no, c.page_no, c.kind])).toEqual([
    [1001, "1", "chapter"],
    [2001, "2", "chapter"],
  ]);

  // 4) UI:聊天问关键词,回复必须引用资料内容(须调 search_items)
  await page.goto("/");
  await page.getByPlaceholder(/问点什么/).fill(`${KEYWORD} 讲的是什么?请先搜题库再回答。`);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", {
    timeout: 240_000,
  });
  const reply = (await page.locator(".msg:last-child .bubble").textContent()) ?? "";
  expect(reply).not.toContain("出错了");
  expect(reply).toContain("退位");
});

test.afterAll(async () => {
  // documents 级联 chapters/chunks/review_queue;llm_calls 残留为计量流水,可接受
  if (docId) await pool.query("DELETE FROM documents WHERE id = $1", [docId]);
  await pool.end();
});
```

- [ ] **Step 2: 跑 E2E 确认通过**

Run: `cd e2e && npx playwright test specs/flat-ingest.spec.ts`
Expected: 1 passed（三服务自动复用/拉起；聊天段约 1-3 分钟）。

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/flat-ingest.spec.ts
git commit -m "test(e2e): flat 入库全链路——自动回退/approve 页级向量化/聊天检索命中"
```

---

### Task 10: 文档回写 + 全量回归

**Files:**

- Modify: `README.md`（「精度期 2b」之后加 flat 段）
- Modify: `AGENTS.md`（入库工作流第 4 步）
- Modify: `docs/superpowers/plans/2026-09-03-phase3-a-searchability.md`（Task 13 口径注记）

- [ ] **Step 1: README 加 flat 段（「## 检索期：向量化与语义查询」之前插入）**

```markdown
## 整卷按页模式（flat）：无目录文档回退

`structure` 探测不到目录页时自动回退（`--flat` 可显式强制，`--toc-pages` 仍可指定走目录路径）：
建 1 条「全卷」合成章、不拆条，`approve` 后按页向量化——chunk meta 带 `page_no`，检索可定位到页。
适合无目录页的试卷集合（如《学霸提优大试卷》）；`documents.struct_mode` 记录模式（toc|flat）。
```

- [ ] **Step 2: AGENTS.md 入库工作流第 4 步替换**

原文：

```markdown
4. PDF（docx/md 可选）跑 `structure <doc_id>` 拆条成题目级条目。
```

改为：

```markdown
4. PDF（docx/md 可选）跑 `structure <doc_id>` 拆条成题目级条目；无目录页的试卷集合自动回退「整卷按页」模式（不拆条，页级检索，`--flat` 显式强制）。
```

- [ ] **Step 3: 3-A 计划 Task 13 加口径注记（「详见 .workbuddy/memory/2026-09-04.md。」一行之后插入）**

```markdown
> **口径修订（2026-09-05，`2026-09-05-phase3-c-design.md` D4）：**
> 无目录试卷集合走 flat 路径后，Step 2 验收从「命中试卷条目（题目级）」修订为
> 「命中页级章节 chunk（meta 带 page_no，可定位到页）」。
```

- [ ] **Step 4: 全量回归（三侧 + 新 E2E）**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS。

Run: `cd e2e && npx playwright test specs/flat-ingest.spec.ts specs/searchability.spec.ts`
Expected: 2 passed（searchability 守护章节 chunk 主链路未被 flat 改动波及）。

（backend/frontend 本计划零改动，不跑。）

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md docs/superpowers/plans/2026-09-03-phase3-a-searchability.md
git commit -m "docs: flat 整卷按页模式说明 + Task 13 验收口径修订（题目级->页级）"
```

---

## Self-Review 记录

- **Spec 覆盖**：D1 触发（Task 5/6）、D2 合成章+struct_mode（Task 1/3）、D3 按页切段/seg_no/页级通过向量化/CLI approve（Task 4/7/8）、D4 口径修订（Task 10）、e2e（Task 9）——Workstream D 全部条目有对应任务。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`embed_flat_pages(conn, cfg, doc_id, page_no=None, client=None) -> int` 在 Task 4 定义、Task 7/8 调用一致；`approve_flat_pages` 返回 `{pages, chunks, resolved}` 与 CLI 打印、测试断言一致；`resolve_mode(cur, doc_id, flat, toc_pages)` 与 Task 6 调用一致。
- **已知取舍**：`build_flat_chapter` 对「单章 TOC 文档 + 显式 --flat」不设防（操作员显式强制，可重跑 TOC structure 恢复），多章文档有硬拒绝。

# Phase 1 双栈骨架 + 聊天链路 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 立起 frontend（React）/ backend（TS+pi-agent）/ pipeline（Python）三目录双栈结构，聊天 agent 可检索题库，孩子做题记录可写入，docx 可入库。

**Architecture:** 依据 `docs/superpowers/specs/2026-09-02-overall-system-design.md` 与 `2026-09-02-docx-ingest-design.md`。Python 现有 `backend/` 整体搬家为 `pipeline/`（仍是 schema 唯一主人）；检索主链路（向量+BM25+RRF）在 TS 实现，仅 rerank 走 pipeline 的 `/internal/rerank`。

**Tech Stack:** Python 3.13 + FastAPI + psycopg + pytest（pipeline/）；Node + TS + Hono + pi-agent-core/pi-ai + pg + vitest（backend/）；React + Vite + KaTeX（frontend/）；PostgreSQL + pgvector；pandoc（docx 转换，环境已有）。

**执行顺序：** Task 1-2（搬家+schema）必须先做；之后 Workstream B（Task 3-7，docx 入库）与 Workstream C（Task 8-12，TS 后端）可并行；Task 13（前端聊天页）依赖 Task 11 的 `/api/chat`；Task 14（AGENTS.md/文档）最后。

**测试约定：**
- Python：`cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
- TS：`cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`（vitest，测试辅助会 DROP SCHEMA 后重放 `pipeline/kb/migrations/*.sql`）

**Spec 偏差记录：** `llm_calls.paper_id` 不在本期加——`papers` 表是 Phase 2 的产物，列随该期 migration 一起建。本期只加 `modality`。

---

## Task 1: 目录搬家 backend/ → pipeline/

**Files:**
- Move: `backend/` → `pipeline/`（git mv，保留历史）
- Modify: `.gitignore`（`backend/storage/` → `pipeline/storage/`）
- Modify: `README.md`、`docs/init-design.md` 中对 `backend/` 的路径引用（如有）

- [ ] **Step 1: 搬家**

```bash
git mv backend pipeline
```

- [ ] **Step 2: 修 .gitignore 与文档引用**

`.gitignore` 中 `backend/storage/` 改为 `pipeline/storage/`。
全仓 grep `backend/`（排除 `.git`、`pipeline/.venv`），逐个修文档/脚本中的路径引用。

```bash
grep -rn "backend/" --include="*.md" --include="*.toml" --include="*.py" . | grep -v ".venv" | grep -v "pipeline/"
```

- [ ] **Step 3: 验证测试全绿（证明搬家无损）**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 129 passed, 1 skipped（与搬家前一致）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: Python 后端目录 backend/ 更名为 pipeline/

双栈拆分：backend/ 留给 TS 服务；Python 侧职责为解析管线+migrations+rerank 服务"
```

---

## Task 2: migration 0009——children + attempts + llm_calls.modality

**Files:**
- Create: `pipeline/kb/migrations/0009_children_attempts.sql`
- Test: `pipeline/tests/test_db.py`（追加用例）

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_db.py` 追加：

```python
def test_children_attempts_after_0009(conn):
    """0009 后：children/attempts 表存在；result/error_cause 受控词表；级联删除。"""
    import uuid
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (name, grade) VALUES ('小宝','四年级') RETURNING id")
        child_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/a.pdf') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES (%s,%s,'exercise','1','题') RETURNING id",
            (str(uuid.uuid4()), doc_id),
        )
        item_id = str(cur.fetchone()[0])
        # 正常写入
        cur.execute(
            """INSERT INTO attempts (child_id, item_id, result, error_cause, note)
               VALUES (%s,%s,'wrong','粗心','竖式对位错')""",
            (child_id, item_id),
        )
        # 非法 result 被拒
        import pytest
        with pytest.raises(Exception):
            cur.execute(
                "INSERT INTO attempts (child_id, result) VALUES (%s,'unknown')", (child_id,))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py::test_children_attempts_after_0009 -q`
Expected: FAIL（children 表不存在）

- [ ] **Step 3: 写 migration**

`pipeline/kb/migrations/0009_children_attempts.sql`：

```sql
-- 孩子档案 + 做题记录（唯一事实表，追加式历史）
CREATE TABLE children (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    grade TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id UUID NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    result TEXT NOT NULL CHECK (result IN ('correct', 'wrong', 'partial')),
    error_cause TEXT CHECK (error_cause IN ('粗心', '概念不清', '方法不会', '计算错')),
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (item_id IS NOT NULL)  -- Phase 2 放宽：试卷题来源（paper_question_id）入库
);

-- token 计量区分文本/图像（试卷关联 paper_id 随 Phase 2 papers 表一起加）
ALTER TABLE llm_calls ADD COLUMN modality TEXT CHECK (modality IN ('text', 'image'));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py -q`
Expected: PASS（全文件）

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/migrations/0009_children_attempts.sql pipeline/tests/test_db.py
git commit -m "feat: children/attempts 表 + llm_calls.modality（0009）"
```

---

## Workstream B：docx 入库（Task 3-7）

详细设计见 `docs/superpowers/specs/2026-09-02-docx-ingest-design.md`。测试用 pandoc 现场合成 docx，不依赖真实样本。

---

### Task 3: migration 0010——chapters.content_md

**Files:**
- Create: `pipeline/kb/migrations/0010_chapters_content_md.sql`
- Test: `pipeline/tests/test_db.py`（追加）

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_db.py` 追加：

```python
def test_chapters_content_md_after_0010(conn):
    import uuid
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/d.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'大题一','# 一、选择题\n1. ...') RETURNING content_md""",
            (str(uuid.uuid4()), doc_id),
        )
        assert cur.fetchone()[0].startswith("# 一、")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py::test_chapters_content_md_after_0010 -q`
Expected: FAIL（column chapters.content_md does not exist）

- [ ] **Step 3: 写 migration**

`pipeline/kb/migrations/0010_chapters_content_md.sql`：

```sql
-- docx 入库：章节原文（PDF 章节为 NULL）
ALTER TABLE chapters ADD COLUMN content_md TEXT;
```

- [ ] **Step 4-5: 跑测试确认通过；Commit**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py -q`

```bash
git add pipeline/kb/migrations/0010_chapters_content_md.sql pipeline/tests/test_db.py
git commit -m "feat: chapters.content_md（0010，docx 章节原文）"
```

---

### Task 4: docx_ingest——pandoc 转换 + 按标题切章入库

**Files:**
- Create: `pipeline/kb/docx_ingest.py`
- Test: `pipeline/tests/test_docx_ingest.py`

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_docx_ingest.py`：

```python
"""docx 入库：pandoc 转 markdown -> 按标题切章 -> chapters.content_md + 章稿落盘。"""
import subprocess
import uuid

import pytest

from kb.config import Config

pandoc_missing = pytest.mark.skipif(
    subprocess.run(["which", "pandoc"], capture_output=True).returncode != 0,
    reason="需要 pandoc",
)


@pytest.fixture()
def docx_file(tmp_path):
    """pandoc 现场合成 docx：两个大题标题 + 卷首。"""
    md = tmp_path / "paper.md"
    md.write_text(
        "语法一阶 期末测试\n\n# 一、选择题\n\n1. He ___ to school by bus.\n\n# 二、填空题\n\n5. 用所给词的适当形式 ___ (go)。\n",
        encoding="utf-8",
    )
    docx = tmp_path / "paper.docx"
    subprocess.run(["pandoc", "-f", "gfm", "-t", "docx", "-o", str(docx), str(md)], check=True)
    return docx


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pandoc_missing
def test_ingest_docx_splits_chapters(conn, cfg, docx_file):
    from kb.docx_ingest import ingest_docx

    doc_id = ingest_docx(conn, cfg, docx_file, title="语法一阶 期末测试",
                         subject="英语", doc_type="exam")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no, title, content_md, page_start FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        rows = cur.fetchall()
    assert len(rows) == 2
    assert rows[0][1] == "一、选择题"
    assert "He ___ to school by bus" in rows[0][2]
    assert "语法一阶 期末测试" in rows[0][2]  # 卷首并入第一章
    assert rows[0][3] is None  # docx 无页码
    assert rows[1][1] == "二、填空题"
    # 章稿落盘
    c01 = cfg.storage_dir / doc_id / "chapters" / "c01.md"
    assert c01.exists() and "选择题" in c01.read_text(encoding="utf-8")
    # documents 行
    with conn.cursor() as cur:
        cur.execute("SELECT doc_type, subject, page_count FROM documents WHERE id=%s", (doc_id,))
        r = cur.fetchone()
    assert r == ("exam", "英语", 0)


def test_split_chapters_no_heading():
    """无标题文档整份为单章。"""
    from kb.docx_ingest import split_chapters

    chapters = split_chapters("纯文字没有标题\n第二行", "文档标题")
    assert chapters == [("文档标题", "纯文字没有标题\n第二行")]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_docx_ingest.py -q`
Expected: FAIL（ModuleNotFoundError: kb.docx_ingest）

- [ ] **Step 3: 实现**

`pipeline/kb/docx_ingest.py`：

```python
"""docx 入库：pandoc -> gfm markdown -> 按标题切章存 chapters.content_md。

docx 无页概念：不写 pages/blocks；图片 --extract-media 落 storage/<doc_id>/，
markdown 里的相对引用（media/...）相对该目录解析。
"""
from __future__ import annotations

import re
import subprocess
import uuid
from pathlib import Path

from kb.config import Config
from kb.export_md import export_chapter_mds

_HEADING_RE = re.compile(r"^#{1,2}\s+(.+?)\s*#*$", re.M)


def docx_to_markdown(docx_path, extract_dir: Path) -> str:
    """pandoc docx -> gfm；图片抽到 extract_dir（markdown 引用为其相对路径）。"""
    Path(extract_dir).mkdir(parents=True, exist_ok=True)
    out = subprocess.run(
        ["pandoc", "-f", "docx", "-t", "gfm", f"--extract-media={extract_dir}", str(docx_path)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise SystemExit(f"pandoc 转换失败: {out.stderr.strip()}")
    return out.stdout


def split_chapters(markdown: str, doc_title: str) -> list[tuple[str, str]]:
    """按一/二级标题切章，卷首并入第一章；无标题则整份单章。返回 [(title, content_md)]。"""
    matches = list(_HEADING_RE.finditer(markdown))
    if not matches:
        body = markdown.strip()
        return [(doc_title, body)] if body else []
    chapters = []
    for i, m in enumerate(matches):
        begin = 0 if i == 0 else m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        chapters.append((m.group(1).strip(), markdown[begin:end].strip()))
    return chapters


def ingest_docx(conn, cfg: Config, path, title: str,
                subject: str | None = None, grade: str | None = None,
                doc_type: str = "exam") -> str:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, grade, doc_type, source_path,
                                      page_count, has_text_layer, status)
               VALUES (%s,%s,%s,%s,%s,%s,0,true,'parsed') RETURNING id""",
            (str(uuid.uuid4()), title, subject, grade, doc_type, str(path)),
        )
        doc_id = str(cur.fetchone()[0])
    markdown = docx_to_markdown(path, Path(cfg.storage_dir) / doc_id)
    with conn.cursor() as cur:
        for i, (ch_title, content) in enumerate(split_chapters(markdown, title), start=1):
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (document_id, chapter_no) DO NOTHING""",
                (str(uuid.uuid4()), doc_id, i, ch_title, content),
            )
    export_chapter_mds(conn, cfg, doc_id)
    return doc_id
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_docx_ingest.py -q`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/docx_ingest.py pipeline/tests/test_docx_ingest.py
git commit -m "feat: docx 入库——pandoc 转 markdown 按标题切章存 chapters.content_md"
```

---

### Task 5: structure_chapter 支持 content_md 章节

**Files:**
- Modify: `pipeline/kb/structure.py`（`structure_chapter` 开头分支）
- Test: `pipeline/tests/test_structure.py`（追加）

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_structure.py` 追加（复用文件内 `_client`/`ITEMS_JSON` 风格，自造简易 fixture）：

```python
def test_structure_chapter_uses_content_md(conn, tmp_path):
    """docx 章（content_md 非空、页码 NULL）：直接拆章稿，不再因 page_start NULL 跳过。"""
    import uuid

    from kb.config import Config
    from kb.structure import structure_chapter

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/e.docx') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'选择题','# 一、选择题\n\n1. He ___ to school by bus.')""",
            (str(uuid.uuid4()), doc_id),
        )
    items_json = '[{"content_type":"exercise","label":"1","content_md":"He ___ to school by bus.","block_ids":[1]}]'
    n = structure_chapter(conn, cfg, doc_id, 1, client=_client(items_json))
    assert n == 1
    with conn.cursor() as cur:
        cur.execute("SELECT label, page_start FROM items WHERE document_id=%s", (doc_id,))
        label, page_start = cur.fetchone()
    assert label == "1" and page_start is None  # docx 条目无页码
```

（`_client` 是该测试文件已有的假客户端工厂。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_structure.py::test_structure_chapter_uses_content_md -q`
Expected: FAIL（n == 0，page_start NULL 被跳过）

- [ ] **Step 3: 实现——`structure.py` 改动**

`structure_chapter` 中章节查询加 `content_md`，并在取到行后分支：

```python
        cur.execute(
            """SELECT id, chapter_no, title, taxonomy, tags, page_start, page_end, content_md
               FROM chapters WHERE document_id=%s AND chapter_no=%s""",
            (doc_id, chapter_no),
        )
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"章节不存在: doc={doc_id} 第 {chapter_no} 章")
        _cid, _no, title, taxonomy, tags, page_start, page_end, content_md = row
```

原 `if page_start is None: return 0` 改为：

```python
        if page_start is None and not content_md:
            return 0  # 页面未入库，跳过（放量重跑时自动补）
```

`_chapter_blocks(...)` 调用处改为：

```python
        if content_md:
            # docx 章：整份章稿作窗口（单条伪块，block_id None 不进 item_blocks）
            blocks = [(None, "chapter", content_md)]
        else:
            blocks = _chapter_blocks(cur, doc_id, page_start, page_end)
```

（幂等检查、prompt 拼装、items 插入逻辑不变；items 的 page_start/page_end 对 docx 章自然为 NULL。）

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_structure.py -q`
Expected: 全过（含原有 PDF 路径用例）

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/structure.py pipeline/tests/test_structure.py
git commit -m "feat(structure): content_md 章节直接拆章稿（docx 入库路径）"
```

---

### Task 6: assemble_chapter 支持 content_md 章节

**Files:**
- Modify: `pipeline/kb/assemble.py`
- Test: `pipeline/tests/test_export_md.py`（追加）

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_export_md.py` 追加：

```python
def test_export_chapter_mds_for_docx_chapter(conn, tmp_path):
    """content_md 章（无页）：章稿直接取章原文。"""
    import uuid

    from kb.config import Config
    from kb.export_md import export_chapter_mds

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/f.docx') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'选择题','# 一、选择题\n\n1. 题干')""",
            (str(uuid.uuid4()), doc_id),
        )
    n = export_chapter_mds(conn, cfg, doc_id)
    assert n == 1
    text = (cfg.storage_dir / doc_id / "chapters" / "c01.md").read_text(encoding="utf-8")
    assert "题干" in text
```

注意：`export_chapter_mds` 现有 SQL 带 `page_start IS NOT NULL` 过滤，docx 章会被漏掉——实现时改为 `(page_start IS NOT NULL OR content_md IS NOT NULL)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_export_md.py::test_export_chapter_mds_for_docx_chapter -q`
Expected: FAIL（n == 0）

- [ ] **Step 3: 实现**

`pipeline/kb/assemble.py` 的 `assemble_chapter`：章节查询加 `content_md`，非空直接返回：

```python
        cur.execute(
            """SELECT page_start, page_end, content_md FROM chapters
               WHERE document_id=%s AND chapter_no=%s""",
            (doc_id, chapter_no),
        )
        row = cur.fetchone()
        if not row:
            return ""
        if row[2]:
            return row[2]  # docx 章：章稿即原文
        if row[0] is None:
            return ""
```

（函数后续行改用 row[0]/row[1] 作为页范围。）

`pipeline/kb/export_md.py` 的 `export_chapter_mds` SQL 改为：

```python
            """SELECT chapter_no FROM chapters
               WHERE document_id=%s AND (page_start IS NOT NULL OR content_md IS NOT NULL)
               ORDER BY chapter_no""",
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_export_md.py -q`

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/assemble.py pipeline/kb/export_md.py pipeline/tests/test_export_md.py
git commit -m "feat(assemble): content_md 章直接出章稿；export 覆盖无页 docx 章"
```

---

### Task 7: grounding 对 docx 条目以章原文为接地面 + cli ingest 分流

**Files:**
- Modify: `pipeline/kb/grounding.py`（`sync_item_grounding` 源文本回落）
- Modify: `pipeline/kb/cli.py`（ingest 按扩展名分流）
- Test: `pipeline/tests/test_grounding.py`（追加）

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_grounding.py` 追加：

```python
def test_grounding_docx_item_uses_chapter_content(conn):
    """无溯源块的 docx 条目：接地面为 chapters.content_md，不误报 no_source。"""
    import uuid

    from kb.grounding import sync_item_grounding

    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/g.docx') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'选择题','1. He goes to school by bus every day.')""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
               VALUES (%s,%s,'exercise','1','He goes to school by bus every day.','第 1 讲 选择题')
               RETURNING id""",
            (str(uuid.uuid4()), doc_id),
        )
        item_id = str(cur.fetchone()[0])
    n = sync_item_grounding(conn, item_id)
    assert n == 0  # 句子和章原文一致，无新增复核行
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM review_queue WHERE item_id=%s", (item_id,))
        assert cur.fetchone()[0] == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_grounding.py::test_grounding_docx_item_uses_chapter_content -q`
Expected: FAIL（报 `no_source:1`）

- [ ] **Step 3: 实现**

`pipeline/kb/grounding.py` 的 `sync_item_grounding`，在取 `sources` 之后加回落：

```python
        sources = [r[0] for r in cur.fetchall()]
        if not sources:
            # 无溯源块的条目（docx 路径）：以章原文为接地面
            cur.execute(
                """SELECT c.content_md FROM items i
                   JOIN chapters c ON c.document_id = i.document_id
                     AND i.chapter = '第 ' || c.chapter_no || ' 讲 ' || c.title
                   WHERE i.id=%s AND c.content_md IS NOT NULL""",
                (item_id,),
            )
            sources = [r[0] for r in cur.fetchall()]
```

`pipeline/kb/cli.py` 的 ingest 分支改为按扩展名分流：

```python
    elif args.cmd == "ingest":
        migrate(conn)
        if str(args.pdf).lower().endswith(".docx"):
            from kb.docx_ingest import ingest_docx
            doc_id = ingest_docx(conn, cfg, args.pdf, args.title,
                                 subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        else:
            doc_id = ingest(conn, cfg, args.pdf, args.title,
                            subject=args.subject, grade=args.grade, doc_type=args.doc_type,
                            start=args.start, end=args.end)
        print(f"完成 document_id={doc_id}")
```

cli 帮助文案里 `ingest <pdf>` 改为 `ingest <pdf|docx>`（参数名不动，避免破坏脚本）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全绿（136+ passed）

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/grounding.py pipeline/kb/cli.py pipeline/tests/test_grounding.py
git commit -m "feat: docx 条目接地对照章原文；ingest 按扩展名分流 docx"
```

---

## Workstream C：TS 后端（Task 8-12）

---

### Task 8: pipeline 内部服务 `/internal/rerank`

**Files:**
- Create: `pipeline/kb/internal_api.py`
- Modify: `pipeline/kb/cli.py`（加 `serve-internal` 子命令）
- Test: `pipeline/tests/test_internal_api.py`

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_internal_api.py`：

```python
"""内部服务：/internal/rerank 供 TS 双路召回调用（本地重排模型权重的唯一出口）。"""
import pytest
from fastapi.testclient import TestClient

from kb.internal_api import create_internal_app


class _FakeReranker:
    def compute_score(self, pairs):
        return [float(len(q) + len(d)) for q, d in pairs]  # 可预测的假分数


@pytest.fixture()
def client():
    return TestClient(create_internal_app(reranker_factory=lambda: _FakeReranker()))


def test_rerank_returns_scores(client):
    resp = client.post("/internal/rerank",
                       json={"query": "ab", "docs": ["x", "xyz"]})
    assert resp.status_code == 200
    assert resp.json()["scores"] == [3.0, 5.0]


def test_rerank_empty_docs(client):
    resp = client.post("/internal/rerank", json={"query": "q", "docs": []})
    assert resp.status_code == 200 and resp.json()["scores"] == []


def test_rerank_503_when_model_unavailable():
    """未装 rerank 依赖时返回 503（TS 侧据此降级为不重排）。"""
    app = create_internal_app(
        reranker_factory=lambda: (_ for _ in ()).throw(ImportError("no FlagEmbedding")))
    resp = TestClient(app).post("/internal/rerank", json={"query": "q", "docs": ["d"]})
    assert resp.status_code == 503
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q`
Expected: FAIL（ModuleNotFoundError: kb.internal_api）

- [ ] **Step 3: 实现**

`pipeline/kb/internal_api.py`：

```python
"""内部服务：只对 TS 后端暴露，不对前端。rerank 是唯一需要本地模型权重的环节。"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


class RerankRequest(BaseModel):
    query: str
    docs: list[str]


def create_internal_app(reranker_factory=None) -> FastAPI:
    """reranker_factory 可注入假实现；默认懒加载 kb.rerank.get_reranker。"""
    if reranker_factory is None:
        def reranker_factory():
            from kb.rerank import get_reranker
            return get_reranker()
    app = FastAPI(title="kb-internal", docs_url=None, redoc_url=None)

    @app.post("/internal/rerank")
    def rerank(body: RerankRequest):
        if not body.docs:
            return {"scores": []}
        try:
            reranker = reranker_factory()
        except ImportError as e:
            raise HTTPException(status_code=503, detail=f"重排模型不可用: {e}")
        scores = reranker.compute_score([(body.query, d) for d in body.docs])
        if not isinstance(scores, list):  # 单对时库返回标量
            scores = [scores]
        return {"scores": [float(s) for s in scores]}

    return app
```

`pipeline/kb/cli.py` 加子命令（argparse 区与分支区各加一段）：

```python
    p_internal = sub.add_parser("serve-internal", help="内部服务（/internal/rerank 等，只对 TS 后端）")
    p_internal.add_argument("--host", default="127.0.0.1")
    p_internal.add_argument("--port", type=int, default=8766)
```

```python
    if args.cmd == "serve-internal":
        import uvicorn
        from kb.internal_api import create_internal_app
        uvicorn.run(create_internal_app(), host=args.host, port=args.port)
        return
```

（注意放在 `cfg = load_config()` 之前的分支——与 review 命令同级，因为 rerank 不需要数据库配置。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/internal_api.py pipeline/kb/cli.py pipeline/tests/test_internal_api.py
git commit -m "feat: pipeline 内部服务 /internal/rerank（TS 召回链路的重排出口）"
```

---

### Task 9: backend/ TS 骨架 + 配置

**Files:**
- Create: `backend/package.json`、`backend/tsconfig.json`、`backend/vitest.config.ts`
- Create: `backend/src/config.ts`、`backend/src/db.ts`、`backend/src/index.ts`
- Test: `backend/src/config.test.ts`
- Create: `backend/.env.example`

- [ ] **Step 1: 初始化工程**

```bash
mkdir -p backend/src && cd backend
npm init -y
npm install hono @hono/node-server pg dotenv \
  @earendil-works/pi-agent-core @earendil-works/pi-ai
npm install -D typescript tsx vitest @types/pg @types/node
npm pkg set type=module \
  scripts.dev="tsx watch src/index.ts" \
  scripts.test="vitest run" \
  scripts.build="tsc -p tsconfig.json" \
  scripts.start="node dist/index.js"
```

`backend/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 写失败测试**

`backend/src/config.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("CHAT_* 留空时回落 DOC_OGNIZE_*，再回落 KB_VISION_*", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      DOC_OGNIZE_BASE_URL: "https://api.example.com/v1",
      DOC_OGNIZE_API_KEY: "sk-x",
      DOC_OGNIZE_MODEL: "qwen3-32b",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatBaseUrl).toBe("https://api.example.com/v1");
    expect(cfg.chatModel).toBe("qwen3-32b");
    expect(cfg.embedBaseUrl).toBe("http://localhost:11434");
    expect(cfg.pipelineUrl).toBe("http://127.0.0.1:8766");
    expect(cfg.rerankProvider).toBe("local");
  });

  it("CHAT_* 优先", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_BASE_URL: "https://chat.example.com/v1",
      CHAT_API_KEY: "sk-c",
      CHAT_MODEL: "deepseek-v3",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatModel).toBe("deepseek-v3");
  });

  it("缺 KB_DATABASE_URL 直接抛错", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/KB_DATABASE_URL/);
  });
});
```

Run: `cd backend && npm test`
Expected: FAIL（Cannot find module './config.js'）

- [ ] **Step 3: 实现**

`backend/src/config.ts`：

```typescript
/** 集中配置：全部走环境变量，与 pipeline 侧 .env 习惯一致。 */
import "dotenv/config";

export interface BackendConfig {
  databaseUrl: string;
  chatBaseUrl: string;
  chatApiKey: string;
  chatModel: string;
  embedBaseUrl: string;
  embedModel: string;
  pipelineUrl: string;
  rerankProvider: "local" | "none";
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const databaseUrl = env.KB_DATABASE_URL;
  if (!databaseUrl) throw new Error("缺少 KB_DATABASE_URL（如 postgresql://localhost/kb）");
  const visionBase = env.KB_VISION_BASE_URL ?? "http://localhost:11434/v1";
  return {
    databaseUrl,
    chatBaseUrl: env.CHAT_BASE_URL ?? env.DOC_OGNIZE_BASE_URL ?? visionBase,
    chatApiKey: env.CHAT_API_KEY ?? env.DOC_OGNIZE_API_KEY ?? env.KB_VISION_API_KEY ?? "ollama",
    chatModel: env.CHAT_MODEL ?? env.DOC_OGNIZE_MODEL ?? env.KB_VISION_MODEL ?? "qwen3:4b",
    embedBaseUrl: env.KB_EMBED_BASE_URL ?? "http://localhost:11434",
    embedModel: env.KB_EMBED_MODEL ?? "bge-m3",
    pipelineUrl: env.PIPELINE_INTERNAL_URL ?? "http://127.0.0.1:8766",
    rerankProvider: env.RERANK_PROVIDER === "none" ? "none" : "local",
    port: Number(env.BACKEND_PORT ?? 8787),
  };
}
```

`backend/src/db.ts`：

```typescript
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: databaseUrl });
  return pool;
}

/** 测试用：重置 schema 并重放 pipeline 侧 migrations（Python 是 schema 唯一主人）。 */
export async function resetDbForTest(databaseUrl: string): Promise<pg.Pool> {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const p = new pg.Pool({ connectionString: databaseUrl });
  await p.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const dir = join(__dirname, "../../pipeline/kb/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await p.query(readFileSync(join(dir, f), "utf-8"));
  }
  return p;
}
```

（vitest 下 `__dirname` 不可用——ESM 工程用 `new URL("../../pipeline/kb/migrations", import.meta.url)` 取路径，实现时按此调整。）

`backend/src/index.ts`（先只有健康检查，后续任务挂路由）：

```typescript
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";

export function createApp() {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  return app;
}

if (process.env.VITEST === undefined) {
  const cfg = loadConfig();
  serve({ fetch: createApp().fetch, port: cfg.port }, (info) => {
    console.log(`backend  listening on http://127.0.0.1:${info.port}`);
  });
}
```

`backend/.env.example`：

```
KB_DATABASE_URL=postgresql://localhost/kb
# 对话模型（留空回落 DOC_OGNIZE_*，再回落 KB_VISION_*）
CHAT_BASE_URL=
CHAT_API_KEY=
CHAT_MODEL=
DOC_OGNIZE_BASE_URL=
DOC_OGNIZE_API_KEY=
DOC_OGNIZE_MODEL=
KB_EMBED_BASE_URL=http://localhost:11434
KB_EMBED_MODEL=bge-m3
PIPELINE_INTERNAL_URL=http://127.0.0.1:8766
RERANK_PROVIDER=local  # local=调 pipeline /internal/rerank；none=不重排
BACKEND_PORT=8787
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npm test`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(backend): TS 服务骨架——Hono + 配置 + pg 连接 + 测试重放 migrations"
```

---

### Task 10: 双路召回（embed + vector + bm25 + RRF + rerank provider）

**Files:**
- Create: `backend/src/retrieval/embed.ts`、`backend/src/retrieval/bm25.ts`、`backend/src/retrieval/search.ts`、`backend/src/retrieval/rerank.ts`
- Test: `backend/src/retrieval/search.test.ts`、`backend/src/retrieval/bm25.test.ts`

**移植源（保持行为一致）：** `pipeline/kb/embed.py`（向量 SQL、RRF k=60、filters 精确匹配 meta）、`pipeline/kb/lexical.py`（分词：英数按词、CJK 二元组；BM25 k1=1.5 b=0.75）。

- [ ] **Step 1: 写失败测试**

`backend/src/retrieval/bm25.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { tokenize, bm25Score } from "./bm25.js";

describe("tokenize（与 pipeline kb/lexical.py 一致）", () => {
  it("英数按词、CJK 按二元组", () => {
    expect(tokenize("abc 竖式谜")).toEqual(["abc", "竖式", "式谜"]);
    expect(tokenize("例1 在下面方框")).toContain("1");
  });
});

describe("bm25Score", () => {
  it("命中文档分数高于未命中", () => {
    const docs = ["三位数乘两位数的竖式计算", "阅读理解练习"];
    const hits = bm25Score("竖式", docs);
    expect(hits[0].index).toBe(0);
    expect(hits[0].score).toBeGreaterThan(0);
  });
});
```

`backend/src/retrieval/search.test.ts`（真库，复用 `resetDbForTest`）：

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { hybridSearch, type SearchDeps } from "./search.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("hybridSearch（真库）", () => {
  let pool: pg.Pool;
  // chunks.embedding 是 vector(1024)：假向量必须补齐 1024 维
  const V1 = `[${[1, ...new Array(1023).fill(0)].join(",")}]`;
  const V2 = `[${[0, 1, ...new Array(1022).fill(0)].join(",")}]`;
  const deps: SearchDeps = {
    embed: async (_texts: string[]) => [[1, ...new Array(1023).fill(0)]], // 假向量：最接近 item1
    rerank: null,
  };
  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query(
      `INSERT INTO documents (id, title, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '书', '/tmp/x.pdf');
      INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'example', '例1', '三位数乘两位数 竖式'),
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'exercise', '2', '英语阅读理解');
      INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
         '三位数乘两位数 竖式', '{"doc_title":"书"}', $1::vector),
        ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
         '英语阅读理解', '{"doc_title":"书"}', $2::vector);`,
      [V1, V2],
    );
  });
  afterAll(() => pool.end());

  it("RRF 融合：向量与词法都命中者排最前", async () => {
    const hits = await hybridSearch(pool, deps, "竖式", { topK: 5 });
    expect(hits[0].label).toBe("例1");
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`backend/src/retrieval/bm25.ts`（逐行移植 `pipeline/kb/lexical.py`）：

```typescript
/** BM25 词法检索：移植 pipeline/kb/lexical.py（分词：英数按词，CJK 二元组）。 */
const RUN_RE = /[a-z0-9]+|[一-鿿]+/g;
const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const m of (text ?? "").toLowerCase().matchAll(RUN_RE)) {
    const t = m[0];
    if (t.length === 1 || /^[a-z0-9]+$/.test(t)) tokens.push(t);
    else for (let i = 0; i < t.length - 1; i++) tokens.push(t.slice(i, i + 2));
  }
  return tokens;
}

export interface ScoredDoc {
  index: number;
  score: number;
}

export function bm25Score(query: string, docs: string[], topK = 20): ScoredDoc[] {
  if (docs.length === 0) return [];
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(d)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const dls = tfs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
  const avgdl = dls.reduce((a, b) => a + b, 0) / docs.length;
  const df = new Map<string, number>();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const scored: ScoredDoc[] = tfs.map((tf, index) => {
    let score = 0;
    for (const t of tokenize(query)) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * dls[index]) / avgdl));
    }
    return { index, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}
```

`backend/src/retrieval/embed.ts`：

```typescript
/** query 向量化：直连 ollama 的 OpenAI 兼容端点（与 pipeline embed.py 同一渠道）。 */
export async function embedTexts(
  baseUrl: string,
  model: string,
  texts: string[],
): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {  // 逐条调用，与 Python 侧一致（批量接口各家不一致）
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
      body: JSON.stringify({ model, input: t }),
    });
    if (!resp.ok) throw new Error(`embed 失败: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as { data: { embedding: number[] }[] };
    out.push(data.data[0].embedding);
  }
  return out;
}
```

`backend/src/retrieval/rerank.ts`：

```typescript
/** reranker provider：local=调 pipeline /internal/rerank；none=不重排。
    后续接云重排（jina/cohere 等）在此加一个 provider 分支即可。 */
export type RerankFn = (query: string, docs: string[]) => Promise<number[]>;

export function makeReranker(provider: "local" | "none", pipelineUrl: string): RerankFn | null {
  if (provider === "none") return null;
  return async (query, docs) => {
    const resp = await fetch(`${pipelineUrl}/internal/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, docs }),
    });
    if (resp.status === 503) return docs.map(() => 0);  // 模型没装：降级为原顺序
    if (!resp.ok) throw new Error(`rerank 失败: ${resp.status}`);
    return ((await resp.json()) as { scores: number[] }).scores;
  };
}
```

`backend/src/retrieval/search.ts`：

```typescript
/** 双路召回：向量（pgvector）+ BM25（内存）→ RRF k=60 融合 → 可选重排。
    行为对齐 pipeline/kb/embed.py 的 search(mode='hybrid')。 */
import type pg from "pg";
import { bm25Score } from "./bm25.js";

export interface SearchHit {
  item_id: string;
  content_md: string;
  score: number;
  rerank_score?: number;
  [k: string]: unknown;  // meta 展开（label/chapter/subject/doc_title 等）
}

export interface SearchDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  rerank: ((query: string, docs: string[]) => Promise<number[]>) | null;
}

interface ChunkRow {
  item_id: string;
  content_md: string;
  meta: Record<string, unknown>;
  score?: number;
}

async function vectorHits(pool: pg.Pool, vec: number[], topN: number): Promise<ChunkRow[]> {
  const { rows } = await pool.query(
    `SELECT c.item_id, c.content_md, c.meta,
            1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c ORDER BY c.embedding <=> $1::vector LIMIT $2`,
    [`[${vec.join(",")}]`, topN],
  );
  return rows;
}

function toHit(r: ChunkRow): SearchHit {
  return { item_id: r.item_id, content_md: r.content_md, score: r.score ?? 0, ...r.meta };
}

export async function hybridSearch(
  pool: pg.Pool,
  deps: SearchDeps,
  query: string,
  opts: { topK?: number; filters?: Record<string, string> } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const [vec] = await deps.embed([query]);
  const vecHits = await vectorHits(pool, vec, 20);
  const { rows: allChunks } = await pool.query(
    "SELECT item_id, content_md, meta FROM chunks",
  );
  const lexOrder = bm25Score(query, allChunks.map((r: ChunkRow) => r.content_md), 20);

  const rrf = new Map<string, SearchHit>();
  vecHits.forEach((r, rank) => {
    const h = rrf.get(r.item_id) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(r.item_id, h);
  });
  lexOrder.forEach(({ index }, rank) => {
    const r = allChunks[index];
    const h = rrf.get(r.item_id) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(r.item_id, h);
  });

  let candidates = [...rrf.values()].sort((a, b) => b.score - a.score);
  const filters = opts.filters ?? {};
  candidates = candidates.filter((h) =>
    Object.entries(filters).every(([k, v]) => h[k] === v),
  );

  if (deps.rerank && candidates.length > 0) {
    const poolN = candidates.slice(0, Math.max(topK, 10));
    const scores = await deps.rerank(query, poolN.map((h) => h.content_md));
    poolN.forEach((h, i) => (h.rerank_score = scores[i]));
    poolN.sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
    candidates = poolN;
  }
  return candidates.slice(0, topK);
}
```

注：测试里 1024 维假向量的构造——`deps.embed` 返回 `[1, ...Array(1023).fill(0)]`，插入用 `'[' || array_fill 或 SQL 里 string_to_array`；实现时用
`const v1 = [1, ...new Array(1023).fill(0)].join(",")` 拼 `[${v1}]::vector` 即可。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全过

- [ ] **Step 5: Commit**

```bash
git add backend/src/retrieval/
git commit -m "feat(backend): 双路召回——ollama embed + pgvector/BM25 + RRF k=60 + rerank provider"
```

---

### Task 11: agent 工具 + /api/chat（SSE）

**Files:**
- Create: `backend/src/agent/tools.ts`、`backend/src/agent/chat.ts`
- Modify: `backend/src/index.ts`（挂路由）
- Test: `backend/src/agent/tools.test.ts`、`backend/src/agent/chat.test.ts`

**pi-agent 用法依据（已核实官方 README，`earendil-works/pi`）：**
- `Agent`：`new Agent({ initialState: { systemPrompt, model, tools }, streamFn: models.streamSimple.bind(models) })`；`agent.subscribe(event => ...)` 收事件（`message_update` 时 `event.assistantMessageEvent.type === "text_delta"` 取增量）；`await agent.prompt(text)`。
- 工具：`AgentTool = { name, description, parameters: Type.Object({...}), execute: async (toolCallId, params, signal, onUpdate) => ({ content: [{ type: "text", text }] }) }`；失败**抛异常**（agent 会作为 tool error 回给模型）。
- 自定义 OpenAI 兼容端点：`createProvider({ id, name, baseUrl, auth, models: [model], api: openAICompletionsApi() })`，`openAICompletionsApi` 从 `@earendil-works/pi-ai/api/openai-completions.lazy` 导入；静态 key 用 `auth: { apiKey: { name: "chat", resolve: async () => ({ auth: { apiKey } }) } }`。
- token 计量：assistant 最终消息带 `usage.input / usage.output`；在 `message_end`（role=assistant）时累加，`agent_end` 时写一行 `llm_calls`。
- 若安装版本的 API 与本计划不一致，以 `node_modules/@earendil-works/pi-agent-core/README.md` 为准修正。

- [ ] **Step 1: 写失败测试**

`backend/src/agent/tools.test.ts`：

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { makeTools, type ToolDeps } from "./tools.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("agent 工具（真库）", () => {
  let pool: pg.Pool;
  let deps: ToolDeps;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query(`
      INSERT INTO children (id, name, grade) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '小宝', '四年级');
      INSERT INTO documents (id, title, subject, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '7星学霸', '数学', '/tmp/x.pdf');
      INSERT INTO items (id, document_id, content_type, label, content_md, chapter, qc_status) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
         'example', '例1', '竖式谜例题与解析', '第 1 讲 竖式谜', 'approved');
      INSERT INTO attempts (child_id, item_id, result, error_cause) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'wrong', '粗心');
    `);
    deps = {
      pool,
      search: async () => [{
        item_id: "22222222-2222-2222-2222-222222222222",
        content_md: "竖式谜例题与解析", score: 0.9,
        label: "例1", chapter: "第 1 讲 竖式谜", doc_title: "7星学霸",
      }],
    };
  });
  afterAll(() => pool.end());

  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = makeTools(deps).find((t) => t.name === name)!;
    const result = await tool.execute("tc1", params, new AbortController().signal);
    return result.content[0].type === "text" ? result.content[0].text : "";
  };

  it("list_children", async () => {
    const text = await run("list_children", {});
    expect(text).toContain("小宝");
  });

  it("search_items 走注入的检索并带出处", async () => {
    const text = await run("search_items", { query: "竖式谜" });
    expect(text).toContain("例1").and.toContain("7星学霸");
  });

  it("get_item 返回条目详情", async () => {
    const text = await run("get_item", { item_id: "22222222-2222-2222-2222-222222222222" });
    expect(text).toContain("竖式谜例题与解析");
  });

  it("get_child_progress 汇总做题记录", async () => {
    const text = await run("get_child_progress", { child_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    expect(text).toContain("错").and.toContain("粗心");
  });
});
```

`backend/src/agent/chat.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { chatRoute } from "./chat.js";
import type { AgentFactory } from "./chat.js";

describe("/api/chat", () => {
  it("SSE 流出 text_delta 并收尾 done", async () => {
    // 假 agent：按 pi-agent-core 事件形状推两个 delta
    const fakeFactory: AgentFactory = () => ({
      subscribe: (fn) => {
        queueMicrotask(async () => {
          await fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } });
          await fn({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "呀" } });
          await fn({ type: "agent_end", messages: [] });
        });
        return () => {};
      },
      prompt: async () => {},
    });
    const app = new Hono();
    app.post("/api/chat", chatRoute(fakeFactory));
    const resp = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const body = await resp.text();
    expect(body).toContain("你好").and.toContain("呀");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`backend/src/agent/tools.ts`：

```typescript
/** agent 检索工具集（只读）：搜题库 / 看条目 / 孩子列表 / 孩子进展。
    Type 用 pi-ai 的再导出（pi-ai README 明确 re-export Type/Static/TSchema）。 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import type { SearchHit } from "../retrieval/search.js";

export interface ToolDeps {
  pool: pg.Pool;
  search: (query: string, filters?: Record<string, string>) => Promise<SearchHit[]>;
}

const toText = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export function makeTools(deps: ToolDeps): AgentTool[] {
  return [
    {
      name: "search_items",
      label: "搜题库",
      description: "语义检索题库条目（例题讲解/练习/答案），可按科目、章节过滤",
      parameters: Type.Object({
        query: Type.String({ description: "检索问题" }),
        subject: Type.Optional(Type.String({ description: "科目过滤，如 数学" })),
        chapter: Type.Optional(Type.String({ description: "章节过滤" })),
      }),
      execute: async (_id, params) => {
        const filters: Record<string, string> = {};
        if (params.subject) filters.subject = params.subject;
        if (params.chapter) filters.chapter = params.chapter;
        const hits = await deps.search(params.query, filters);
        if (hits.length === 0) return toText("题库里没有找到相关内容。");
        return toText(hits.map((h, i) =>
          `【${i + 1}】${h.label ?? ""}（${h.doc_title} · ${h.chapter}）\n${h.content_md}`,
        ).join("\n\n"));
      },
    },
    {
      name: "get_item",
      label: "看条目",
      description: "按 item_id 取条目完整内容（题干/讲解/答案、章节、标签）",
      parameters: Type.Object({ item_id: Type.String() }),
      execute: async (_id, params) => {
        const { rows } = await deps.pool.query(
          `SELECT i.content_type, i.label, i.content_md, i.chapter, i.taxonomy, i.tags, d.title
           FROM items i JOIN documents d ON d.id = i.document_id WHERE i.id = $1`,
          [params.item_id],
        );
        if (rows.length === 0) throw new Error(`条目不存在: ${params.item_id}`);
        const r = rows[0];
        return toText(
          `${r.label}（${r.title} · ${r.chapter} · ${r.content_type}）\n${r.content_md}`,
        );
      },
    },
    {
      name: "list_children",
      label: "孩子列表",
      description: "列出所有孩子（id、姓名、年级）",
      parameters: Type.Object({}),
      execute: async () => {
        const { rows } = await deps.pool.query(
          "SELECT id, name, grade FROM children ORDER BY created_at",
        );
        if (rows.length === 0) return toText("还没有孩子档案。");
        return toText(rows.map((r) => `${r.name}（${r.grade ?? "未填年级"}，id: ${r.id}）`).join("\n"));
      },
    },
    {
      name: "get_child_progress",
      label: "孩子进展",
      description: "某孩子的做题记录统计：总数、对错分布、错因分布、最近错题",
      parameters: Type.Object({ child_id: Type.String() }),
      execute: async (_id, params) => {
        const { rows: totals } = await deps.pool.query(
          `SELECT count(*) AS n,
                  count(*) FILTER (WHERE result='correct') AS correct,
                  count(*) FILTER (WHERE result='wrong') AS wrong,
                  count(*) FILTER (WHERE result='partial') AS partial
           FROM attempts WHERE child_id=$1`,
          [params.child_id],
        );
        const { rows: causes } = await deps.pool.query(
          `SELECT error_cause, count(*) AS n FROM attempts
           WHERE child_id=$1 AND error_cause IS NOT NULL
           GROUP BY error_cause ORDER BY n DESC`,
          [params.child_id],
        );
        const { rows: recent } = await deps.pool.query(
          `SELECT i.label, i.chapter, a.result, a.error_cause, a.created_at
           FROM attempts a LEFT JOIN items i ON i.id = a.item_id
           WHERE a.child_id=$1 AND a.result <> 'correct'
           ORDER BY a.created_at DESC LIMIT 10`,
          [params.child_id],
        );
        const t = totals[0];
        const resultLabel: Record<string, string> = { correct: "对", wrong: "错", partial: "半对" };
        const lines = [
          `做题 ${t.n} 道：对 ${t.correct}、错 ${t.wrong}、半对 ${t.partial}`,
          causes.length ? `错因分布：${causes.map((c) => `${c.error_cause}×${c.n}`).join("、")}` : "",
          recent.length
            ? "最近错题：\n" + recent.map((r) =>
                `- ${r.label ?? "?"}（${r.chapter ?? "?"}）${resultLabel[r.result]}${r.error_cause ? " · " + r.error_cause : ""}`,
              ).join("\n")
            : "",
        ].filter(Boolean);
        return toText(lines.join("\n"));
      },
    },
  ];
}
```

`backend/src/agent/chat.ts`：

```typescript
/** /api/chat：pi-agent 驱动的 SSE 聊天。token 消耗写 llm_calls（modality='text'）。 */
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type pg from "pg";
import type { BackendConfig } from "../config.js";
import { makeTools } from "./tools.js";
import type { SearchHit } from "../retrieval/search.js";

const SYSTEM_PROMPT = `你是家庭学习助手。家长会上传孩子的学习资料和试卷，你基于题库和孩子的做题记录回答问题。
规则：题目内容必须来自检索结果，引用时给出来源（书名·章节·题号）；不知道就说不知道，不要编题。
数学内容用 LaTeX（行内 $...$）。回答简洁、口语化，对家长说话。`;

export interface AgentLike {
  subscribe: (fn: (event: any) => void | Promise<void>) => () => void;
  prompt: (text: string) => Promise<void>;
}
export type AgentFactory = (messages: { role: string; content: string }[]) => AgentLike;

export function makeAgentFactory(
  cfg: BackendConfig,
  pool: pg.Pool,
  search: (q: string, f?: Record<string, string>) => Promise<SearchHit[]>,
): AgentFactory {
  const model: Model<"openai-completions"> = {
    id: cfg.chatModel,
    name: cfg.chatModel,
    api: "openai-completions",
    provider: "chat",
    baseUrl: cfg.chatBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "chat",
    name: "chat",
    baseUrl: cfg.chatBaseUrl,
    auth: { apiKey: { name: "chat", resolve: async () => ({ auth: { apiKey: cfg.chatApiKey } }) } },
    models: [model],
    api: openAICompletionsApi(),
  }));
  const tools = makeTools({ pool, search });

  return (messages) => {
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        tools,
        messages: messages.map((m) => ({ ...m, timestamp: Date.now() })) as any,
      },
      streamFn: models.streamSimple.bind(models),
    });
    return agent as unknown as AgentLike;
  };
}

export function chatRoute(
  factory: AgentFactory,
  onUsage?: (usage: { input: number; output: number }) => Promise<void>,
) {
  return (c: Context) => {
    return streamSSE(c, async (stream) => {
      const { messages } = await c.req.json();
      if (!Array.isArray(messages) || messages.length === 0) {
        await stream.writeSSE({ event: "error", data: "messages 不能为空" });
        return;
      }
      const last = messages[messages.length - 1];
      const history = messages.slice(0, -1);
      const agent = factory(history);
      let usage = { input: 0, output: 0 };
      agent.subscribe(async (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          await stream.writeSSE({ event: "delta", data: JSON.stringify(event.assistantMessageEvent.delta) });
        }
        if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
          usage.input += event.message.usage.input ?? 0;
          usage.output += event.message.usage.output ?? 0;
        }
        if (event.type === "agent_end") {
          if (onUsage && (usage.input || usage.output)) await onUsage(usage);
          await stream.writeSSE({ event: "done", data: "" });
        }
      });
      await agent.prompt(last.content);
    });
  };
}
```

`backend/src/index.ts` 挂路由（在 createApp 内）：

```typescript
import { getPool } from "./db.js";
import { chatRoute, makeAgentFactory } from "./agent/chat.js";
import { hybridSearch } from "./retrieval/search.js";
import { embedTexts } from "./retrieval/embed.js";
import { makeReranker } from "./retrieval/rerank.js";

export function createApp(cfg = loadConfig()) {
  const app = new Hono();
  const pool = getPool(cfg.databaseUrl);
  const rerank = makeReranker(cfg.rerankProvider, cfg.pipelineUrl);
  const search = (q: string, filters?: Record<string, string>) =>
    hybridSearch(pool, {
      embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
      rerank,
    }, q, { filters });
  const factory = makeAgentFactory(cfg, pool, search);
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/chat", chatRoute(factory, async (u) => {
    await pool.query(
      `INSERT INTO llm_calls (document_id, purpose, model, modality, prompt_tokens, completion_tokens)
       VALUES (NULL, 'chat', $1, 'text', $2, $3)`,
      [cfg.chatModel, u.input, u.output],
    );
  }));
  return app;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全过

- [ ] **Step 5: 手动验证真实链路（ollama 在线时）**

```bash
cd pipeline && uv run python -m kb.cli serve-internal &   # rerank 服务（可选）
cd backend && npm run dev &
curl -N -X POST http://127.0.0.1:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"题库里有哪些例题？"}]}'
```

Expected: SSE 流出 delta 事件 + done；`llm_calls` 表新增一行 purpose='chat'、modality='text'。

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/ backend/src/index.ts
git commit -m "feat(backend): pi-agent 聊天 /api/chat（SSE）+ 检索工具集 + token 计量"
```

---

### Task 12: 孩子与做题记录 API

**Files:**
- Create: `backend/src/routes/children.ts`、`backend/src/routes/attempts.ts`
- Modify: `backend/src/index.ts`（挂路由）
- Test: `backend/src/routes/attempts.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/src/routes/attempts.test.ts`：

```typescript
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { Hono } from "hono";
import { childrenRoutes } from "./children.js";
import { attemptsRoutes } from "./attempts.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("children/attempts API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/children", childrenRoutes(pool));
    app.route("/api/attempts", attemptsRoutes(pool));
    await pool.query(`
      INSERT INTO documents (id, title, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111', '书', '/tmp/x.pdf');
      INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'exercise', '1', '题');
    `);
  });
  afterAll(() => pool.end());

  it("建孩子 -> 标记做题 -> 查记录", async () => {
    const created = await app.request("/api/children", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "小宝", grade: "四年级" }),
    });
    expect(created.status).toBe(201);
    const child = await created.json();

    const marked = await app.request("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        child_id: child.id,
        item_id: "22222222-2222-2222-2222-222222222222",
        result: "wrong", error_cause: "粗心", note: "竖式对位错",
      }),
    });
    expect(marked.status).toBe(201);

    const bad = await app.request("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child_id: child.id, item_id: "22222222-2222-2222-2222-222222222222", result: "unknown" }),
    });
    expect(bad.status).toBe(422);

    const list = await app.request(`/api/attempts?child_id=${child.id}`);
    const data = await list.json();
    expect(data.attempts).toHaveLength(1);
    expect(data.attempts[0].error_cause).toBe("粗心");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`backend/src/routes/children.ts`（子路由一律 `new Hono({ strict: false })`，避免挂载后尾斜杠不匹配）：

```typescript
import { Hono } from "hono";
import type pg from "pg";

export function childrenRoutes(pool: pg.Pool): Hono {
  const app = new Hono();
  app.get("/", async (c) => {
    const { rows } = await pool.query("SELECT id, name, grade FROM children ORDER BY created_at");
    return c.json({ children: rows });
  });
  app.post("/", async (c) => {
    const { name, grade } = await c.req.json();
    if (!name?.trim()) return c.json({ error: "name 不能为空" }, 422);
    const { rows } = await pool.query(
      "INSERT INTO children (name, grade) VALUES ($1, $2) RETURNING id, name, grade",
      [name.trim(), grade ?? null],
    );
    return c.json(rows[0], 201);
  });
  return app;
}
```

`backend/src/routes/attempts.ts`（词表与 SQL CHECK 保持一致：correct/wrong/partial；粗心/概念不清/方法不会/计算错）：

```typescript
import { Hono } from "hono";
import type pg from "pg";

const RESULTS = new Set(["correct", "wrong", "partial"]);
const CAUSES = new Set(["粗心", "概念不清", "方法不会", "计算错"]);

export function attemptsRoutes(pool: pg.Pool): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.child_id || !body.item_id || !RESULTS.has(body.result)) {
      return c.json({ error: "child_id/item_id/result(correct|wrong|partial) 必填" }, 422);
    }
    if (body.error_cause != null && !CAUSES.has(body.error_cause)) {
      return c.json({ error: "error_cause 取值: 粗心/概念不清/方法不会/计算错" }, 422);
    }
    const { rows } = await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [body.child_id, body.item_id, body.result, body.error_cause ?? null, body.note ?? null],
    );
    return c.json(rows[0], 201);
  });
  app.get("/", async (c) => {
    const childId = c.req.query("child_id");
    if (!childId) return c.json({ error: "child_id 必填" }, 422);
    const { rows } = await pool.query(
      `SELECT a.id, a.result, a.error_cause, a.note, a.created_at,
              i.label, i.chapter, i.content_md
       FROM attempts a LEFT JOIN items i ON i.id = a.item_id
       WHERE a.child_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
      [childId],
    );
    return c.json({ attempts: rows });
  });
  return app;
}
```

`backend/src/index.ts` 的 createApp 内加：

```typescript
import { childrenRoutes } from "./routes/children.js";
import { attemptsRoutes } from "./routes/attempts.js";
// ...
  app.route("/api/children", childrenRoutes(pool));
  app.route("/api/attempts", attemptsRoutes(pool));
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/ backend/src/index.ts
git commit -m "feat(backend): children/attempts API——孩子档案与做题标记"
```

---

## Workstream D：前端与收尾（Task 13-14）

### Task 13: frontend/ React 骨架 + 聊天页

视觉以 `frontend/prototype/index.html` 为准（已确认），本期只实现聊天视图，其余视图留占位。

**Files:**
- Create: `frontend/`（Vite react-ts 脚手架产物）
- Create: `frontend/src/api/chat.ts`（SSE 客户端）
- Create: `frontend/src/App.tsx`、`frontend/src/components/Rail.tsx`、`frontend/src/views/ChatView.tsx`、`frontend/src/components/MessageBubble.tsx`、`frontend/src/components/Composer.tsx`
- Create: `frontend/src/theme.css`（原型 `:root` 设计令牌 + 红笔批注组件样式原样移植）
- Test: `frontend/src/api/chat.test.ts`

- [ ] **Step 1: 脚手架**

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend && npm install && npm install katex && npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

`frontend/vite.config.ts` 加 proxy（开发期转发到 TS 后端）：

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "jsdom" },
});
```

- [ ] **Step 2: 写失败测试——SSE 客户端**

`frontend/src/api/chat.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { streamChat } from "./chat";

function sseResponse(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

describe("streamChat", () => {
  it("解析 delta 事件并回调，done 收尾", async () => {
    const events = [
      'event: delta\ndata: "你"\n\n',
      'event: delta\ndata: "好"\n\n',
      "event: done\ndata: \n\n",
    ];
    const deltas: string[] = [];
    let done = false;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => (done = true) },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toBe(true);
  });
});
```

- [ ] **Step 3: 实现**

`frontend/src/api/chat.ts`：

```typescript
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (message: string) => void;
}

type FetchLike = typeof fetch;

export async function streamChat(
  messages: ChatMessage[],
  handlers: ChatHandlers,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const resp = await fetchImpl("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!resp.ok || !resp.body) {
    handlers.onError?.(`请求失败: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1] ?? "";
      if (event === "delta") handlers.onDelta(JSON.parse(data));
      if (event === "done") handlers.onDone();
      if (event === "error") handlers.onError?.(data);
    }
  }
}
```

组件拆分（视觉与文案逐行取自 `frontend/prototype/index.html`，不改设计）：

- `theme.css`：原型 `<style>` 的 `:root` 令牌、`.pen-circle`/`.pen-underline`/`.mark`、rail/topbar/composer 样式原样搬运。
- `App.tsx`：左 rail（本期只有"聊天"可用，其余 nav 项 disabled 标"待建设"）+ 顶栏（标题/日期/孩子切换占位）。
- `ChatView.tsx`：消息流（用户右、助手左，助手头像"答"），`useState<ChatMessage[]>` + 流式追加；`streamChat` 驱动。
- `Composer.tsx`：输入框 + 发送按钮；空输入不发送。
- KaTeX：助手消息渲染时 `$...$` 走 `katex.renderToString(tex, { throwOnError: false })`（原型同款正则替换逻辑，抽到 `src/lib/katex.tsx`，用 `dangerouslySetInnerHTML` 渲染，输入仅来自后端助手消息）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npm test`
Expected: 1 passed

- [ ] **Step 5: 端到端冒烟（三个进程）**

```bash
cd pipeline && uv run python -m kb.cli serve-internal &
cd backend && npm run dev &
cd frontend && npm run dev
# 浏览器开 http://127.0.0.1:5173，发一条消息，确认流式输出
```

Expected: 聊天页流式出字；后端 `llm_calls` 增一行。

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): React 骨架 + 聊天页（SSE 流式，原型视觉）"
```

---

### Task 14: 根 AGENTS.md + 开发文档

**Files:**
- Create: `AGENTS.md`（仓库根）
- Modify: `README.md`（开发启动方式）

- [ ] **Step 1: 写 AGENTS.md**

```markdown
# 家庭学习知识库

双栈：`frontend/`（React+Vite）、`backend/`（TS：pi-agent + 产品 API + 双路召回）、`pipeline/`（Python：解析管线 + migrations + rerank 服务）。

## 资料入库工作流

用户提供文档（PDF/docx）要求入库时：

1. 先从文件名和内容推断 `--subject`（语文/数学/英语/…）与 `--type`（workbook 练习册 / exam 试卷）。
2. **科目判断不了就先提问让用户选**，确认后再执行，不要猜。
3. 入库命令（在 pipeline/ 下）：
   `uv run python -m kb.cli ingest <文件> --title <书名> --subject <科目> --type <类型>`
   pdf 与 docx 同一条命令，按扩展名自动分流。
4. 完成后跑 `structure` 拆条、`export` 落盘镜像。

## 开发启动

- pipeline：`cd pipeline && uv run pytest tests/`（测试需 KB_TEST_DATABASE_URL）
- backend：`cd backend && npm test` / `npm run dev`（8787）
- frontend：`cd frontend && npm run dev`（5173，proxy 到 8787）

## 边界纪律

- schema 只能由 pipeline/kb/migrations/ 变更。
- 检索主链路的向量/BM25 在 backend（TS）；只有 rerank 调 pipeline 的 /internal/rerank。
- DB 内容的事实来源是 PostgreSQL；storage/ 下的 md 是只写镜像。
```

- [ ] **Step 2: README 补"开发启动"一节**（同上三条命令）

- [ ] **Step 3: 全量回归 + Commit**

```bash
cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q
cd ../backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test
cd ../frontend && npm test
```

```bash
git add AGENTS.md README.md
git commit -m "docs: 根 AGENTS.md（入库工作流+边界纪律）与开发启动说明"
```

---

## 完成判定（Phase 1 DoD）

- [ ] `pipeline/` 下 Python 测试全绿；`backend/` 与 `frontend/` 测试全绿
- [ ] docx 可入库并拆条：`kb.cli ingest xx.docx` → chapters.content_md → structure → items
- [ ] 聊天页可对话，agent 会调 search_items/get_item/list_children/get_child_progress
- [ ] token 计量含 modality；聊天调用写 llm_calls
- [ ] attempts 可经 API 写入并按孩子查询

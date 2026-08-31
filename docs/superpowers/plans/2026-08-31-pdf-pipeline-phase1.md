# PDF 解析流水线 · 骨架期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建流水线骨架：pg 数据模型 + 五阶段框架（渲染→整页版面→视觉解析→质检→复核队列）+ CLI + 黄金集回归工具，用整页解析端到端跑通一本真实 PDF。

**Architecture:** 新包 `kb/`（与根目录探索性脚本隔离），配置全部走 `.env`；阶段输入输出落 PostgreSQL（含 pgvector 扩展，本期只建表不做向量），任何阶段可断点重跑。本期版面分析用整页占位实现（`WholePageLayout`），接口按可插拔设计，精度期换 PaddleOCR-VL 不动其他阶段。

**Tech Stack:** Python 3.13 / uv / pymupdf / openai(兼容客户端) / psycopg[binary] / pgvector / python-dotenv / pytest。

**范围说明（对应设计文档 §9）：** 本计划只覆盖骨架期。设计文档全量 schema（含 items/item_blocks/item_embeddings/review_queue）本期一次建齐；结构化拆分（④条目化）、TOC 词表、PaddleOCR-VL 版面分析属精度期计划；向量化和检索属检索期计划。本期"端到端"= PDF → 数据库中可查询、可复核的页面级内容。

**规格来源:** `docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md`

---

### Task 1: 项目骨架与配置加载

**Files:**
- Modify: `pyproject.toml`
- Create: `kb/__init__.py`
- Create: `kb/config.py`
- Create: `tests/__init__.py`
- Create: `tests/test_config.py`
- Create: `.env.example`

- [ ] **Step 1: 加依赖并写失败测试**

`pyproject.toml` 的 dependencies 改为：

```toml
dependencies = [
    "pymupdf>=1.28.2",
    "rapidocr-onnxruntime>=1.4.4",
    "openai>=1.40.0",
    "psycopg[binary]>=3.2",
    "pgvector>=0.3",
    "python-dotenv>=1.0",
]
```

并新增：

```toml
[dependency-groups]
dev = ["pytest>=8.0"]
```

`tests/test_config.py`：

```python
import pytest

from kb.config import load_config


def test_load_config_defaults(tmp_path, monkeypatch):
    monkeypatch.delenv("KB_DATABASE_URL", raising=False)
    monkeypatch.delenv("KB_VISION_BASE_URL", raising=False)
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.database_url == "postgresql://localhost/kb_test"
    assert cfg.vision_base_url == "http://localhost:11434/v1"
    assert cfg.vision_model == "qwen3:4b"
    assert cfg.dpi == 200


def test_load_config_requires_database_url(tmp_path, monkeypatch):
    monkeypatch.delenv("KB_DATABASE_URL", raising=False)
    with pytest.raises(SystemExit):
        load_config(tmp_path / "不存在.env")
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv sync && uv run pytest tests/test_config.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'kb'`

- [ ] **Step 3: 实现 config 与包骨架**

`kb/__init__.py`：空文件。

`kb/config.py`：

```python
"""集中配置：模型与端点全部走 .env / 环境变量，不写死。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    database_url: str
    storage_dir: Path
    vision_base_url: str
    vision_api_key: str
    vision_model: str
    dpi: int = 200


def load_config(env_path: str | os.PathLike[str] = ".env") -> Config:
    load_dotenv(env_path)
    db = os.environ.get("KB_DATABASE_URL")
    if not db:
        raise SystemExit("缺少 KB_DATABASE_URL（如 postgresql://localhost/kb）")
    return Config(
        database_url=db,
        storage_dir=Path(os.environ.get("KB_STORAGE_DIR", "storage")),
        vision_base_url=os.environ.get("KB_VISION_BASE_URL", "http://localhost:11434/v1"),
        vision_api_key=os.environ.get("KB_VISION_API_KEY", "ollama"),
        vision_model=os.environ.get("KB_VISION_MODEL", "qwen3:4b"),
        dpi=int(os.environ.get("KB_DPI", "200")),
    )
```

`.env.example`：

```
KB_DATABASE_URL=postgresql://localhost/kb
KB_STORAGE_DIR=storage
# 视觉模型（本地 ollama 或远端 OpenAI 兼容端点）
KB_VISION_BASE_URL=http://localhost:11434/v1
KB_VISION_API_KEY=ollama
KB_VISION_MODEL=qwen3:4b
KB_DPI=200
```

`tests/__init__.py`：空文件。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_config.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml uv.lock kb/ tests/ .env.example
git commit -m "feat: kb 包骨架与 .env 配置加载"
```

---

### Task 2: 数据库 schema 与 migration runner

**Files:**
- Create: `kb/db.py`
- Create: `kb/migrations/0001_init.sql`
- Create: `tests/conftest.py`
- Create: `tests/test_db.py`

- [ ] **Step 1: 准备测试库**

Run: `createdb kb_test`（本地 pg；已存在则跳过）
并约定测试用库：`export KB_TEST_DATABASE_URL=postgresql://localhost/kb_test`

写 `tests/conftest.py`：

```python
import os

import psycopg
import pytest

from kb.db import migrate


@pytest.fixture()
def conn():
    url = os.environ.get("KB_TEST_DATABASE_URL")
    if not url:
        pytest.skip("需要 KB_TEST_DATABASE_URL（如 postgresql://localhost/kb_test）")
    c = psycopg.connect(url, autocommit=True)
    migrate(c)  # 保证 schema 存在
    yield c
    # 每个测试后清表，保证隔离
    with c.cursor() as cur:
        cur.execute("""
            TRUNCATE review_queue, item_embeddings, item_blocks, items,
                     blocks, pages, documents, schema_migrations CASCADE
        """)
    c.close()
```

写失败测试 `tests/test_db.py`：

```python
def test_migrate_creates_tables(conn):
    from kb.db import migrate
    ran = migrate(conn)
    assert "0001_init.sql" in ran
    with conn.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN
              ('documents', 'pages', 'blocks', 'items', 'item_blocks',
               'item_embeddings', 'review_queue', 'schema_migrations')
        """)
        assert cur.fetchall().__len__() == 8


def test_migrate_is_idempotent(conn):
    from kb.db import migrate
    migrate(conn)
    assert migrate(conn) == []
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_db.py -v`
Expected: FAIL，`No module named 'kb.db'`

- [ ] **Step 3: 实现 db.py 与 0001_init.sql**

`kb/db.py`：

```python
"""pg 连接与 migration 执行（migrations/*.sql 按文件名顺序，已执行的跳过）。"""
from __future__ import annotations

from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def connect(database_url: str) -> psycopg.Connection:
    return psycopg.connect(database_url, autocommit=True)


def migrate(conn: psycopg.Connection) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
        applied = {r[0] for r in cur.execute("SELECT name FROM schema_migrations")}
        ran = []
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in applied:
                continue
            cur.execute(path.read_text(encoding="utf-8"))
            cur.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            ran.append(path.name)
        return ran
```

`kb/migrations/0001_init.sql`：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    subject TEXT,
    grade TEXT,
    term TEXT,
    edition TEXT,
    doc_type TEXT NOT NULL DEFAULT 'workbook'
        CHECK (doc_type IN ('workbook', 'exam')),
    source_path TEXT NOT NULL UNIQUE,
    page_count INTEGER NOT NULL DEFAULT 0,
    has_text_layer BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_no INTEGER NOT NULL,
    image_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'rendered', 'parsed', 'failed')),
    parse_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, page_no)
);

CREATE TABLE blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    block_type TEXT NOT NULL
        CHECK (block_type IN ('page', 'text', 'formula', 'figure', 'table', 'header', 'footer')),
    bbox JSONB,
    crop_path TEXT NOT NULL,
    content_md TEXT,
    qc_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL
        CHECK (content_type IN ('example', 'exercise', 'answer')),
    label TEXT,
    content_md TEXT,
    paired_item_id UUID REFERENCES items(id),
    subject TEXT,
    grade TEXT,
    chapter TEXT,
    taxonomy TEXT,
    tags TEXT[],
    difficulty INTEGER,
    page_start INTEGER,
    page_end INTEGER,
    qc_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (qc_status IN ('pending', 'auto_passed', 'needs_review', 'approved', 'rejected')),
    qc_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE item_blocks (
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    block_id UUID NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('stem', 'figure', 'solution')),
    PRIMARY KEY (item_id, block_id, role)
);

CREATE TABLE item_embeddings (
    item_id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    embedding vector(1024)
);

CREATE TABLE review_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    block_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

注意：`CREATE EXTENSION vector` 需要 pgvector 已装入本地 pg；若执行报 `extension "vector" is not available`，先装：`brew install pgvector && createdb 重建或手动 CREATE EXTENSION`。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_db.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add kb/db.py kb/migrations/0001_init.sql tests/conftest.py tests/test_db.py
git commit -m "feat: pg schema(含 pgvector)与 migration runner"
```

---

### Task 3: 阶段①渲染（render.py）

**Files:**
- Create: `kb/render.py`
- Create: `tests/test_render.py`

- [ ] **Step 1: 写失败测试**

`tests/test_render.py`：

```python
import fitz
import pytest

from kb.config import Config
from kb.render import detect_text_layer, render_document


@pytest.fixture()
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def text_pdf(tmp_path):
    p = tmp_path / "text.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "你好，世界")
    doc.save(p)
    return p


@pytest.fixture()
def scanned_pdf(tmp_path):
    p = tmp_path / "scan.pdf"
    doc = fitz.open()
    doc.new_page()
    doc.new_page()
    doc.save(p)
    return p


def test_detect_text_layer(text_pdf, scanned_pdf):
    assert detect_text_layer(fitz.open(text_pdf)) is True
    assert detect_text_layer(fitz.open(scanned_pdf)) is False


def test_render_document_creates_rows_and_images(conn, cfg, scanned_pdf):
    doc_id = render_document(conn, cfg, scanned_pdf, title="测试卷", doc_type="exam")
    with conn.cursor() as cur:
        cur.execute("SELECT page_count, has_text_layer FROM documents WHERE id=%s", (doc_id,))
        page_count, has_tl = cur.fetchone()
        assert (page_count, has_tl) == (2, False)
        cur.execute("SELECT page_no, image_path, status FROM pages ORDER BY page_no")
        rows = cur.fetchall()
    assert [r[0] for r in rows] == [1, 2]
    assert all(r[2] == "rendered" for r in rows)
    for _, img, _ in rows:
        assert (cfg.storage_dir.parent / img).exists()


def test_render_document_is_idempotent(conn, cfg, scanned_pdf):
    id1 = render_document(conn, cfg, scanned_pdf, title="测试卷", doc_type="exam")
    id2 = render_document(conn, cfg, scanned_pdf, title="测试卷", doc_type="exam")
    assert id1 == id2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pages WHERE document_id=%s", (id1,))
        assert cur.fetchone()[0] == 2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_render.py -v`
Expected: FAIL，`No module named 'kb.render'`

- [ ] **Step 3: 实现 render.py**

```python
"""阶段①渲染：文本层检测 + 每页渲染为 PNG，落库 documents/pages。幂等可重跑。"""
from __future__ import annotations

import uuid

import fitz  # PyMuPDF

from kb.config import Config


def detect_text_layer(doc: fitz.Document) -> bool:
    return any(page.get_text().strip() for page in doc)


def render_document(
    conn,
    cfg: Config,
    pdf_path,
    title: str,
    subject: str | None = None,
    grade: str | None = None,
    doc_type: str = "workbook",
) -> str:
    pdf_path = str(pdf_path)
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM documents WHERE source_path=%s", (pdf_path,))
        row = cur.fetchone()
    doc = fitz.open(pdf_path)
    if row:
        doc_id = str(row[0])
    else:
        doc_id = str(uuid.uuid4())
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO documents
                   (id, title, subject, grade, doc_type, source_path, page_count,
                    has_text_layer, status)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'rendered')""",
                (doc_id, title, subject, grade, doc_type, pdf_path,
                 doc.page_count, detect_text_layer(doc)),
            )
    pages_dir = cfg.storage_dir / doc_id / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_no FROM pages WHERE document_id=%s AND status='rendered'",
            (doc_id,),
        )
        done = {r[0] for r in cur.fetchall()}
        for i in range(doc.page_count):
            page_no = i + 1
            img_rel = str(pages_dir / f"p{page_no:04d}.png")
            if page_no not in done:
                pix = doc[i].get_pixmap(dpi=cfg.dpi)
                pix.save(img_rel)
                cur.execute(
                    """INSERT INTO pages (document_id, page_no, image_path, status)
                       VALUES (%s,%s,%s,'rendered')
                       ON CONFLICT (document_id, page_no)
                       DO UPDATE SET image_path=EXCLUDED.image_path, status='rendered'""",
                    (doc_id, page_no, img_rel),
                )
    return doc_id
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_render.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add kb/render.py tests/test_render.py
git commit -m "feat: 阶段①渲染与文本层检测，幂等落库"
```

---

### Task 4: 阶段②版面分析（layout.py，整页占位实现）

**Files:**
- Create: `kb/layout.py`
- Create: `tests/test_layout.py`

- [ ] **Step 1: 写失败测试**

`tests/test_layout.py`：

```python
import fitz
import pytest

from kb.config import Config
from kb.layout import WholePageLayout, run_layout
from kb.render import render_document


@pytest.fixture()
def doc_id(conn, tmp_path):
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "scan.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    return render_document(conn, cfg, p, title="t"), cfg


def test_whole_page_layout_returns_single_block(doc_id):
    _id, cfg = doc_id
    draft = WholePageLayout().analyze("page-1", f"{cfg.storage_dir}/x/p0001.png")
    assert len(draft) == 1
    assert draft[0].block_type == "page"
    assert draft[0].bbox is None


def test_run_layout_inserts_blocks_idempotent(doc_id, conn):
    _id, _cfg = doc_id
    assert run_layout(conn, _id) == 2
    assert run_layout(conn, _id) == 0  # 幂等：已有 blocks 的页跳过
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_layout.py -v`
Expected: FAIL，`No module named 'kb.layout'`

- [ ] **Step 3: 实现 layout.py**

```python
"""阶段②版面分析：可插拔协议 + 整页占位实现（精度期换 PaddleOCR-VL，接口不变）。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Protocol


@dataclass
class BlockDraft:
    page_id: str
    block_type: str
    bbox: tuple[float, float, float, float] | None = None
    crop_path: str


class LayoutAnalyzer(Protocol):
    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]: ...


class WholePageLayout:
    """骨架期占位：整页算一个 block，crop 直接用页面图。"""

    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        return [BlockDraft(page_id=page_id, block_type="page", bbox=None, crop_path=image_path)]


def run_layout(conn, doc_id: str, analyzer: LayoutAnalyzer | None = None) -> int:
    analyzer = analyzer or WholePageLayout()
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.id, p.image_path FROM pages p
               WHERE p.document_id=%s AND p.status='rendered'
               AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id=p.id)
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for page_id, image_path in rows:
            for draft in analyzer.analyze(str(page_id), image_path):
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), page_id, draft.block_type, draft.bbox, draft.crop_path),
                )
                n += 1
    return n
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_layout.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add kb/layout.py tests/test_layout.py
git commit -m "feat: 阶段②版面分析协议与整页占位实现"
```

---

### Task 5: 阶段③视觉解析（parse.py）

**Files:**
- Create: `kb/parse.py`
- Create: `tests/test_parse.py`

- [ ] **Step 1: 写失败测试**

`tests/test_parse.py`：

```python
import fitz
import pytest

from kb.config import Config


def _cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def parsed_doc(conn, tmp_path):
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "scan.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    return doc_id, cfg


class FakeMessage:
    content = "转录结果 $1+1=2$"


class FakeChoice:
    message = FakeMessage()


class FakeResponse:
    choices = [FakeChoice()]


class FakeChat:
    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            assert model == "qwen3:4b"
            return FakeResponse()


class FakeClient:
    chat = FakeChat()


def test_transcribe_image_calls_openai_compatible_api(tmp_path):
    from kb.parse import transcribe_image

    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG fake")
    text = transcribe_image(FakeClient(), "qwen3:4b", img)
    assert text == "转录结果 $1+1=2$"


def test_run_parse_fills_block_content_and_marks_page(conn, parsed_doc):
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    n = run_parse(conn, cfg, doc_id, client=FakeClient())
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM blocks WHERE content_md IS NOT NULL")
        assert cur.fetchone()[0] == 2
        cur.execute("SELECT status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}


def test_run_parse_failure_marks_page_failed(conn, parsed_doc):
    from kb.parse import run_parse

    class BoomChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                raise RuntimeError("模型挂了")

    class BoomClient:
        chat = BoomChat()

    doc_id, cfg = parsed_doc
    n = run_parse(conn, cfg, doc_id, client=BoomClient())
    assert n == 0
    with conn.cursor() as cur:
        cur.execute("SELECT status, parse_error FROM pages WHERE document_id=%s", (doc_id,))
        rows = cur.fetchall()
    assert all(s == "failed" and "模型挂了" in (e or "") for s, e in rows)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_parse.py -v`
Expected: FAIL，`No module named 'kb.parse'`

- [ ] **Step 3: 实现 parse.py**

```python
"""阶段③解析：视觉模型（OpenAI 兼容端点，本地/远端由配置决定）转录区块图像。"""
from __future__ import annotations

import base64
from pathlib import Path

from openai import OpenAI

from kb.config import Config

TRANSCRIBE_PROMPT = (
    "请完整转录这张页面上的所有文字内容，保持原有阅读顺序"
    "（从上到下、从左到右）。\n"
    "不要丢失也不要编造页面上没有的内容；"
    "如果页面含多个栏块，请按顺序逐块列出。\n"
    "特别注意：如果内容包含数学公式、表达式、算式、符号等，"
    "必须一律使用 LaTeX 表达——行内公式用 $...$，独立公式块用 $$...$$，"
    "确保公式可被标准 LaTeX 渲染器正确还原。"
)


def transcribe_image(client, model: str, image_path, prompt: str = TRANSCRIBE_PROMPT) -> str:
    b64 = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
    resp = client.chat.completions.create(
        model=model,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
        max_tokens=4096,
    )
    return resp.choices[0].message.content


def run_parse(conn, cfg: Config, doc_id: str, client=None) -> int:
    """转录所有未解析的 block；单页失败只记 parse_error，不中断。返回成功解析的 block 数。"""
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.crop_path, b.page_id FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND b.content_md IS NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for block_id, crop_path, page_id in rows:
            try:
                text = transcribe_image(client, cfg.vision_model, crop_path)
            except Exception as e:  # noqa: BLE001 - 单页失败不中断
                cur.execute(
                    "UPDATE pages SET status='failed', parse_error=%s WHERE id=%s",
                    (str(e)[:500], page_id),
                )
                continue
            cur.execute("UPDATE blocks SET content_md=%s WHERE id=%s", (text, block_id))
            cur.execute("UPDATE pages SET status='parsed', parse_error=NULL WHERE id=%s", (page_id,))
            n += 1
    return n
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_parse.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add kb/parse.py tests/test_parse.py
git commit -m "feat: 阶段③视觉解析，OpenAI 兼容端点，失败不中断"
```

---

### Task 6: 阶段⑤质检 lite（qc.py）

**Files:**
- Create: `kb/qc.py`
- Create: `tests/test_qc.py`

- [ ] **Step 1: 写失败测试**

`tests/test_qc.py`：

```python
import fitz
import pytest


def test_check_content_flags_empty():
    from kb.qc import check_content
    assert check_content("") == ["empty"]
    assert check_content("   \n ") == ["empty"]


def test_check_content_flags_truncation():
    from kb.qc import check_content
    assert "maybe_truncated" in check_content("解答过程类似猜谜语游戏，")
    assert check_content("完整的句子。") == []


def test_run_qc_inserts_review_rows(conn, tmp_path):
    from kb.config import Config
    from kb.layout import run_layout
    from kb.qc import run_qc
    from kb.render import render_document

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "s.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md=''")  # 模拟空转录
    assert run_qc(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue")
        assert cur.fetchone()[0] == "empty"
    assert run_qc(conn, doc_id) == 0  # 幂等
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_qc.py -v`
Expected: FAIL，`No module named 'kb.qc'`

- [ ] **Step 3: 实现 qc.py**

```python
"""阶段⑤质检（骨架期 lite）：空转录/疑似截断 → review_queue。
精度期扩展：LaTeX 编译检查、题号连续性、置信分阈值分流。"""
from __future__ import annotations

import uuid

_TRUNCATION_ENDINGS = ("…", "...", "，", "、", "；", "：")


def check_content(content: str | None) -> list[str]:
    if not content or not content.strip():
        return ["empty"]
    reasons = []
    if content.rstrip().endswith(_TRUNCATION_ENDINGS):
        reasons.append("maybe_truncated")
    return reasons


def run_qc(conn, doc_id: str) -> int:
    """对低质 block 建复核记录（同一 block 同一原因不重复）。返回新增条数。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.content_md FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND p.status IN ('parsed', 'failed')""",
            (doc_id,),
        )
        n = 0
        for block_id, content in cur.fetchall():
            for reason in check_content(content):
                cur.execute(
                    """SELECT 1 FROM review_queue WHERE block_id=%s AND reason=%s""",
                    (block_id, reason),
                )
                if cur.fetchone():
                    continue
                cur.execute(
                    "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,%s)",
                    (str(uuid.uuid4()), block_id, reason),
                )
                n += 1
    return n
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_qc.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add kb/qc.py tests/test_qc.py
git commit -m "feat: 阶段⑤质检 lite，低质 block 进复核队列"
```

---

### Task 7: 流水线编排与 CLI（pipeline.py + cli.py）

**Files:**
- Create: `kb/pipeline.py`
- Create: `kb/cli.py`
- Create: `tests/test_pipeline.py`

- [ ] **Step 1: 写失败测试**

`tests/test_pipeline.py`：

```python
import fitz

from kb.config import Config


class FakeMessage:
    content = "转录结果"


class FakeChoice:
    message = FakeMessage()


class FakeChat:
    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            class R:
                choices = [FakeChoice()]
            return R()


class FakeClient:
    chat = FakeChat()


def test_ingest_end_to_end(conn, tmp_path):
    from kb.pipeline import ingest

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "book.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    doc_id = ingest(conn, cfg, p, title="7星学霸", subject="数学", grade="四年级",
                    client=FakeClient())
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}
        cur.execute("SELECT count(*) FROM blocks WHERE content_md='转录结果'")
        assert cur.fetchone()[0] == 2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_pipeline.py -v`
Expected: FAIL，`No module named 'kb.pipeline'`

- [ ] **Step 3: 实现 pipeline.py 与 cli.py**

`kb/pipeline.py`：

```python
"""流水线编排：渲染 → 版面 → 解析 → 质检，各阶段幂等可断点重跑。"""
from __future__ import annotations

from kb.config import Config
from kb.layout import run_layout
from kb.parse import run_parse
from kb.qc import run_qc
from kb.render import render_document


def ingest(conn, cfg: Config, pdf_path, title: str,
           subject: str | None = None, grade: str | None = None,
           doc_type: str = "workbook", client=None) -> str:
    doc_id = render_document(conn, cfg, pdf_path, title, subject, grade, doc_type)
    run_layout(conn, doc_id)
    run_parse(conn, cfg, doc_id, client=client)
    run_qc(conn, doc_id)
    return doc_id
```

`kb/cli.py`：

```python
"""命令行入口。

用法:
  uv run python -m kb.cli migrate
  uv run python -m kb.cli ingest <pdf> --title 书名 [--subject 数学] [--grade 四年级] [--type workbook|exam]
  uv run python -m kb.cli status
"""
from __future__ import annotations

import argparse

from kb.config import load_config
from kb.db import connect, migrate
from kb.pipeline import ingest


def main() -> None:
    ap = argparse.ArgumentParser(prog="kb")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    p_ingest = sub.add_parser("ingest")
    p_ingest.add_argument("pdf")
    p_ingest.add_argument("--title", required=True)
    p_ingest.add_argument("--subject", default=None)
    p_ingest.add_argument("--grade", default=None)
    p_ingest.add_argument("--type", dest="doc_type", default="workbook",
                          choices=["workbook", "exam"])
    sub.add_parser("status")
    args = ap.parse_args()

    cfg = load_config()
    conn = connect(cfg.database_url)
    if args.cmd == "migrate":
        print("已执行 migration:", migrate(conn) or "（无新增）")
    elif args.cmd == "ingest":
        migrate(conn)
        doc_id = ingest(conn, cfg, args.pdf, args.title,
                        subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        print(f"完成 document_id={doc_id}")
    elif args.cmd == "status":
        with conn.cursor() as cur:
            cur.execute(
                """SELECT d.title, d.status,
                          count(p.id) FILTER (WHERE p.status='parsed') AS parsed,
                          count(p.id) AS total
                   FROM documents d LEFT JOIN pages p ON p.document_id=d.id
                   GROUP BY d.title, d.status ORDER BY d.created_at"""
            )
            for title, status, parsed, total in cur.fetchall():
                print(f"{title}\t{status}\t{parsed}/{total} 页已解析")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_pipeline.py -v`
Expected: 1 passed；再跑全量 `uv run pytest -v`（约 13 个用例）全绿

- [ ] **Step 5: Commit**

```bash
git add kb/pipeline.py kb/cli.py tests/test_pipeline.py
git commit -m "feat: 流水线编排与 CLI(migrate/ingest/status)"
```

---

### Task 8: 黄金集工具（golden.py）

**Files:**
- Create: `kb/golden.py`
- Create: `tests/test_golden.py`

- [ ] **Step 1: 写失败测试**

`tests/test_golden.py`：

```python
from kb.golden import char_error_rate, normalize


def test_normalize_strips_whitespace():
    assert normalize("第 1 讲\n\n乘除法") == "第1讲乘除法"


def test_char_error_rate():
    assert char_error_rate("abcd", "abcd") == 0.0
    assert 0.0 < char_error_rate("abcd", "ab") < 1.0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_golden.py -v`
Expected: FAIL，`No module named 'kb.golden'`

- [ ] **Step 3: 实现 golden.py**

```python
"""黄金集工具。

golden extract: 把指定页当前解析结果导出为 golden/<doc_id>/pNNNN.md，人工逐字校对。
golden check:  重新转录黄金页（不写库），与校对稿做归一化字符级比对，报告 CER。
精度期的验收指标（区块识别率/条目一致率）在此工具上扩展。
"""
from __future__ import annotations

import difflib
from pathlib import Path


def normalize(text: str) -> str:
    return "".join(text.split())


def char_error_rate(expected: str, actual: str) -> float:
    expected, actual = normalize(expected), normalize(actual)
    if not expected:
        return 0.0 if not actual else 1.0
    return 1.0 - difflib.SequenceMatcher(None, expected, actual).ratio()


def extract(conn, doc_id: str, golden_dir: Path) -> list[Path]:
    golden_dir = golden_dir / doc_id
    golden_dir.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.page_no, b.content_md FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND b.content_md IS NOT NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        out = []
        for page_no, content in cur.fetchall():
            path = golden_dir / f"p{page_no:04d}.md"
            path.write_text(content, encoding="utf-8")
            out.append(path)
    return out


def check(conn, cfg, doc_id: str, golden_dir: Path) -> float:
    """重转录黄金页并比对。返回平均 CER，打印逐页结果。"""
    from kb.parse import transcribe_image
    from openai import OpenAI

    client = OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    golden_dir = golden_dir / doc_id
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_no, image_path FROM pages WHERE document_id=%s ORDER BY page_no",
            (doc_id,),
        )
        pages = dict(cur.fetchall())
    rates = []
    for golden_file in sorted(golden_dir.glob("p*.md")):
        page_no = int(golden_file.stem[1:])
        actual = transcribe_image(client, cfg.vision_model, pages[page_no])
        rate = char_error_rate(golden_file.read_text(encoding="utf-8"), actual)
        rates.append(rate)
        print(f"page {page_no}: CER={rate:.3f}")
    avg = sum(rates) / len(rates) if rates else 1.0
    print(f"平均 CER={avg:.3f}（{len(rates)} 页）")
    return avg
```

并在 `kb/cli.py` 顶部加 `from pathlib import Path`，然后加两个子命令（在 `main()` 的 `sub.add_parser("status")` 后追加，并在分发处补两个 elif）：

```python
    p_golden = sub.add_parser("golden-extract")
    p_golden.add_argument("doc_id")
    p_golden.add_argument("--dir", default="golden")
    p_check = sub.add_parser("golden-check")
    p_check.add_argument("doc_id")
    p_check.add_argument("--dir", default="golden")
```

分发处：

```python
    elif args.cmd == "golden-extract":
        from kb.golden import extract
        out = extract(conn, args.doc_id, Path(args.dir))
        print(f"导出 {len(out)} 页黄金稿，请人工校对: {args.dir}/{args.doc_id}/")
    elif args.cmd == "golden-check":
        from kb.golden import check
        check(conn, cfg, args.doc_id, Path(args.dir))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_golden.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add kb/golden.py kb/cli.py tests/test_golden.py
git commit -m "feat: 黄金集导出/回归工具（CER 比对）"
```

---

### Task 9: 端到端验证与文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 建库并迁移**

```bash
createdb kb 2>/dev/null; cp .env.example .env  # 按需改成真实端点
uv run python -m kb.cli migrate
```

Expected: 输出 `已执行 migration: ['0001_init.sql']`

- [ ] **Step 2: 用真实 PDF 跑端到端（小范围）**

用《7星学霸》前几页验证（该 PDF 前两页是封面等，第 6 页起是正文第 1 讲）：

```bash
uv run python -m kb.cli ingest "resources/2025秋7星学霸题中题数学4年级第7辑.pdf" \
  --title "7星学霸题中题数学4年级第7辑" --subject 数学 --grade 四年级
uv run python -m kb.cli status
```

Expected: status 显示 `已解析页数 = 总页数`；`SELECT count(*) FROM review_queue` 只含空页/截断页。

注：本步骤需要本地 ollama qwen3:4b 在线，或把 `.env` 指向远端端点；150+ 页全量转录耗时较长，可先在 `kb/cli.py ingest` 加 `--start/--end` 参数只跑前几页验证（若加此参数，同步在 `render_document` 里只渲染指定页范围，并补一个测试）。

- [ ] **Step 3: 建黄金集**

```bash
uv run python -m kb.cli golden-extract <doc_id>
# 人工校对 golden/<doc_id>/p0006.md、p0007.md 等关键页（第 1 讲正文），与 resources/ 下原图逐字核对
uv run python -m kb.cli golden-check <doc_id>
```

Expected: 关键页 CER 打印输出，作为精度期的基线记录。

- [ ] **Step 4: 写 README 用法**

`README.md`：

````markdown
# kids-knowledge-base

小孩学习资料知识库：扫描版习题 PDF → 结构化条目 → 混合检索。

## 流水线（骨架期）

```bash
uv sync
createdb kb && cp .env.example .env   # 配置视觉模型端点
uv run python -m kb.cli migrate
uv run python -m kb.cli ingest <pdf> --title 书名 --subject 数学 --grade 四年级
uv run python -m kb.cli status
uv run pytest                          # 测试需 KB_TEST_DATABASE_URL
```

设计文档：`docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md`
````

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README 流水线用法"
```

---

## Self-Review 记录

- **规格覆盖**：schema 五表 + review_queue（Task 2）✓；渲染+文本层检测（Task 3）✓；版面协议+占位（Task 4）✓；视觉解析可配置（Task 5）✓；质检 lite+复核队列（Task 6）✓；断点续跑/幂等（各阶段测试）✓；黄金集（Task 8）✓；分期边界（范围说明）✓。结构化拆分/TOC/PaddleOCR/向量化明确划到精度期与检索期计划，非本计划缺口。
- **占位符扫描**：无 TBD/TODO；每个代码步骤均含完整代码。
- **类型一致性**：`Config` 字段、`render_document(conn, cfg, pdf_path, title, subject, grade, doc_type)`、`run_layout(conn, doc_id, analyzer=None)`、`run_parse(conn, cfg, doc_id, client=None)`、`run_qc(conn, doc_id)`、`extract(conn, doc_id, golden_dir)`、`check(conn, cfg, doc_id, golden_dir)` 在定义处与调用处一致。

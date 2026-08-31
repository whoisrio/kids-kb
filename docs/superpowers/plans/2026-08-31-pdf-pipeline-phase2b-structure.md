# PDF 解析流水线 · 精度期 2b 实施计划（结构化拆分）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把区块级内容组装成结构化条目（items）：目录解析出章节与分类词表 → 章节窗口（跨页合并）→ LLM 拆条 → 答案配对 → 题号连续性质检。

**Architecture:** 新增 `chapters` 表承载目录词表（taxonomy/tags 的唯一事实来源）；`kb/toc.py` 用视觉模型读目录页；`kb/structure.py` 按章节窗口喂纯文本模型拆条，输出 JSON 校验后写 `items` + `item_blocks`。全部走配置化模型端点，可断点重跑（已结构化的章节跳过）。

**Tech Stack:** 现有栈；无新依赖。

**规格来源:** `docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md` §3④（含跨页合并）、§6 存储设计。

**前置状态（2a 已交付）:** `blocks` 有 block_type（page/title/text/formula/figure/table/header/footer）、bbox、crop_path、content_md；`items`/`item_blocks`/`review_queue` 表已建。

---

### Task 1: chapters 表 + structure_model 配置

**Files:**
- Create: `backend/kb/migrations/0003_chapters.sql`
- Modify: `backend/kb/config.py`
- Modify: `backend/tests/test_db.py`
- Modify: `backend/tests/test_config.py`
- Modify: `backend/.env.example`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_db.py` 追加：

```python
def test_chapters_table_after_0003(conn):
    from kb.db import migrate
    migrate(conn)
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/x.pdf') RETURNING id")
        doc_id = cur.fetchone()[0]
        cur.execute(
            """INSERT INTO chapters (document_id, chapter_no, title, print_page, taxonomy, tags)
               VALUES (%s, 1, '乘除法竖式谜', 1, '计算类', ARRAY['倒推法','枚举法']) RETURNING id""",
            (doc_id,),
        )
        cid = cur.fetchone()[0]
        cur.execute("SELECT title, tags FROM chapters WHERE id=%s", (cid,))
        assert cur.fetchone() == ("乘除法竖式谜", ["倒推法", "枚举法"])
```

`backend/tests/test_config.py` 追加：

```python
def test_load_config_structure_model(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_STRUCTURE_MODEL", raising=False)
    assert load_config(tmp_path / "不存在.env").structure_model is None
    monkeypatch.setenv("KB_STRUCTURE_MODEL", "qwen3.8-27b")
    assert load_config(tmp_path / "不存在.env").structure_model == "qwen3.8-27b"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py::test_chapters_table_after_0003 tests/test_config.py::test_load_config_structure_model -v`
Expected: FAIL（chapters 表不存在 / `structure_model` 属性不存在）

- [ ] **Step 3: 实现**

`backend/kb/migrations/0003_chapters.sql`：

```sql
CREATE TABLE chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chapter_no INTEGER NOT NULL,
    title TEXT NOT NULL,
    print_page INTEGER,
    taxonomy TEXT,
    tags TEXT[],
    page_start INTEGER,
    page_end INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, chapter_no)
);
```

`backend/kb/config.py`：`Config` 加字段 `structure_model: str | None = None`；`load_config` 返回里加 `structure_model=os.environ.get("KB_STRUCTURE_MODEL") or None,`。

`backend/.env.example` 加：

```
KB_STRUCTURE_MODEL=  # 结构化拆分用的文本模型，留空则复用 KB_VISION_MODEL
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_db.py tests/test_config.py -v`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add backend/kb/migrations/0003_chapters.sql backend/kb/config.py backend/tests/test_db.py backend/tests/test_config.py backend/.env.example
git commit -m "feat: chapters 表（目录词表）与 KB_STRUCTURE_MODEL 配置"
```

---

### Task 2: 目录解析（kb/toc.py）

**Files:**
- Create: `backend/kb/toc.py`
- Create: `backend/tests/test_toc.py`

**设计:** 目录页用视觉模型读（带坐标都行，这里只要文本 JSON）。页码自动探测：前 15 页中块文本含"目录"的页；也可 `--toc-pages` 显式指定。幂等：已有章节的文档直接跳过。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_toc.py`：

```python
import pymupdf as fitz
import pytest


def _cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def doc_with_toc(conn, tmp_path):
    """1 本书：第 1 页是目录（块文本含"目录"），共 3 页。"""
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "book.pdf"
    d = fitz.open()
    for _ in range(3):
        d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute(
            """UPDATE blocks SET content_md='目录 第 1 讲 xxx' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=1)"""
        )
    return doc_id, cfg


_FENCE = "`" * 3
TOC_JSON = _FENCE + "json\n" + (
    '[{"chapter_no": 1, "title": "乘除法竖式谜", "print_page": 1, "taxonomy": "计算类", "tags": ["倒推法", "枚举法"]},'
    '{"chapter_no": 2, "title": "三角形", "print_page": 10, "taxonomy": "几何类", "tags": ["构造思想"]}]'
) + "\n" + _FENCE


def _client(text):
    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client()


def test_parse_json_array_strips_code_fence():
    from kb.toc import _parse_json_array
    data = _parse_json_array(TOC_JSON)
    assert data[0]["title"] == "乘除法竖式谜"
    assert data[1]["tags"] == ["构造思想"]


def test_extract_toc_writes_chapters(conn, doc_with_toc):
    from kb.toc import extract_toc

    doc_id, cfg = doc_with_toc
    n = extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, title, print_page, taxonomy FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, "乘除法竖式谜", 1, "计算类"), (2, "三角形", 10, "几何类")]
    assert extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON)) == 0  # 幂等


def test_extract_toc_auto_detects_toc_page(conn, doc_with_toc):
    """不显式给 toc_pages 时，应自动找到块文本含"目录"的第 1 页。"""
    import kb.toc as toc_mod

    doc_id, cfg = doc_with_toc
    seen_pages = []

    class SpyClient:
        class chat:
            class completions:
                @staticmethod
                def create(model, messages, max_tokens):
                    # 从 image b64 无法回推页码，改从调用次数验证（自动探测只有 1 页含"目录"）
                    seen_pages.append(1)
                    return _client(TOC_JSON).chat.completions.create(model, messages, max_tokens)

    n = toc_mod.extract_toc(conn, cfg, doc_id, client=SpyClient())
    assert n == 2
    assert len(seen_pages) == 1  # 只调用了 1 页
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_toc.py -v`
Expected: FAIL，`No module named 'kb.toc'`

- [ ] **Step 3: 实现 kb/toc.py**

```python
"""目录页解析 -> chapters（章节/印刷页码/分类/思想方法标签，词表的唯一事实来源）。

目录页自动探测：前 15 页中块文本含"目录"的页；也可显式传 toc_pages。
幂等：已有章节的文档直接跳过。
"""
from __future__ import annotations

import json
import re
import uuid

from openai import OpenAI

from kb.config import Config
from kb.parse import transcribe_image

TOC_PROMPT = (
    "这是一本书的目录页。请提取所有章节，输出 JSON 数组，每项包含：\n"
    "- chapter_no: 章节序号（整数，如\"第 3 讲\"输出 3）\n"
    "- title: 章节标题（不含\"第 N 讲\"前缀）\n"
    "- print_page: 目录标注的印刷页码（整数）\n"
    "- taxonomy: 右侧分类标签（如\"计算类\"/\"几何类\"，没有则 null）\n"
    "- tags: 右侧思想方法标签数组（如[\"倒推法\",\"枚举法\"]，没有则 []）\n"
    "只输出 JSON，不要任何其他文字。"
)


def _parse_json_array(text: str) -> list[dict]:
    """剥掉 markdown 代码围栏后解析 JSON 数组。"""
    cleaned = re.sub("`" * 3 + "(?:json)?", "", text).strip()
    return json.loads(cleaned)


def _detect_toc_pages(cur, doc_id: str) -> list[int]:
    cur.execute(
        """SELECT DISTINCT p.page_no FROM pages p
           JOIN blocks b ON b.page_id = p.id
           WHERE p.document_id=%s AND p.page_no <= 15 AND b.content_md LIKE '%目录%'
           ORDER BY p.page_no""",
        (doc_id,),
    )
    return [r[0] for r in cur.fetchall()]


def extract_toc(conn, cfg: Config, doc_id: str, client=None,
                toc_pages: list[int] | None = None) -> int:
    """解析目录页写入 chapters。返回新增章节数。"""
    model = cfg.structure_model or cfg.vision_model
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM chapters WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            return 0
        pages = toc_pages if toc_pages is not None else _detect_toc_pages(cur, doc_id)
        if not pages:
            raise SystemExit("未找到目录页，请用 --toc-pages 显式指定")
        n = 0
        for page_no in pages:
            cur.execute(
                "SELECT image_path FROM pages WHERE document_id=%s AND page_no=%s",
                (doc_id, page_no),
            )
            row = cur.fetchone()
            if not row:
                continue
            text = transcribe_image(client, model, row[0], prompt=TOC_PROMPT)
            for entry in _parse_json_array(text):
                cur.execute(
                    """INSERT INTO chapters (id, document_id, chapter_no, title,
                                             print_page, taxonomy, tags)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (document_id, chapter_no) DO NOTHING""",
                    (str(uuid.uuid4()), doc_id, entry["chapter_no"], entry["title"],
                     entry.get("print_page"), entry.get("taxonomy"),
                     entry.get("tags") or []),
                )
                n += 1
    return n
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_toc.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add backend/kb/toc.py backend/tests/test_toc.py
git commit -m "feat: 目录页解析 -> chapters 词表（自动探测/幂等）"
```

---

### Task 3: 印刷页码 → 物理页码校准（toc.py）

**Files:**
- Modify: `backend/kb/toc.py`
- Modify: `backend/tests/test_toc.py`

**设计:** 目录给的是印刷页码，数据里的是物理页码。校准策略：用章节标题在已解析块文本中的**首次出现页**作为该章物理首页；找不到的章节留 NULL（页面未入库，放量重跑时自动补上）；`page_end` = 下一章 `page_start` - 1，末章到文档末页。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_toc.py` 追加：

```python
def test_calibrate_pages_maps_print_to_physical(conn, doc_with_toc):
    from kb.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    with conn.cursor() as cur:  # 第 1 讲标题出现在物理第 2 页，第 2 讲在物理第 3 页
        cur.execute(
            """UPDATE blocks SET content_md='第 1 讲 乘除法竖式谜 正文' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=2)"""
        )
        cur.execute(
            """UPDATE blocks SET content_md='第 2 讲 三角形 正文' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=3)"""
        )
    assert calibrate_pages(conn, doc_id) == 2
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, page_start, page_end FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, 2, 2), (2, 3, 3)]  # 文档共 3 页，末章到末页


def test_calibrate_pages_leaves_null_when_not_found(conn, doc_with_toc):
    from kb.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert calibrate_pages(conn, doc_id) == 0  # 页面没解析，定位不到
    with conn.cursor() as cur:
        cur.execute("SELECT page_start FROM chapters")
        assert all(r[0] is None for r in cur.fetchall())
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_toc.py -v`
Expected: FAIL（`calibrate_pages` 不存在）

- [ ] **Step 3: 实现（toc.py 追加）**

```python
def calibrate_pages(conn, doc_id: str) -> int:
    """把印刷页码换算为物理页范围。返回成功定位的章节数。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, title FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = cur.fetchall()
        located = []  # (chapter_id, page_start)
        for cid, title in chapters:
            cur.execute(
                """SELECT p.page_no FROM pages p
                   JOIN blocks b ON b.page_id = p.id
                   WHERE p.document_id=%s AND b.content_md LIKE %s
                   ORDER BY p.page_no LIMIT 1""",
                (doc_id, f"%{title}%"),
            )
            row = cur.fetchone()
            if row:
                located.append((cid, row[0]))
        cur.execute("SELECT max(page_no) FROM pages WHERE document_id=%s", (doc_id,))
        max_page = cur.fetchone()[0] or 0
        for i, (cid, start) in enumerate(located):
            end = (located[i + 1][1] - 1) if i + 1 < len(located) else max_page
            cur.execute(
                "UPDATE chapters SET page_start=%s, page_end=%s WHERE id=%s",
                (start, end, cid),
            )
    return len(located)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_toc.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add backend/kb/toc.py backend/tests/test_toc.py
git commit -m "feat: 印刷页码校准（章节标题首现定位物理页范围）"
```

---

### Task 4: 章节窗口拆条（kb/structure.py）

**Files:**
- Create: `backend/kb/structure.py`
- Create: `backend/tests/test_structure.py`

**设计:** 按章节窗口组装块文本（跨页合并天然成立——窗口是章节不是页），喂纯文本模型拆条。块以 `【块N】` 编号进 prompt，模型输出每条 item 引用的块号，据此写 `item_blocks`（role：answer 条的文本块记 solution，figure/table 块记 figure，其余 stem）。taxonomy/tags 从该章词表来，不让模型自由发挥。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_structure.py`：

```python
import pymupdf as fitz
import pytest


@pytest.fixture()
def doc_with_chapter(conn, tmp_path):
    """1 本书 1 章（物理 2-3 页），页 2 有 例题块+公式块，页 3 有 练习块。"""
    import uuid

    from kb.config import Config

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/b.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (document_id, chapter_no, title, print_page, taxonomy, tags,
                                     page_start, page_end)
               VALUES (%s, 1, '乘除法竖式谜', 1, '计算类', ARRAY['倒推法'], 2, 3)""",
            (doc_id,),
        )
        blocks = []
        for page_no, texts in [(2, [("text", "例1 在下面方框填上合适的数字"),
                                    ("figure", "$\\square 7 6$ 竖式图"),
                                    ("text", "答：第二个因数十位是 8")]),
                               (3, [("text", "1. 盼望祖国早日统一 算式谜")])]:
            cur.execute(
                "INSERT INTO pages (id, document_id, page_no, image_path, status) VALUES (%s,%s,%s,'/tmp/x.png','parsed') RETURNING id",
                (str(uuid.uuid4()), doc_id, page_no),
            )
            page_id = str(cur.fetchone()[0])
            for btype, content in texts:
                bid = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO blocks (id, page_id, block_type, crop_path, content_md) VALUES (%s,%s,%s,'/tmp/c.png',%s)",
                    (bid, page_id, btype, content),
                )
                blocks.append(bid)
    return doc_id, cfg, blocks


_FENCE = "`" * 3
ITEMS_JSON = _FENCE + "json\n" + (
    '[{"content_type": "example", "label": "例1",'
    ' "content_md": "在下面方框填上合适的数字。$\\square 7 6$", "block_ids": [1, 2, 3]},'
    '{"content_type": "exercise", "label": "1",'
    ' "content_md": "盼望祖国早日统一 算式谜", "block_ids": [4]}]'
) + "\n" + _FENCE


def _client(text):
    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client()


def test_structure_chapter_creates_items(conn, doc_with_chapter):
    from kb.structure import structure_chapter

    doc_id, cfg, blocks = doc_with_chapter
    n = structure_chapter(conn, cfg, doc_id, chapter_no=1, client=_client(ITEMS_JSON))
    assert n == 2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT content_type, label, chapter, taxonomy, tags, page_start, page_end
               FROM items ORDER BY label"""
        )
        rows = cur.fetchall()
    assert rows[0][:3] == ("exercise", "1", "第 1 讲 乘除法竖式谜")
    assert rows[1][0] == "example"
    assert rows[1][3] == "计算类" and rows[1][4] == ["倒推法"]
    assert (rows[1][5], rows[1][6]) == (2, 3)  # 跨页：例题引用了页2的块
    with conn.cursor() as cur:
        cur.execute("SELECT block_id, role FROM item_blocks ORDER BY role")
        rb = {str(b): r for b, r in cur.fetchall()}
    assert rb[blocks[1]] == "figure"   # figure 块记 figure
    assert rb[blocks[0]] == "stem"     # 文本块记 stem


def test_structure_chapter_skips_done(conn, doc_with_chapter):
    from kb.structure import structure_chapter

    doc_id, cfg, _blocks = doc_with_chapter
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(ITEMS_JSON)) == 2
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(ITEMS_JSON)) == 0  # 幂等
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_structure.py -v`
Expected: FAIL，`No module named 'kb.structure'`

- [ ] **Step 3: 实现 kb/structure.py**

```python
"""阶段④结构化拆分：章节窗口（跨页合并）-> items + item_blocks。

块按页序编号进 prompt，模型输出每条 item 引用的块号；taxonomy/tags 取该章词表。
幂等：该章已有 items 则跳过。
"""
from __future__ import annotations

import uuid

from openai import OpenAI

from kb.config import Config
from kb.toc import _parse_json_array

_SKIP_TYPES = {"header", "footer"}

STRUCTURE_PROMPT = (
    "下面是一本书某一讲的全部内容（已按阅读顺序排列，每块以【块N】编号）。\n"
    "请把它拆成条目，输出 JSON 数组，每项：\n"
    '- content_type: "example"(例题讲解，含解析) / "exercise"(练习题) / "answer"(答案解析)\n'
    "- label: 原书题号（如\"例1\"、\"3\"）\n"
    "- content_md: 该条目的完整内容（题干+例题解析），数学内容用 LaTeX（$...$）\n"
    "- block_ids: 该条目引用的块号数组\n"
    "规则：同一道题跨页/跨块要合并成一条；例题的题干和解析同属一条；只输出 JSON。\n"
    "本讲分类：{taxonomy}；思想方法：{tags}\n\n"
    "{blocks_text}"
)


def _chapter_blocks(cur, doc_id: str, page_start: int, page_end: int) -> list[tuple]:
    cur.execute(
        """SELECT b.id, b.block_type, b.content_md FROM blocks b
           JOIN pages p ON p.id = b.page_id
           WHERE p.document_id=%s AND p.page_no BETWEEN %s AND %s
             AND b.block_type <> ALL(%s) AND b.content_md IS NOT NULL
           ORDER BY p.page_no, b.created_at""",
        (doc_id, page_start, page_end, list(_SKIP_TYPES)),
    )
    return cur.fetchall()


def structure_chapter(conn, cfg: Config, doc_id: str, chapter_no: int, client=None) -> int:
    """拆分一章。返回新增 item 数。"""
    model = cfg.structure_model or cfg.vision_model
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, chapter_no, title, taxonomy, tags, page_start, page_end
               FROM chapters WHERE document_id=%s AND chapter_no=%s""",
            (doc_id, chapter_no),
        )
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"章节不存在: doc={doc_id} 第 {chapter_no} 章")
        _cid, _no, title, taxonomy, tags, page_start, page_end = row
        if page_start is None:
            return 0  # 页面未入库，跳过（放量重跑时自动补）
        chapter_label = f"第 {chapter_no} 讲 {title}"
        cur.execute(
            "SELECT 1 FROM items WHERE document_id=%s AND chapter=%s LIMIT 1",
            (doc_id, chapter_label),
        )
        if cur.fetchone():
            return 0  # 幂等
        blocks = _chapter_blocks(cur, doc_id, page_start, page_end)
        if not blocks:
            return 0
        blocks_text = "\n\n".join(
            f"【块{i + 1}】{content}" for i, (_bid, _bt, content) in enumerate(blocks)
        )
        prompt = STRUCTURE_PROMPT.format(
            taxonomy=taxonomy or "未知", tags="、".join(tags or []) or "无",
            blocks_text=blocks_text,
        )
        resp = client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": prompt}], max_tokens=8192,
        )
        entries = _parse_json_array(resp.choices[0].message.content)
        n = 0
        for entry in entries:
            item_id = str(uuid.uuid4())
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md,
                                      chapter, taxonomy, tags, page_start, page_end)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (item_id, doc_id, entry["content_type"], entry["label"], entry["content_md"],
                 chapter_label, taxonomy, tags or [], page_start, page_end),
            )
            for idx in entry.get("block_ids", []):
                if not (1 <= idx <= len(blocks)):
                    continue  # 模型引用了不存在的块号，跳过不炸
                bid, btype, _content = blocks[idx - 1]
                if entry["content_type"] == "answer":
                    role = "solution"
                elif btype in ("figure", "table"):
                    role = "figure"
                else:
                    role = "stem"
                cur.execute(
                    "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (item_id, bid, role),
                )
            n += 1
    return n
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_structure.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add backend/kb/structure.py backend/tests/test_structure.py
git commit -m "feat: 章节窗口结构化拆分（跨页合并，块引用回填 item_blocks）"
```

---

### Task 5: 答案配对与题号连续性质检

**Files:**
- Modify: `backend/kb/structure.py`
- Modify: `backend/kb/qc.py`
- Modify: `backend/tests/test_structure.py`
- Modify: `backend/tests/test_qc.py`

**设计:** 答案按 `label` 精确配对（"例1" ↔ 答案区"例1"）；配对只做一次 UPDATE。题号连续性：每章 exercise 的 label 应为连续整数 1..N，缺号建 `missing_item` 复核行（挂该章任一文本块，**不进** CHECKABLE_REASONS——缺失只能靠重拆修复）。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_structure.py` 追加：

```python
def test_pair_items_links_answers(conn, doc_with_chapter):
    import uuid

    from kb.structure import pair_items

    doc_id, _cfg, _blocks = doc_with_chapter
    with conn.cursor() as cur:
        ex_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES (%s,%s,'exercise','3','题')",
            (ex_id, doc_id),
        )
        cur.execute(
            "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES (%s,%s,'answer','3','答')",
            (str(uuid.uuid4()), doc_id),
        )
    assert pair_items(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT paired_item_id FROM items WHERE content_type='exercise'")
        assert cur.fetchone()[0] is not None
```

`backend/tests/test_qc.py` 追加：

```python
def test_check_label_continuity_flags_missing(conn, tmp_path):
    """第 1 章有 1、3 题缺 2 -> 建 missing_item 复核行；且不属可自动关闭原因。"""
    import uuid

    from kb.config import Config
    from kb.qc import CHECKABLE_REASONS, check_label_continuity

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/b.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO chapters (document_id, chapter_no, title) VALUES (%s, 1, '竖式谜')",
            (doc_id,),
        )
        for label in ("1", "3"):
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
                   VALUES (%s,%s,'exercise',%s,'题','第 1 讲 竖式谜')""",
                (str(uuid.uuid4()), doc_id, label),
            )
        # missing_item 挂到该章任一块上做复核载体；没有块则挂空（复核页 LEFT JOIN 展示）
        cur.execute("SELECT id FROM pages WHERE document_id=%s LIMIT 1", (doc_id,))
    assert "missing_item" not in CHECKABLE_REASONS
    assert check_label_continuity(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue WHERE reason LIKE 'missing_item%'")
        assert "第 1 讲" in cur.fetchone()[0]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_structure.py::test_pair_items_links_answers tests/test_qc.py::test_check_label_continuity_flags_missing -v`
Expected: FAIL（`pair_items` / `check_label_continuity` 不存在）

- [ ] **Step 3: 实现**

`backend/kb/structure.py` 追加：

```python
def pair_items(conn, doc_id: str) -> int:
    """按 label 精确配对 answer <-> exercise/example。返回新增配对数。"""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE items a SET paired_item_id = q.id
               FROM items q
               WHERE a.document_id=%s AND q.document_id=%s
                 AND a.content_type='answer' AND q.content_type <> 'answer'
                 AND a.label = q.label AND a.paired_item_id IS NULL""",
            (doc_id, doc_id),
        )
        n1 = cur.rowcount
        cur.execute(
            """UPDATE items q SET paired_item_id = a.id
               FROM items a
               WHERE a.document_id=%s AND q.document_id=%s
                 AND a.content_type='answer' AND q.content_type <> 'answer'
                 AND a.label = q.label AND q.paired_item_id IS NULL""",
            (doc_id, doc_id),
        )
        return n1 + cur.rowcount
```

`backend/kb/qc.py` 追加：

```python
def check_label_continuity(conn, doc_id: str) -> int:
    """每章 exercise 题号应连续（1..N），缺号建 missing_item 复核行。返回新增数。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT chapter, label FROM items
               WHERE document_id=%s AND content_type='exercise' AND chapter IS NOT NULL
               ORDER BY chapter""",
            (doc_id,),
        )
        by_chapter: dict[str, set[int]] = {}
        for chapter, label in cur.fetchall():
            if label and label.isdigit():
                by_chapter.setdefault(chapter, set()).add(int(label))
        n = 0
        for chapter, labels in by_chapter.items():
            missing = sorted(set(range(1, max(labels) + 1)) - labels)
            for m in missing:
                reason = f"missing_item:{chapter} 第{m}题"
                cur.execute("SELECT 1 FROM review_queue WHERE reason=%s", (reason,))
                if cur.fetchone():
                    continue
                cur.execute(
                    "INSERT INTO review_queue (id, reason) VALUES (%s,%s)",
                    (str(uuid.uuid4()), reason),
                )
                n += 1
    return n
```

注意：missing_item 行不带 block_id/item_id，`review_api.list_reviews` 目前是 INNER JOIN blocks，这类行会隐身——Task 6 修。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_structure.py tests/test_qc.py -v`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add backend/kb/structure.py backend/kb/qc.py backend/tests/test_structure.py backend/tests/test_qc.py
git commit -m "feat: 答案配对与题号连续性质检（missing_item）"
```

---

### Task 6: 复核页兼容无块复核行 + CLI structure 子命令

**Files:**
- Modify: `backend/kb/review_api.py`
- Modify: `backend/kb/cli.py`
- Modify: `backend/tests/test_review_api.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_review_api.py` 追加：

```python
def test_list_reviews_includes_blockless_rows(client, conn):
    """missing_item 这类无块复核行也要能列出（LEFT JOIN）。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO review_queue (reason) VALUES ('missing_item:第 1 讲 第2题')"
        )
    data = client.get("/api/review").json()
    assert data["counts"]["pending"] == 1
    it = data["items"][0]
    assert it["reason"] == "missing_item:第 1 讲 第2题"
    assert it["block_id"] is None and it["content_md"] is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_review_api.py::test_list_reviews_includes_blockless_rows -v`
Expected: FAIL（INNER JOIN 吞掉了无块行，counts 对不上）

- [ ] **Step 3: 实现**

`backend/kb/review_api.py` 的 `list_reviews` 查询改 LEFT JOIN，字段判空：

```python
            cur.execute(
                f"""SELECT r.id, r.reason, r.status, r.created_at,
                           d.title AS doc_title, p.page_no, b.id AS block_id, b.content_md
                    FROM review_queue r
                    LEFT JOIN blocks b ON b.id = r.block_id
                    LEFT JOIN pages p ON p.id = b.page_id
                    LEFT JOIN documents d ON d.id = p.document_id
                    {where}
                    ORDER BY r.created_at""",
                params,
            )
```

items 构造里 `str(r[6]) if r[6] else None`（block_id 可空）。前端 `review.html` 的 card()：无 block 时不渲染图片，裁图 img 用 `it.block_id ? ... : ''` 条件渲染（把 `<img>` 行改为 `${it.block_id ? `<img src="/api/blocks/${it.block_id}/crop" alt="页面裁图">` : ""}`）。

`backend/kb/cli.py` 加子命令：

```python
    p_struct = sub.add_parser("structure")
    p_struct.add_argument("doc_id")
    p_struct.add_argument("--toc-pages", default=None,
                          help="目录物理页码，逗号分隔，如 5,6；不给则自动探测")
```

分发处加：

```python
    elif args.cmd == "structure":
        from kb.qc import check_label_continuity
        from kb.structure import pair_items
        from kb.toc import calibrate_pages, extract_toc

        toc_pages = [int(x) for x in args.toc_pages.split(",")] if args.toc_pages else None
        n_toc = extract_toc(conn, cfg, args.doc_id, toc_pages=toc_pages)
        n_cal = calibrate_pages(conn, args.doc_id)
        print(f"目录: {n_toc} 章入库, {n_cal} 章完成页码校准")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT chapter_no FROM chapters WHERE document_id=%s ORDER BY chapter_no",
                (args.doc_id,),
            )
            chapters = [r[0] for r in cur.fetchall()]
        from kb.structure import structure_chapter
        total = 0
        for no in chapters:
            try:
                total += structure_chapter(conn, cfg, args.doc_id, no)
            except SystemExit as e:
                print(f"第 {no} 章跳过: {e}")
        print(f"条目: {total} 条入库; 配对 {pair_items(conn, args.doc_id)} 处; "
              f"题号质检新增 {check_label_continuity(conn, args.doc_id)} 条")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest -q`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add backend/kb/review_api.py backend/kb/cli.py backend/kb/static/review.html backend/tests/test_review_api.py
git commit -m "feat: 复核页兼容无块复核行；CLI structure 子命令（目录->校准->拆条->配对->质检）"
```

---

### Task 7: 真实数据验证 + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 第 1 讲全量入库（如尚未入库）**

《7星学霸》第 1 讲约物理 6-15 页：

```bash
cd backend && KB_LAYOUT_ENGINE=paddleocr uv run --extra layout python -m kb.cli ingest \
  "../resources/2025秋7星学霸题中题数学4年级第7辑.pdf" \
  --title "7星学霸题中题数学4年级第7辑" --subject 数学 --grade 四年级 --start 6 --end 15
```

注：已解析的页会跳过（断点续跑）；图块走视觉模型，耗时较长，放后台跑。

- [ ] **Step 2: 结构化第 1 讲**

```bash
uv run python -m kb.cli structure <doc_id> --toc-pages 5
```

Expected: 输出"目录: N 章入库, M 章完成页码校准"，items 表出现 `example`（例1~例4）与 `exercise` 条目，chapter='第 1 讲 乘除法竖式谜'，taxonomy='计算类'，tags 含倒推法/枚举法；跨页例题的 page_start/page_end 覆盖多页。

- [ ] **Step 3: 人工抽查**

复核页看 missing_item / llm_disagree / bad_latex 行；抽 2 条 example 对照原书（`item_blocks` 裁图）验证题干+解析合并正确。

- [ ] **Step 4: README 更新并 Commit**

`## 精度期 2b` 一节：structure 用法、词表机制（taxonomy/tags 来自目录，LLM 不自由发挥）、配对与题号质检。

```bash
git add README.md
git commit -m "docs: 精度期 2b 结构化拆分用法"
```

---

## Self-Review 记录

- **规格覆盖**：目录词表（Task 1-2）✓；印刷页码校准（Task 3）✓；章节窗口跨页合并（Task 4，窗口=章节）✓；item_blocks 关联（Task 4）✓；答案配对（Task 5）✓；题号连续性（Task 5）✓；taxonomy/tags 封闭词表（Task 4 prompt 注入该章词表）✓。
- **占位符扫描**：无 TBD/TODO，代码完整。
- **类型一致性**：`extract_toc(conn, cfg, doc_id, client=None, toc_pages=None)`、`calibrate_pages(conn, doc_id)`、`structure_chapter(conn, cfg, doc_id, chapter_no, client=None)`、`pair_items(conn, doc_id)`、`check_label_continuity(conn, doc_id)` 定义与调用一致；`_parse_json_array` 复用自 toc.py。
- **已知边界**：label 归一化只做精确匹配（"例1"≠"例题 1"），复杂变体留到黄金集验收后再加规则；answers 章节若不在目录里（常见：答案独立成篇不进目录），其结构化需在 TOC 提取时让模型把答案篇也作为一章输出（真实数据验证时确认，必要时调 TOC_PROMPT）。

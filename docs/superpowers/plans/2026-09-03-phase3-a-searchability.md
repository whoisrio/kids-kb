# Phase 3-A 检索可达性 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让入库的资料真正能被聊天检索到——approve 即向量化、docx/md 未拆条也可见、md 文件可入库、入库工作流文档与真实链路一致。

**Architecture:** 三层修复。
第一层是自动化断点：`approve`（单条/批量）后立即向量化，不再依赖手工 `kb.cli embed`。
第二层是章节级向量底座：chunks 表支持挂章节（`item_id` 可空 + `chapter_id`），docx/md 入库即按章分段向量化，未拆条文档天然可检索；条目级命中在 TS 检索层抑制同章的章节分段命中。
第三层是可观测与防回归：测试库防误清守卫 + 全链路 E2E + 真实资料重入库验收。

**Tech Stack:** PostgreSQL migration（pipeline 侧唯一 schema 主人）、psycopg、ollama bge-m3、TypeScript（hono/vitest）、Playwright。

**背景（为什么做）：** 调查确认"查询不到资料"的根因——
1. `kb` 库当前为空（documents/chunks 均为 0 行），真实资料都在 `resources/` 未入库；
2. 照 AGENTS.md 工作流走完（ingest → structure → export）检索必然为空：条目 `qc_status='pending'` 过不了向量化门禁，且 `approve` 不触发 embed，`kb.cli embed` 是无人提醒的手工步骤；
3. docx 的 `chapters.content_md` 只存不索引，`.md` 文件没有入库路径；
4. 无任何视图能看出"一份资料为什么搜不到"。

**边界纪律：** schema 只能由 `pipeline/kb/migrations/` 变更；检索主链路（向量/BM25 查询）在 backend TS，pipeline 只负责写入 chunks。

**测试运行命令（全计划通用）：**

- pipeline：`cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
- backend：`cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
- frontend：`cd frontend && npm test`
- E2E：`cd e2e && npm test`

**注意：** pipeline 与 backend 的测试共用 `kb_test` 且各自 DROP SCHEMA，绝不能并行跑。

---

## 文件结构（本计划涉及的全部文件）

- Create: `pipeline/kb/migrations/0013_chapter_chunks.sql` — chunks 支持章节级向量 + 清理死表 item_embeddings
- Create: `pipeline/kb/text_ingest.py` — md/docx 共用：切章 + 落库 + 章节向量化 + `ingest_md`
- Modify: `pipeline/kb/docx_ingest.py` — pandoc 后改走 `text_ingest.store_document_chapters`
- Modify: `pipeline/kb/embed.py` — `segment_chapter` / `embed_chapters` / `approve_items`；search 兼容章节命中
- Modify: `pipeline/kb/lexical.py` — BM25 兼容章节命中（rrf key）
- Modify: `pipeline/kb/cli.py` — `.md` 分流、`approve` 子命令、`embed` 补跑章节
- Modify: `pipeline/kb/review_api.py` — `approve_item` 自动向量化（`embed_client` 注入）
- Modify: `pipeline/kb/db.py` — `ensure_test_database` 防误清守卫
- Modify: `pipeline/tests/conftest.py` — clean_db 接守卫
- Modify: `pipeline/tests/test_db.py`、`test_embed.py`、`test_docx_ingest.py`；Create: `pipeline/tests/test_md_ingest.py`
- Modify: `backend/src/retrieval/search.ts` — 章节命中贯通 + 同章抑制 + `itemsOnly`
- Modify: `backend/src/retrieval/match.ts` — 匹配只用条目级 chunk
- Modify: `backend/src/agent/tools.ts` — search_items 展示章节命中
- Modify: `backend/src/retrieval/search.test.ts`、`match.test.ts`、`backend/src/agent/tools.test.ts`
- Create: `e2e/specs/searchability.spec.ts` — md 入库 → 聊天检索全链路
- Modify: `AGENTS.md` — 入库工作流补全复核/向量化步骤

---

### Task 1: Migration 0013——chunks 支持章节级向量

**Files:**

- Create: `pipeline/kb/migrations/0013_chapter_chunks.sql`
- Modify: `pipeline/tests/test_db.py`（`test_migrate_creates_tables` 移除 item_embeddings + 新增 0013 约束测试）

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_db.py` 末尾追加（并修改既有 `test_migrate_creates_tables`）：

```python
def test_migrate_creates_tables(clean_db):
    from kb.db import migrate
    ran = migrate(clean_db)
    assert "0001_init.sql" in ran
    with clean_db.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN
              ('documents', 'pages', 'blocks', 'items', 'item_blocks',
               'review_queue', 'schema_migrations')
        """)
        assert cur.fetchall().__len__() == 7
        # 0013 起清理死表:chunks(0008)已取代 item_embeddings
        cur.execute("""
            SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public' AND table_name='item_embeddings'
        """)
        assert cur.fetchone()[0] == 0
```

```python
def test_chunks_chapter_ref_after_0013(conn):
    """0013 后:chunks 可挂章节(item_id 空、seg_no 必填);同章同段唯一;不可同时挂条目与章节。"""
    import uuid
    import pytest
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/t.md') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'大题一','# 一、选择题') RETURNING id""",
            (str(uuid.uuid4()), doc_id))
        ch_id = str(cur.fetchone()[0])
        vec = "[" + ",".join(["0"] * 1024) + "]"
        cur.execute(
            """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
               VALUES (%s,%s,1,'章稿段落','{}',%s)""",
            (ch_id, doc_id, vec))
        # 同章同段号唯一
        with pytest.raises(Exception):
            cur.execute(
                """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
                   VALUES (%s,%s,1,'重复段','{}',%s)""",
                (ch_id, doc_id, vec))
        # item_id 与 chapter_id 不可同挂
        with pytest.raises(Exception):
            cur.execute(
                """INSERT INTO chunks (item_id, chapter_id, document_id, seg_no, content_md, meta, embedding)
                   VALUES (%s,%s,%s,1,'双挂','{}',%s)""",
                (str(uuid.uuid4()), ch_id, doc_id, vec))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py -q`
Expected: `test_chunks_chapter_ref_after_0013` FAIL（chapter_id 列不存在）；`test_migrate_creates_tables` FAIL（item_embeddings 仍存在、数量为 8）

- [ ] **Step 3: 写 migration**

`pipeline/kb/migrations/0013_chapter_chunks.sql`：

```sql
-- 0013_chapter_chunks.sql:chunks 支持章节级向量(docx/md 未拆条内容的检索底座)
-- item_id 可空 + chapter_id/seg_no;条目向量与章节分段向量共存
ALTER TABLE chunks ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE chunks ADD COLUMN chapter_id UUID REFERENCES chapters(id) ON DELETE CASCADE;
ALTER TABLE chunks ADD COLUMN seg_no INTEGER;
-- Postgres UNIQUE 视 NULL 互不相等:既有 chunks_item_id_key 原样保留(多条章节行 item_id=NULL 不冲突)
CREATE UNIQUE INDEX chunks_chapter_seg_key ON chunks(chapter_id, seg_no) WHERE chapter_id IS NOT NULL;
-- 一行恰挂一个单元:条目(item_id)或章节分段(chapter_id+seg_no)
ALTER TABLE chunks ADD CONSTRAINT chunks_unit_ref CHECK (
  (item_id IS NOT NULL AND chapter_id IS NULL AND seg_no IS NULL)
  OR (item_id IS NULL AND chapter_id IS NOT NULL AND seg_no IS NOT NULL)
);
-- item_embeddings 自 0008(chunks)起无代码引用,清理死表
DROP TABLE IF EXISTS item_embeddings;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS（0001 的 item_embeddings 建表语句先建后删，重放安全）

- [ ] **Step 6: 提交**

```bash
git add pipeline/kb/migrations/0013_chapter_chunks.sql pipeline/tests/test_db.py
git commit -m "feat(migration): chunks 支持章节级向量(item_id 可空+chapter_id/seg_no),清理死表 item_embeddings"
```

---

### Task 2: embed.py——章节分段与 embed_chapters

**Files:**

- Modify: `pipeline/kb/embed.py`
- Modify: `pipeline/tests/test_embed.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_embed.py` 追加（文件顶部已有 `uuid` 导入与 `_FakeEmbed`）：

```python
def test_segment_chapter_packs_paragraphs():
    from kb.embed import segment_chapter

    paras = "\n\n".join(f"段落{i}" + "字" * 20 for i in range(10))  # 每段约 22 字
    segs = segment_chapter(paras, max_chars=60)
    assert all(len(s) <= 60 for s in segs)
    assert "段落0" in segs[0] and "段落9" in segs[-1]
    # 超长单段硬切
    assert [len(s) for s in segment_chapter("长" * 200, max_chars=60)] == [60, 60, 60, 20]
    # 空内容不分段
    assert segment_chapter("") == []


def test_embed_chapters_segments_and_idempotent(conn, doc_chapter):
    from kb.embed import embed_chapters

    doc_id, cfg = doc_chapter
    content = "\n\n".join(f"# 小节{i}\n内容{i}" + "字" * 30 for i in range(5))
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,2,'语法讲义',%s)""",
            (str(uuid.uuid4()), doc_id, content),
        )
    n = embed_chapters(conn, cfg, doc_id, client=_FakeEmbed())
    assert n > 0
    with conn.cursor() as cur:
        cur.execute(
            """SELECT seg_no, meta->>'kind', meta->>'chapter', meta->>'doc_title',
                      chapter_id IS NOT NULL, item_id IS NULL, vector_dims(embedding)
               FROM chunks WHERE chapter_id IS NOT NULL ORDER BY seg_no""")
        rows = cur.fetchall()
        assert rows, "章节 chunk 应已写入"
        seg_no, kind, chapter, doc_title, has_ch, no_item, dims = rows[0]
        assert kind == "chapter"
        assert chapter == "第 2 讲 语法讲义"  # 与 structure 的 items.chapter 标签同构,供 TS 同章抑制
        assert doc_title == "7星学霸"
        assert has_ch and no_item and dims == 1024
    assert embed_chapters(conn, cfg, doc_id, client=_FakeEmbed()) == 0  # 幂等
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_embed.py -q -k "segment or chapters"`
Expected: FAIL（`ImportError: cannot import name 'segment_chapter'`）

- [ ] **Step 3: 实现**

在 `pipeline/kb/embed.py` 中，顶部补 `import re`；
在 `invalidate_chunk` 之前插入：

```python
def segment_chapter(content_md: str, max_chars: int = 1600) -> list[str]:
    """章稿分段:空行分段落,聚合成 ≤max_chars 的段;超长单段硬切。bge-m3 上下文 8k,留足余量。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", content_md or "") if p.strip()]
    segs: list[str] = []
    buf = ""
    for p in paras:
        if buf and len(buf) + len(p) + 2 <= max_chars:
            buf = f"{buf}\n\n{p}"
        else:
            if buf:
                segs.append(buf)
            buf = p
        while len(buf) > max_chars:  # 单段超长:硬切
            segs.append(buf[:max_chars])
            buf = buf[max_chars:]
    if buf:
        segs.append(buf)
    return segs


def embed_chapters(conn, cfg: Config, doc_id: str | None = None,
                   client=None) -> int:
    """有 content_md 且无 chunk 的章节 -> 分段向量化(未拆条也可见的检索底座)。幂等。"""
    where, params = ("AND ch.document_id=%s", [doc_id]) if doc_id else ("", [])
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT ch.id, ch.document_id, ch.chapter_no, ch.title, ch.content_md,
                       d.subject, d.grade, d.title
                FROM chapters ch JOIN documents d ON d.id = ch.document_id
                WHERE ch.content_md IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.chapter_id = ch.id)
                {where}""",
            params,
        )
        rows = cur.fetchall()
    if not rows:
        return 0
    payloads = []
    for r in rows:
        label = f"第 {r[2]} 讲 {r[3]}"  # 与 structure_chapter 的 items.chapter 标签同构
        for i, seg in enumerate(segment_chapter(r[4]), start=1):
            payloads.append((r, label, i, seg))
    vectors = embed_texts(cfg, [f"{label}\n\n{seg}" for (_r, label, _i, seg) in payloads],
                          client=client)
    with conn.cursor() as cur:
        for (r, label, i, seg), vec in zip(payloads, vectors, strict=True):
            meta = {
                "kind": "chapter", "chapter": label, "doc_title": r[7],
                "subject": r[5], "grade": r[6], "seg": i,
            }
            cur.execute(
                """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (chapter_id, seg_no) WHERE chapter_id IS NOT NULL DO NOTHING""",
                (str(r[0]), str(r[1]), i, f"{label}\n\n{seg}", Jsonb(meta), vec),
            )
    return len(payloads)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_embed.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add pipeline/kb/embed.py pipeline/tests/test_embed.py
git commit -m "feat(embed): 章节分段向量化 embed_chapters——未拆条 docx/md 的检索底座"
```

---

### Task 3: text_ingest.py——md 入库路径 + docx 复用

**Files:**

- Create: `pipeline/kb/text_ingest.py`
- Create: `pipeline/tests/test_md_ingest.py`
- Modify: `pipeline/kb/docx_ingest.py`
- Modify: `pipeline/kb/cli.py`（`.md` 分流）
- Modify: `pipeline/tests/test_docx_ingest.py`（client 注入保测试封闭）

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_md_ingest.py`（新建，fixture 风格对齐 `test_docx_ingest.py`）：

```python
"""md 入库:整份 markdown 切章 -> chapters.content_md -> 章节向量化 -> 章稿落盘。"""
import uuid

import pytest

from kb.config import Config


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


class _FakeEmbed:
    """确定性假 embedding:全 1 向量(embed_texts 逐条调用 create)。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()


def test_ingest_md_splits_chapters_and_embeds(conn, cfg, tmp_path):
    from kb.text_ingest import ingest_md

    md = tmp_path / "grammar.md"
    md.write_text(
        "# 一、修辞手法\n\n比喻句:本体是燕子。\n\n# 二、标点\n\n省略号表示语意未尽。\n",
        encoding="utf-8",
    )
    doc_id = ingest_md(conn, cfg, md, title="语法讲义", subject="语文",
                       doc_type="workbook", client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no, title, content_md FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        rows = cur.fetchall()
        assert len(rows) == 2
        assert rows[0][1] == "一、修辞手法" and "燕子" in rows[0][2]
        # 入库即向量化:章节 chunk 已就位(不经 structure/approve)
        cur.execute(
            """SELECT meta->>'kind', meta->>'chapter', meta->>'subject', seg_no
               FROM chunks WHERE document_id=%s AND chapter_id IS NOT NULL ORDER BY seg_no""",
            (doc_id,),
        )
        chunks = cur.fetchall()
        assert chunks and chunks[0] == ("chapter", "第 1 讲 一、修辞手法", "语文", 1)
    # 章稿落盘镜像
    assert (cfg.storage_dir / doc_id / "chapters" / "c01.md").exists()


def test_ingest_md_idempotent_by_path(conn, cfg, tmp_path):
    from kb.text_ingest import ingest_md

    md = tmp_path / "same.md"
    md.write_text("# 唯一章\n\n内容\n", encoding="utf-8")
    d1 = ingest_md(conn, cfg, md, title="t", client=_FakeEmbed())
    d2 = ingest_md(conn, cfg, md, title="t", client=_FakeEmbed())
    assert d1 == d2  # source_path 为幂等键
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM chapters WHERE document_id=%s", (d1,))
        assert cur.fetchone()[0] == 1
        cur.execute(
            "SELECT count(*) FROM chunks WHERE document_id=%s", (d1,))
        assert cur.fetchone()[0] == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_md_ingest.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'kb.text_ingest'`）

- [ ] **Step 3: 实现 text_ingest.py**

`pipeline/kb/text_ingest.py`（新建；`split_chapters` 从 `docx_ingest.py` 原样搬来）：

```python
"""文本类资料入库(docx/md 共用):按标题切章 -> chapters.content_md -> 章节向量化。

md 直接读文件;docx 先经 pandoc(kb/docx_ingest.py)。两路共用切章与落库。
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from kb.config import Config
from kb.export_md import export_chapter_mds

_HEADING_RE = re.compile(r"^#{1,2}\s+(.+?)\s*#*$", re.M)


def split_chapters(markdown: str, doc_title: str) -> list[tuple[str, str]]:
    """按一/二级标题切章,卷首并入第一章;无标题则整份单章。返回 [(title, content_md)]。"""
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


def store_document_chapters(conn, cfg: Config, path, title: str,
                            subject: str | None, grade: str | None, doc_type: str,
                            chapters: list[tuple[str, str]],
                            doc_id: str | None = None, client=None) -> str:
    """幂等落库:source_path(绝对路径)为键;doc_id 可由调用方预解析(docx 抽图目录需要)。
    落库后立即章节向量化(失败不阻断,可 kb.cli embed 补跑)。"""
    path = str(Path(path).resolve())
    if doc_id is None:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM documents WHERE source_path=%s", (path,))
            row = cur.fetchone()
        doc_id = str(row[0]) if row else str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, grade, doc_type, source_path,
                                      page_count, has_text_layer, status)
               VALUES (%s,%s,%s,%s,%s,%s,0,true,'parsed')
               ON CONFLICT (id) DO NOTHING""",
            (doc_id, title, subject, grade, doc_type, path),
        )
        for i, (ch_title, content) in enumerate(chapters, start=1):
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (document_id, chapter_no) DO NOTHING""",
                (str(uuid.uuid4()), doc_id, i, ch_title, content),
            )
    export_chapter_mds(conn, cfg, doc_id)
    try:
        from kb.embed import embed_chapters
        embed_chapters(conn, cfg, doc_id, client=client)
    except Exception as e:  # noqa: BLE001 - 向量化失败不阻断入库,可 kb.cli embed 补跑
        print(f"warn: 章节向量化失败({e}),稍后可用 `kb.cli embed {doc_id}` 补跑")
    return doc_id


def ingest_md(conn, cfg: Config, path, title: str,
              subject: str | None = None, grade: str | None = None,
              doc_type: str = "exam", client=None) -> str:
    """md 入库:整份文件即 markdown,无 pandoc。"""
    text = Path(path).read_text(encoding="utf-8")
    return store_document_chapters(
        conn, cfg, path, title, subject, grade, doc_type,
        split_chapters(text, title), client=client)
```

- [ ] **Step 4: 重构 docx_ingest.py 复用**

`pipeline/kb/docx_ingest.py` 整体替换为：

```python
"""docx 入库:pandoc -> gfm markdown -> 共用文本入库路径(kb/text_ingest.py)。

docx 无页概念:不写 pages/blocks;图片 --extract-media 落 storage/<doc_id>/,
markdown 里的相对引用(media/...)相对该目录解析。
"""
from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

from kb.config import Config
from kb.text_ingest import split_chapters, store_document_chapters


def docx_to_markdown(docx_path, extract_dir: Path) -> str:
    """pandoc docx -> gfm;图片抽到 extract_dir(markdown 引用为其相对路径)。"""
    Path(extract_dir).mkdir(parents=True, exist_ok=True)
    try:
        out = subprocess.run(
            ["pandoc", "-f", "docx", "-t", "gfm", f"--extract-media={extract_dir}", str(docx_path)],
            capture_output=True, text=True,
        )
    except FileNotFoundError:
        raise SystemExit("需要 pandoc: https://pandoc.org/installing.html") from None
    if out.returncode != 0:
        raise SystemExit(f"pandoc 转换失败: {out.stderr.strip()}")
    return out.stdout


def ingest_docx(conn, cfg: Config, path, title: str,
                subject: str | None = None, grade: str | None = None,
                doc_type: str = "exam", client=None) -> str:
    """幂等可重跑:source_path(绝对路径)为幂等键,已建档则复用 doc_id 补写章节。"""
    # 存绝对路径:source_path 是幂等键,相对路径会因 CWD 不同而重复建档
    path = str(Path(path).resolve())
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM documents WHERE source_path=%s", (path,))
        row = cur.fetchone()
    doc_id = str(row[0]) if row else str(uuid.uuid4())
    # pandoc 先于建档:转换失败不留孤儿 documents 行
    markdown = docx_to_markdown(path, Path(cfg.storage_dir) / doc_id)
    return store_document_chapters(
        conn, cfg, path, title, subject, grade, doc_type,
        split_chapters(markdown, title), doc_id=doc_id, client=client)
```

- [ ] **Step 5: CLI 分流 .md**

`pipeline/kb/cli.py` 的 ingest 分支改为：

```python
    elif args.cmd == "ingest":
        migrate(conn)
        lower = str(args.pdf).lower()
        if lower.endswith(".docx"):
            from kb.docx_ingest import ingest_docx
            doc_id = ingest_docx(conn, cfg, args.pdf, args.title,
                                 subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        elif lower.endswith(".md"):
            from kb.text_ingest import ingest_md
            doc_id = ingest_md(conn, cfg, args.pdf, args.title,
                               subject=args.subject, grade=args.grade, doc_type=args.doc_type)
        else:
            doc_id = ingest(conn, cfg, args.pdf, args.title,
                            subject=args.subject, grade=args.grade, doc_type=args.doc_type,
                            start=args.start, end=args.end)
        print(f"完成 document_id={doc_id}")
```

- [ ] **Step 6: 更新 docx 既有测试保封闭**

`pipeline/tests/test_docx_ingest.py` 中给 `ingest_docx` 调用补 `client=_FakeEmbed()`（在文件内加同款假客户端类，见 test_md_ingest.py 的 `_FakeEmbed`），避免测试真调 ollama。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_md_ingest.py tests/test_docx_ingest.py -q`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add pipeline/kb/text_ingest.py pipeline/kb/docx_ingest.py pipeline/kb/cli.py pipeline/tests/test_md_ingest.py pipeline/tests/test_docx_ingest.py
git commit -m "feat(ingest): md 入库路径;docx/md 共用切章落库,入库即章节向量化"
```

---

### Task 4: review_api.approve_item 自动向量化

**Files:**

- Modify: `pipeline/kb/review_api.py`
- Modify: `pipeline/tests/test_review_items.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_review_items.py` 追加（文件已有 `TestClient`/`create_app` 的 client fixture 与 `doc_with_items` fixture；先读该文件确认 fixture 返回结构，`item_id` 从 `doc_with_items` 拿）：

```python
class _FakeEmbed:
    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()


def test_approve_item_embeds_immediately(conn, doc_with_items):
    """approve 即向量化:qc_status=approved 的同时 chunks 立刻可见。"""
    doc_id, item_id = doc_with_items
    app = create_app(lambda: conn, embed_client=_FakeEmbed())
    c = TestClient(app)
    assert c.post(f"/api/items/{item_id}/approve").status_code == 200
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chunks WHERE item_id=%s", (item_id,))
        assert cur.fetchone()[0] == 1


def test_approve_item_survives_embed_failure(conn, doc_with_items):
    """向量化失败不阻断 approve(可 kb.cli embed 补跑)。"""

    class _Boom:
        class embeddings:
            @staticmethod
            def create(model, input):
                raise RuntimeError("ollama down")

    doc_id, item_id = doc_with_items
    app = create_app(lambda: conn, embed_client=_Boom())
    c = TestClient(app)
    resp = c.post(f"/api/items/{item_id}/approve")
    assert resp.status_code == 200
    with conn.cursor() as cur:
        cur.execute("SELECT qc_status FROM items WHERE id=%s", (item_id,))
        assert cur.fetchone()[0] == "approved"
```

注意：若 `doc_with_items` fixture 的条目 `qc_status` 已是 approved 或 `content_md` 为空，先按 fixture 现状调整断言（embed 门禁要求 `content_md IS NOT NULL` 且 approved 无 chunk）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql/kb_test uv run pytest tests/test_review_items.py -q -k approve`
Expected: `test_approve_item_embeds_immediately` FAIL（chunks 为 0；且 `create_app` 尚无 `embed_client` 参数会 TypeError）

- [ ] **Step 3: 实现**

`pipeline/kb/review_api.py`：

签名改为（保持既有参数顺序，追加 `embed_client=None`）：

```python
def create_app(get_conn: Callable[[], psycopg.Connection] | None = None,
               vlm_client=None, cfg=None, embed_client=None) -> FastAPI:
```

docstring 追加一行：`embed_client 可注入测试用的假 embedding 客户端（approve 即向量化用）。`

`approve_item` 替换为：

```python
    @app.post("/api/items/{item_id}/approve")
    def approve_item(item_id: str):
        """人工确认条目 -> qc_status=approved,并立即向量化(失败不阻断,可 kb.cli embed 补跑)。"""
        from kb.embed import embed_approved_items
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE items SET qc_status='approved' WHERE id=%s RETURNING id",
                (item_id,),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="item 不存在")
            cur.execute(
                "UPDATE review_queue SET status='approved' WHERE item_id=%s AND status='pending'",
                (item_id,),
            )
            try:
                embed_approved_items(conn, _cfg(), client=embed_client)
            except Exception as e:  # noqa: BLE001 - 向量化失败不阻断复核
                print(f"warn: 条目向量化失败({e}),可 kb.cli embed 补跑")
        return {"id": item_id, "qc_status": "approved"}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_review_items.py tests/test_review_api.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add pipeline/kb/review_api.py pipeline/tests/test_review_items.py
git commit -m "feat(review): approve 条目即向量化,不再依赖手工 kb.cli embed"
```

---

### Task 5: 批量通过——kb.embed.approve_items + CLI approve

**Files:**

- Modify: `pipeline/kb/embed.py`
- Modify: `pipeline/kb/cli.py`
- Modify: `pipeline/tests/test_embed.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_embed.py` 追加：

```python
def test_approve_items_bulk_and_embed(conn, doc_chapter):
    from kb.embed import approve_items, embed_chapters

    doc_id, cfg = doc_chapter
    # doc_chapter 已有:例1(approved) 与 1-1(pending);补 needs_review 与 rejected
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter, qc_status)
               VALUES (%s,%s,'exercise','2-1','待复核题','第 1 讲 乘除法竖式谜','needs_review'),
                      (%s,%s,'exercise','2-2','被打回的题','第 1 讲 乘除法竖式谜','rejected')""",
            (str(uuid.uuid4()), doc_id, str(uuid.uuid4()), doc_id))
        cur.execute(
            """INSERT INTO review_queue (item_id, reason)
               SELECT id, 'qc' FROM items WHERE document_id=%s AND label='2-1'""", (doc_id,))
    out = approve_items(conn, cfg, doc_id, client=_FakeEmbed())
    assert out["approved"] == 2  # pending(1-1) + needs_review(2-1);rejected 与已 approved 不动
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM items WHERE document_id=%s
               AND qc_status='approved' AND label IN ('1-1','2-1')""",
            (doc_id,))
        assert cur.fetchone()[0] == 2
        cur.execute(
            """SELECT count(*) FROM review_queue r JOIN items i ON i.id=r.item_id
               WHERE i.document_id=%s AND r.status='pending'""", (doc_id,))
        assert cur.fetchone()[0] == 0  # 复核行一并关闭
        cur.execute(
            "SELECT count(*) FROM chunks WHERE document_id=%s AND item_id IS NOT NULL",
            (doc_id,))
        assert cur.fetchone()[0] == 3  # 例1 + 1-1 + 2-1(approve 即向量化)


def test_approve_items_chapter_filter(conn, doc_chapter):
    from kb.embed import approve_items

    doc_id, cfg = doc_chapter
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, page_start, page_end)
               VALUES (%s,%s,2,'第二章',1,2)""",
            (str(uuid.uuid4()), doc_id))
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter, qc_status)
               VALUES (%s,%s,'exercise','3-1','第二章题','第 2 讲 第二章','pending')""",
            (str(uuid.uuid4()), doc_id))
    out = approve_items(conn, cfg, doc_id, chapter_no=2, client=_FakeEmbed())
    assert out["approved"] == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT qc_status FROM items WHERE document_id=%s AND label='1-1'", (doc_id,))
        assert cur.fetchone()[0] == "pending"  # 第一章不受影响
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_embed.py -q -k approve_items`
Expected: FAIL（`cannot import name 'approve_items'`）

- [ ] **Step 3: 实现**

在 `pipeline/kb/embed.py` 的 `embed_chapters` 之后加：

```python
def approve_items(conn, cfg: Config, doc_id: str, chapter_no: int | None = None,
                  client=None) -> dict:
    """批量通过一个文档(可限章)的条目:非 approved/rejected 一律 approved,
    关闭其 pending 复核行,并立即向量化(条目 + 章节)。88 页练习册不该逐条点 approve。"""
    label = None
    if chapter_no is not None:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT title FROM chapters WHERE document_id=%s AND chapter_no=%s",
                (doc_id, chapter_no),
            )
            row = cur.fetchone()
        if not row:
            raise SystemExit(f"章节不存在: doc={doc_id} 第 {chapter_no} 章")
        label = f"第 {chapter_no} 讲 {row[0]}"
    where = "AND i.chapter=%s" if label else ""
    params: list = [doc_id] + ([label] if label else [])
    with conn.cursor() as cur:
        cur.execute(
            f"""UPDATE items SET qc_status='approved'
                WHERE document_id=%s AND qc_status IN ('pending','auto_passed','needs_review')
                {where}
                RETURNING id""",
            params,
        )
        ids = [str(r[0]) for r in cur.fetchall()]
        if ids:
            cur.execute(
                "UPDATE review_queue SET status='approved' WHERE item_id = ANY(%s) AND status='pending'",
                (ids,),
            )
    n = embed_approved_items(conn, cfg, doc_id, client=client)
    n += embed_chapters(conn, cfg, doc_id, client=client)
    return {"approved": len(ids), "embedded": n}
```

- [ ] **Step 4: CLI 接线**

`pipeline/kb/cli.py`：

参数区（`p_embed` 定义之后）加：

```python
    p_approve = sub.add_parser("approve", help="批量通过条目并自动向量化(可限章)")
    p_approve.add_argument("doc_id")
    p_approve.add_argument("--chapter", type=int, default=None, help="只通过指定章(章号)")
```

命令分支（`elif args.cmd == "embed":` 之前）加：

```python
    elif args.cmd == "approve":
        from kb.embed import approve_items
        out = approve_items(conn, cfg, args.doc_id, chapter_no=args.chapter)
        print(f"通过 {out['approved']} 条,新增向量 {out['embedded']} 条")
```

既有 `embed` 分支改为补跑两类：

```python
    elif args.cmd == "embed":
        from kb.embed import embed_approved_items, embed_chapters
        n = embed_approved_items(conn, cfg, args.doc_id)
        n += embed_chapters(conn, cfg, args.doc_id)
        print(f"新增向量: {n} 条(条目+章节)")
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_embed.py -q`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add pipeline/kb/embed.py pipeline/kb/cli.py pipeline/tests/test_embed.py
git commit -m "feat(cli): approve 批量通过条目并即时刻意向量化;embed 补跑条目+章节"
```

---

### Task 6: TS 检索层——章节命中贯通 + 同章抑制 + itemsOnly

**Files:**

- Modify: `backend/src/retrieval/search.ts`
- Modify: `backend/src/retrieval/search.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/retrieval/search.test.ts` 的 beforeAll 里追加种子（复用既有 doc `11111111-…`；章节挂到该 doc，另建一个 doc 放"无条目章节"对照）：

```ts
    // 章节级向量种子:同 doc 同章(会被条目命中抑制) + 另一 doc 的章节(应保留)
    await pool.query(
      `INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES
        ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 1, '竖式谜', '# 竖式谜\n…'),
        ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 1, '修辞手法', '# 修辞\n…')`,
    );
    await pool.query(
      `INSERT INTO documents (id, title, source_path) VALUES
        ('66666666-6666-6666-6666-666666666666', '语法讲义', '/tmp/y.md')`,
    );
    await pool.query(
      `INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding) VALUES
        ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 1,
         '第 1 讲 竖式谜\n三位数乘两位数 竖式',
         '{"kind":"chapter","chapter":"第 1 讲 竖式谜","doc_title":"书","subject":"数学"}', $1::vector),
        ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', 1,
         '第 1 讲 修辞手法\n比喻句本体',
         '{"kind":"chapter","chapter":"第 1 讲 修辞手法","doc_title":"语法讲义","subject":"语文"}', $1::vector)`,
      [V1],
    );
```

用例（加在 describe 内）：

```ts
  it("章节命中贯通:未拆条文档的内容可被搜到(chapter_id 非 null)", async () => {
    const hits = await hybridSearch(pool, deps, "比喻句本体");
    const chapterHit = hits.find((h) => h.chapter_id === "55555555-5555-5555-5555-555555555555");
    expect(chapterHit).toBeDefined();
    expect(chapterHit!.item_id).toBeNull();
    expect(chapterHit!.chapter).toBe("第 1 讲 修辞手法");
    expect(chapterHit!.doc_title).toBe("语法讲义");
  });

  it("同章抑制:条目级命中时,该章的章节分段不再占位", async () => {
    const hits = await hybridSearch(pool, deps, "竖式", { topK: 10 });
    expect(hits.some((h) => h.item_id === "22222222-2222-2222-2222-222222222222")).toBe(true);
    expect(hits.some((h) => h.chapter_id === "44444444-4444-4444-4444-444444444444")).toBe(false);
  });

  it("itemsOnly:条目检索(试卷匹配用)不返回章节分段", async () => {
    const hits = await hybridSearch(pool, deps, "比喻句本体", { topK: 10, itemsOnly: true });
    expect(hits.every((h) => h.item_id !== null)).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/search.test.ts`
Expected: 三个新用例 FAIL（`chapter_id` 不在返回结构里 / 抑制未实现 / itemsOnly 未实现）

- [ ] **Step 3: 实现**

`backend/src/retrieval/search.ts` 整体替换为：

```ts
/** 双路召回:向量(pgvector)+ BM25(内存)→ RRF k=60 融合 → 同章抑制 → 可选重排。
    chunks 有两类单元:条目(item_id)与章节分段(chapter_id,docx/md 未拆条内容的检索底座)。
    行为对齐 pipeline/kb/embed.py 的 search(mode='hybrid')。 */
import type pg from "pg";
import { bm25Score } from "./bm25.js";

export interface SearchHit {
  item_id: string | null;
  chapter_id?: string | null;
  document_id: string;
  content_md: string;
  score: number;
  rerank_score?: number;
  /** 向量余弦(该条目所有 chunk 的最大值);仅 BM25 命中的条目无此字段。 */
  vec_score?: number;
  [k: string]: unknown;  // meta 展开（label/chapter/subject/doc_title 等）
}

export interface SearchDeps {
  embed: (texts: string[]) => Promise<number[][]>;
  rerank: ((query: string, docs: string[]) => Promise<number[]>) | null;
}

interface ChunkRow {
  item_id: string | null;
  chapter_id: string | null;
  document_id: string;
  content_md: string;
  meta: Record<string, unknown>;
  score?: number;
}

async function vectorHits(
  pool: pg.Pool, vec: number[], topN: number, itemsOnly: boolean,
): Promise<ChunkRow[]> {
  const { rows } = await pool.query(
    `SELECT c.item_id::text, c.chapter_id::text, c.document_id::text, c.content_md, c.meta,
            1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c ${itemsOnly ? "WHERE c.item_id IS NOT NULL" : ""}
     ORDER BY c.embedding <=> $1::vector LIMIT $2`,
    [`[${vec.join(",")}]`, topN],
  );
  return rows;
}

function toHit(r: ChunkRow): SearchHit {
  return {
    item_id: r.item_id, chapter_id: r.chapter_id, document_id: r.document_id,
    content_md: r.content_md, score: r.score ?? 0, ...r.meta,
  };
}

/** 同章已有条目级命中时,抑制该章的章节分段命中(避免同内容重复占位)。 */
export function suppressChapterSegs(hits: SearchHit[]): SearchHit[] {
  const withItems = new Set(
    hits.filter((h) => h.item_id).map((h) => `${h.document_id}|${h.chapter ?? ""}`),
  );
  return hits.filter(
    (h) => h.item_id !== null || !withItems.has(`${h.document_id}|${h.chapter ?? ""}`),
  );
}

export async function hybridSearch(
  pool: pg.Pool,
  deps: SearchDeps,
  query: string,
  opts: { topK?: number; filters?: Record<string, string>; itemsOnly?: boolean } = {},
): Promise<SearchHit[]> {
  const topK = opts.topK ?? 5;
  const itemsOnly = opts.itemsOnly ?? false;
  const [vec] = await deps.embed([query]);
  const vecHits = await vectorHits(pool, vec, 20, itemsOnly);
  const { rows: allChunks } = await pool.query(
    `SELECT item_id::text, chapter_id::text, document_id::text, content_md, meta
     FROM chunks ${itemsOnly ? "WHERE item_id IS NOT NULL" : ""}`,
  );

  const rrf = new Map<string, SearchHit>();
  const hitKey = (r: ChunkRow) => r.item_id ?? `chapter:${r.chapter_id}`;
  vecHits.forEach((r, rank) => {
    const key = hitKey(r);
    const h = rrf.get(key) ?? { ...toHit(r), score: 0 };
    // vec_score 取该条目各 chunk 的最大余弦(一个条目一个 chunk,当前即本身)
    h.vec_score = Math.max(h.vec_score ?? -1, r.score ?? -1);
    h.score += 1 / (60 + rank + 1);
    rrf.set(key, h);
  });
  const lexOrder = bm25Score(query, allChunks.map((r: ChunkRow) => r.content_md), 20);
  lexOrder.forEach(({ index }, rank) => {
    const r = allChunks[index];
    const key = hitKey(r);
    const h = rrf.get(key) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(key, h);
  });

  let candidates = [...rrf.values()].sort((a, b) => b.score - a.score);
  const filters = opts.filters ?? {};
  candidates = candidates.filter((h) =>
    Object.entries(filters).every(([k, v]) => h[k] === v),
  );
  candidates = suppressChapterSegs(candidates);

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

注意既有测试断言 `hit1.item_id === "2222…"` 之类仍成立（item 命中 item_id 不变）；
`SearchHit.item_id` 变为可空后，检查编译错误并顺手修正引用处（`match.ts` / `tools.ts` 在 Task 7、Task 8 处理；此处先让 `npm run build`（tsc）不报错——如有引用处类型错误，先按最小改动 `h.item_id!` 处理的仅限 match.ts，tools.ts 留给 Task 8）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/search.test.ts`
Expected: 全部 PASS（含既有用例）

- [ ] **Step 5: 提交**

```bash
git add backend/src/retrieval/search.ts backend/src/retrieval/search.test.ts
git commit -m "feat(search): 章节级 chunk 命中贯通 + 同章条目优先抑制 + itemsOnly 选项"
```

---

### Task 7: match.ts——试卷匹配只用条目级 chunk

**Files:**

- Modify: `backend/src/retrieval/match.ts`
- Modify: `backend/src/retrieval/match.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/retrieval/match.test.ts` 的 beforeAll 追加一个章节 chunk（同 doc 数学、向量同 mathVec——与查询同向，若不过滤会被当成 top 候选）：

```ts
    await pool.query(
      `INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES
        ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 1, '除法', '# 除法')`,
    );
    await pool.query(
      `INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding) VALUES
        ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 1,
         '第 1 讲 除法\n135 ÷ 5 = 27 讲解',
         '{"kind":"chapter","chapter":"第 1 讲 除法","subject":"数学","doc_title":"数学书"}', $1::vector)`,
      [vec(mathVec)],
    );
```

用例：

```ts
  it("匹配只用条目级 chunk:章节分段不进候选(auto 仍是 item)", async () => {
    const { candidates, auto } = await matchQuestion(
      pool, deps, "135 ÷ 5 = 27", "数学", 0.88);
    expect(auto?.item_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(candidates.every((c) => c.item_id !== null)).toBe(true);
    expect(candidates.some((c) => c.chapter_id === "66666666-6666-6666-6666-666666666666")).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/match.test.ts`
Expected: 新用例 FAIL（章节分段混进候选、甚至抢走 auto——章节 chunk 与查询同向且 BM25 也命中）

- [ ] **Step 3: 实现**

`backend/src/retrieval/match.ts` 中 `hybridSearch` 调用加 `itemsOnly`：

```ts
  const candidates = await hybridSearch(pool, deps, content, {
    topK: 5,
    filters: { subject },
    itemsOnly: true,  // 试卷匹配只对题库条目;章节分段是检索底座,不是可关联的题
  });
```

（topK 5→10 属 Phase 3-B backlog #2，不在本计划改。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/match.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/retrieval/match.ts backend/src/retrieval/match.test.ts
git commit -m "feat(match): 试卷匹配限定条目级 chunk,章节分段不进候选"
```

---

### Task 8: tools.ts——search_items 展示章节命中

**Files:**

- Modify: `backend/src/agent/tools.ts`
- Modify: `backend/src/agent/tools.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/agent/tools.test.ts` 追加用例（deps.search 可注入章节型命中）：

```ts
  it("search_items 展示章节命中(未拆条资料)", async () => {
    const chapterDeps: ToolDeps = {
      pool: deps.pool,
      search: async () => [{
        item_id: null, chapter_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        document_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        content_md: "第 1 讲 修辞手法\n比喻句本体是燕子", score: 0.8,
        chapter: "第 1 讲 修辞手法", doc_title: "语法讲义",
      }],
    };
    const text = await run(chapterDeps, "search_items", { query: "比喻" });
    expect(text).toContain("章节");
    expect(text).toContain("第 1 讲 修辞手法");
    expect(text).toContain("语法讲义");
    expect(text).toContain("燕子");
  });
```

注意：既有 `run` helper 绑定了外层 `deps`，此处需要在测试内定义局部 `run`（复制该 helper 的三行实现，参数换成 `chapterDeps`），或把 `run` 改造为接收 deps 参数——选后者更 DRY：

把文件里的

```ts
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = makeTools(deps).find((t) => t.name === name)!;
```

改为

```ts
  const run = async (d: ToolDeps, name: string, params: Record<string, unknown>) => {
    const tool = makeTools(d).find((t) => t.name === name)!;
```

并同步更新文件内所有既有 `run("xxx", {...})` 调用为 `run(deps, "xxx", {...})`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/agent/tools.test.ts`
Expected: 新用例 FAIL（当前格式化对章节命中输出 `【1】（undefined · 第 1 讲 修辞手法）`——缺"章节"标识且 label 为 undefined）

- [ ] **Step 3: 实现**

`backend/src/agent/tools.ts` 中 `search_items` 的 execute 返回格式化改为：

```ts
      execute: async (_id, params) => {
        const filters: Record<string, string> = {};
        if (params.subject) filters.subject = params.subject;
        if (params.chapter) filters.chapter = params.chapter;
        const hits = await deps.search(params.query, filters);
        if (hits.length === 0) return toText("题库里没有找到相关内容。");
        const line = (h: SearchHit, i: number) => h.item_id
          ? `【${i + 1}】${h.label ?? ""}（${h.doc_title} · ${h.chapter}）\n${h.content_md}`
          : `【${i + 1}】章节 ${h.chapter}（${h.doc_title}）\n${h.content_md}`;
        return toText(hits.map(line).join("\n\n"));
      },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/agent/tools.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/agent/tools.ts backend/src/agent/tools.test.ts
git commit -m "feat(tools): search_items 区分条目/章节命中展示"
```

---

### Task 9: pipeline 检索兼容章节命中（CLI search 与复核页试搜）

**Files:**

- Modify: `pipeline/kb/embed.py`（`_vector_hits` + `search` 的 rrf key）
- Modify: `pipeline/kb/lexical.py`（`bm25_search` 返回 chapter_id，key 不再合并 None）
- Modify: `pipeline/tests/test_embed.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_embed.py` 追加：

```python
def test_search_hybrid_keeps_chapter_hits_separate(conn, doc_chapter):
    """章节命中与条目命中各自成行(不被 None item_id 合并),供 CLI 调试与复核页试搜。"""
    from kb.embed import embed_approved_items, embed_chapters, search

    doc_id, cfg = doc_chapter
    embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,3,'语法小章','# 语法\n比喻句本体是燕子')""",
            (str(uuid.uuid4()), doc_id),
        )
    embed_chapters(conn, cfg, doc_id, client=_FakeEmbed())
    hits = search(conn, cfg, "燕子", mode="hybrid", client=_FakeEmbed())
    assert any(h.get("kind") == "chapter" for h in hits), "章节命中应保留"
    assert any(h.get("label") for h in hits), "条目命中应保留"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_embed.py -q -k keeps_chapter`
Expected: FAIL（hybrid rrf 以 `h["item_id"]` 为 key，章节行 item_id=None 全部合并成一条，`any(kind=chapter)` 可能对但条目/章节互斥覆盖——用例失败即复现）

- [ ] **Step 3: 实现**

`pipeline/kb/embed.py`：

`_vector_hits` 改为：

```python
def _vector_hits(conn, vec: list[float], top_n: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT c.item_id, c.chapter_id, c.content_md, c.meta,
                      1 - (c.embedding <=> %s::vector) AS score
               FROM chunks c ORDER BY c.embedding <=> %s::vector LIMIT %s""",
            (vec, vec, top_n),
        )
        return [
            {"item_id": str(r[0]) if r[0] else None,
             "chapter_id": str(r[1]) if r[1] else None,
             "content_md": r[2], "score": float(r[4]), **(r[3] or {})}
            for r in cur.fetchall()
        ]
```

`search` 中 hybrid 分支的 rrf key 与 vector/bm25 命中统一走 `_hit_key`（在 `search` 上方定义）：

```python
def _hit_key(h: dict) -> str:
    return f"item:{h['item_id']}" if h.get("item_id") else f"chapter:{h.get('chapter_id')}"
```

hybrid 分支改为：

```python
    else:  # hybrid: RRF
        from kb.lexical import bm25_search
        vec = embed_texts(cfg, [query], client=client)[0]
        vec_hits = _vector_hits(conn, vec, 20)
        lex_hits = bm25_search(conn, query, top_k=20)
        rrf: dict[str, dict] = {}
        for rank, h in enumerate(vec_hits):
            e = rrf.setdefault(_hit_key(h), {**h, "score": 0.0})
            e["score"] += 1 / (60 + rank + 1)
        for rank, h in enumerate(lex_hits):
            e = rrf.setdefault(_hit_key(h), {**h, "score": 0.0})
            e["score"] += 1 / (60 + rank + 1)
        candidates = sorted(rrf.values(), key=lambda h: -h["score"])
```

`pipeline/kb/lexical.py` 的 `bm25_search` 改为：

```python
def bm25_search(conn, query: str, top_k: int = 20) -> list[dict]:
    """对全部 chunks 做 BM25。返回 [{item_id, chapter_id, content_md, bm25, **meta}]，降序。"""
    with conn.cursor() as cur:
        cur.execute("SELECT item_id, chapter_id, content_md, meta FROM chunks")
        rows = cur.fetchall()
    if not rows:
        return []
    docs = [(r[0], r[1], r[2], r[3], Counter(tokenize(r[2]))) for r in rows]
    avgdl = sum(sum(d[4].values()) for d in docs) / len(docs)
    q_terms = tokenize(query)
    df: Counter = Counter()
    for _iid, _cid, _c, _m, tf in docs:
        for t in set(tf):
            df[t] += 1
    n_docs = len(docs)
    scored = []
    for iid, cid, content, meta, tf in docs:
        dl = sum(tf.values())
        score = 0.0
        for t in q_terms:
            if t not in tf:
                continue
            idf = math.log(1 + (n_docs - df[t] + 0.5) / (df[t] + 0.5))
            score += idf * tf[t] * (_K1 + 1) / (tf[t] + _K1 * (1 - _B + _B * dl / avgdl))
        scored.append({"item_id": str(iid) if iid else None,
                       "chapter_id": str(cid) if cid else None,
                       "content_md": content, "bm25": score, **(meta or {})})
    scored.sort(key=lambda h: -h["bm25"])
    return scored[:top_k]
```

CLI `search` 输出行（`kb/cli.py`）把 `h.get('label')` 兜底为章节标签：

```python
            print(f"{score:.3f}\t{h.get('doc_title')} · {h.get('chapter')} · "
                  f"{h.get('label') or '章节'}\t{(h['content_md'] or '')[:60]}")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_embed.py tests/test_hybrid_search.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add pipeline/kb/embed.py pipeline/kb/lexical.py pipeline/kb/cli.py pipeline/tests/test_embed.py
git commit -m "fix(search): pipeline 侧检索兼容章节命中,rrf key 区分条目/章节"
```

---

### Task 10: 测试库防误清守卫

**背景：** `kb` 库当前为空、原因不明。
pipeline 的 `clean_db` fixture 对 `KB_TEST_DATABASE_URL` 直接 `DROP SCHEMA public CASCADE`——一旦该变量误指向生产库（如 `postgresql://localhost/kb`），真实资料全部蒸发。
backend 侧 `resetDbForTest` 已有"库名须含 test"守卫，pipeline 侧没有。

**Files:**

- Modify: `pipeline/kb/db.py`
- Modify: `pipeline/tests/conftest.py`
- Modify: `pipeline/tests/test_db.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_db.py` 追加：

```python
def test_ensure_test_database_rejects_production_db(monkeypatch):
    """KB_TEST_DATABASE_URL 与 KB_DATABASE_URL 同库时,DROP SCHEMA 前置守卫必须拒绝。"""
    from kb.db import ensure_test_database

    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    with pytest.raises(RuntimeError, match="拒绝"):
        ensure_test_database("postgresql://localhost/kb")
    # 不同库放行
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    ensure_test_database("postgresql://localhost/kb_test")


def test_ensure_test_database_reads_dotenv(monkeypatch, tmp_path):
    """环境变量未设时回落读 pipeline/.env 的 KB_DATABASE_URL。"""
    from kb.db import ensure_test_database

    env = tmp_path / ".env"
    env.write_text("KB_DATABASE_URL=postgresql://localhost/prod_kb\n", encoding="utf-8")
    monkeypatch.delenv("KB_DATABASE_URL", raising=False)
    monkeypatch.setattr("kb.db._ENV_FILE", env)  # 测试可注入 env 文件路径
    with pytest.raises(RuntimeError):
        ensure_test_database("postgresql://localhost/prod_kb")
```

（文件顶部如无 `import pytest`，补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py -q -k ensure_test`
Expected: FAIL（`ensure_test_database` 不存在）

- [ ] **Step 3: 实现**

`pipeline/kb/db.py` 顶部补 `import os`，并追加：

```python
_ENV_FILE = MIGRATIONS_DIR.parent / ".env"


def _db_name(url: str) -> str:
    return url.rstrip("/").split("/")[-1]


def ensure_test_database(test_url: str) -> None:
    """DROP SCHEMA 前置守卫:测试库不得指向 .env 的 KB_DATABASE_URL 同库。
    库放空原因不明的一次教训:守卫必须先于任何破坏性操作。"""
    prod = os.environ.get("KB_DATABASE_URL")
    if prod is None:
        from dotenv import dotenv_values
        prod = dotenv_values(_ENV_FILE).get("KB_DATABASE_URL") if _ENV_FILE.exists() else None
    if prod and _db_name(prod) == _db_name(test_url):
        raise RuntimeError(
            f"测试库 {test_url} 指向了 KB_DATABASE_URL 同库({_db_name(test_url)}),"
            "拒绝 DROP SCHEMA——请用独立测试库(如 postgresql://localhost/kb_test)")
```

`pipeline/tests/conftest.py` 的 `clean_db` 在连接前调用守卫：

```python
@pytest.fixture()
def clean_db():
    """重置 schema（含 schema_migrations）且不跑 migration，供直接测试 migrate 本身。

    每个测试拿到全新 schema，天然隔离，无需 truncate 清表。
    """
    from kb.db import ensure_test_database

    url = os.environ.get("KB_TEST_DATABASE_URL")
    if not url:
        pytest.skip("需要 KB_TEST_DATABASE_URL（如 postgresql://localhost/kb_test）")
    ensure_test_database(url)
    c = psycopg.connect(url, autocommit=True)
```

（其余不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS（kb_test 与 kb 不同名，守卫放行）

- [ ] **Step 5: 验证守卫真实拦截**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb uv run pytest tests/test_db.py -q -k migrate_creates`
Expected: ERROR/FAIL，报错含"拒绝 DROP SCHEMA"（证明误指生产库时被拦下）

- [ ] **Step 6: 提交**

```bash
git add pipeline/kb/db.py pipeline/tests/conftest.py pipeline/tests/test_db.py
git commit -m "fix(safety): pipeline 测试库防误清守卫,拒绝指向 KB_DATABASE_URL 同库"
```

---

### Task 11: AGENTS.md 入库工作流修正

**Files:**

- Modify: `AGENTS.md`（仓库根）

- [ ] **Step 1: 更新工作流**

把"资料入库工作流"一节替换为（对照真实链路：入库 → 拆条 → 复核通过 → 可检索；docx/md 入库即章节向量化）：

```markdown
## 资料入库工作流

用户提供文档（PDF/docx/md）要求入库时：

1. 先从文件名和内容推断 `--subject`（语文/数学/英语/…）与 `--type`（workbook 练习册 / exam 试卷）。
2. **科目判断不了就先提问让用户选**，确认后再执行，不要猜。
3. 入库命令（在 pipeline/ 下）：
   `uv run python -m kb.cli ingest <文件> --title <书名> --subject <科目> --type <类型>`
   pdf / docx / md 同一条命令，按扩展名自动分流。
   docx/md 入库即完成**章节向量化**——不拆条也能被聊天检索到。
4. PDF（docx/md 可选）跑 `structure <doc_id>` 拆条成题目级条目。
5. 批量复核通过：`approve <doc_id>`（可 `--chapter N` 限章）。
   通过即自动向量化，之后聊天可检索到条目级内容；
   也可在复核页逐条 approve（同样即时刻意向量化）。
6. 落盘镜像：`export <doc_id>`。
```

- [ ] **Step 2: 自查**

通读 AGENTS.md 全文，确认没有其它地方仍写"ingest → structure → export 就完成"的旧链路描述。

- [ ] **Step 3: 提交**

```bash
git add AGENTS.md
git commit -m "docs: 入库工作流补全复核/向量化步骤,收录 md 类型"
```

---

### Task 12: E2E——md 入库到聊天检索全链路

**Files:**

- Create: `e2e/specs/searchability.spec.ts`

- [ ] **Step 1: 写用例**

`e2e/specs/searchability.spec.ts`（编排复用 playwright.config 的三服务；模式对齐 chat-session.spec.ts）：

```ts
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 检索可达性全链路 E2E:md 上传(CLI ingest) -> 入库即章节向量化 -> 聊天检索引用 -> DB 章级 chunk 断言。
    覆盖修复核心:"照工作流走完仍然搜不到"。真实栈(三服务 + ollama bge-m3 + PostgreSQL)。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const TITLE = `E2E-${RUN}-语文语法讲义`;
const KEYWORD = `E2E${RUN}燕子魔法词`;

const pool = new pg.Pool({ connectionTimeoutMillis: 5_000, connectionString: DB_URL });

test("md 入库即向量化,聊天能检索到章节内容", async ({ page }) => {
  // 1) 写 md 并 CLI 入库(不经 structure/approve,验证章节级检索底座)
  const dir = path.join(tmpdir(), `kb-e2e-md-${RUN}`);
  mkdirSync(dir, { recursive: true });
  const md = path.join(dir, "grammar.md");
  writeFileSync(
    md,
    `# 一、修辞手法\n\n${KEYWORD} 出现在比喻句里,本体是燕子。\n\n# 二、标点符号\n\n省略号表示语意未尽。\n`,
    "utf-8",
  );
  execSync(
    `uv run python -m kb.cli ingest "${md}" --title "${TITLE}" --subject 语文 --type workbook`,
    { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline"), stdio: "pipe" },
  );

  // 2) DB:章节级 chunk 已就位(meta.kind=chapter)
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE d.title = $1 AND c.chapter_id IS NOT NULL AND c.meta->>'kind' = 'chapter'`,
    [TITLE],
  );
  expect(n).toBeGreaterThan(0);

  // 3) UI:聊天问唯一关键词,回复必须引用资料内容(模型必须调 search_items 才知道)
  await page.goto("/");
  await page.getByPlaceholder(/问点什么/).fill(`${KEYWORD} 讲的是什么?请先搜题库再回答。`);
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", {
    timeout: 240_000,
  });
  const reply = (await page.locator(".msg:last-child .bubble").textContent()) ?? "";
  expect(reply).not.toContain("出错了");
  expect(reply).toContain("燕子");
});

test.afterAll(async () => {
  // documents 级联 chapters/items/chunks;llm_calls.document_id 无 FK,残留可接受(计量流水)
  await pool.query("DELETE FROM documents WHERE title LIKE $1", [`E2E-${RUN}-%`]);
  await pool.end();
});
```

- [ ] **Step 2: 运行**

Run: `cd e2e && npx playwright test specs/searchability.spec.ts`
Expected: PASS（若聊天回复偶发不含"燕子"，先人工看回复内容——大概率是模型没调工具，此时把 prompt 收紧为「必须先调用搜题库工具查询 E2E…」再重跑；不允许跳过工具直答）

- [ ] **Step 3: 全量 e2e 回归**

Run: `cd e2e && npm test`
Expected: 全部 PASS（串行，无库竞争）

- [ ] **Step 4: 提交**

```bash
git add e2e/specs/searchability.spec.ts
git commit -m "feat(e2e): md 入库→章节向量化→聊天检索全链路用例"
```

---

### Task 13: 真实资料重入库验收（manual acceptance）

**背景：** `kb` 库为空是"查询不到资料"的现状起点。
本任务把 `resources/` 的真实资料重新入库并验收可检索。
PDF 是扫描件，走 VLM 管线，分钟级耗时 + 消耗远端 token——分批做。

- [ ] **Step 1: docx 两份入库并验证即时可检索**

```bash
cd pipeline
uv run python -m kb.cli ingest "../resources/语法一阶 期末测试（公众号：）.docx" \
  --title "语法一阶 期末测试" --subject 英语 --type exam
uv run python -m kb.cli ingest "../resources/语法二阶 期末测试（公众号：）.docx" \
  --title "语法二阶 期末测试" --subject 英语 --type exam
```

Expected: 各输出 `完成 document_id=<uuid>`，且无 "warn: 章节向量化失败"。

验证：

```bash
uv run python -m kb.cli search "语法 时态" --top-k 5
```

Expected: 返回语法讲义的章节命中（`章节` 标签 + 章标题）。

再打开前端聊天页（`node scripts/start.mjs` 后访问 :5200），问"语法一阶里关于时态的内容有哪些"。
Expected: 回复引用《语法一阶 期末测试》章节内容，而非"题库里没有找到相关内容"。

- [ ] **Step 2: 一份 PDF 全链路（ingest → structure → approve → 检索）**

选最小的 PDF 先做（`26春1下数学北师大学霸提优大试卷.pdf`）：

```bash
cd pipeline
uv run python -m kb.cli ingest "../resources/26春1下数学北师大学霸提优大试卷.pdf" \
  --title "学霸提优大试卷 数学一年级下" --subject 数学 --grade 一年级 --type exam
uv run python -m kb.cli structure <doc_id>
uv run python -m kb.cli approve <doc_id>
uv run python -m kb.cli export <doc_id>
```

Expected: approve 输出 `通过 N 条,新增向量 M 条(条目+章节)`。

聊天页问"一年级下数学试卷里有没有关于退位减法的题"。
Expected: 命中试卷条目（题目级）。

- [ ] **Step 3: 其余三份 PDF 按同配方入库**

`2025秋7星学霸题中题数学4年级第7辑.pdf`（workbook）、`26春3下数学北师大学霸提优大试卷.pdf`（exam）、`26春《学霸寒假计算大通关》四年级人教数学.pdf`（workbook）。
逐份执行 Step 2 的四条命令（科目/年级/类型按文件名推断）。

- [ ] **Step 4: 验收清单**

- [ ] `kb.cli status` 六份文档齐全
- [ ] 聊天页各科各问 2 个问题（数学计算/英语语法），全部有出处命中
- [ ] `SELECT count(*) FROM chunks;` > 0 且含 item 级与 chapter 级
- [ ] 复核页（旧静态页）逐条 approve 一道题，聊天立即可搜到（approve 即向量化）

- [ ] **Step 5: 提交（如有 fixup）**

本任务原则上无代码改动；
若真实资料暴露出管线 bug，修复后按 TDD 补测试再提交：

```bash
git add -A
git commit -m "fix: 真实资料重入库暴露问题的修复"
```

---

## Self-Review 记录

- **Spec 覆盖**：用户确认的四项 Phase 3 问题中，本计划覆盖"查询不到资料"（Task 4/5/6/7/8/11/12/13）与"doc/md 向量化"（Task 1/2/3）；"复核页迁移"与"backlog"分别由 Phase 3-B/3-C 计划承接（3-B 前置依赖本计划的 search.ts 新结构）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码；Task 4 Step 1 对 fixture 现状的不确定点已写明核对方式。
- **类型一致性**：`SearchHit.item_id: string | null`（Task 6 定义）与 Task 7 match 断言 `c.item_id !== null`、Task 8 的 `h.item_id` 分支一致；`embed_chapters(conn, cfg, doc_id, client)` 在 Task 2 定义、Task 3/5 调用签名一致；`approve_items(conn, cfg, doc_id, chapter_no, client)` 在 Task 5 定义与 CLI 调用一致；`ensure_test_database(test_url)` 在 Task 10 定义、conftest 调用一致。
- **已知妥协**：Task 9 只让 pipeline 侧检索"不崩不合并"，章节命中的完整体验（试搜 UI）在 3-C 复核页迁移时重做；e2e 聊天断言依赖模型确实调用工具，用唯一关键词 + 显式指令压低 flake 概率。
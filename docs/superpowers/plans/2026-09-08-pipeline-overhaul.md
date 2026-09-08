# 资料入库流水线打通 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通资料入库完整流水线：docx/md 可配 ~500 字符 chunk（含 overlap）、--type exam 试卷走 LLM 按题拆条、PaddleOCR 版面切块在本机生效、资料库详情页支持全文/chunk/OCR 分块三视图。

**Architecture:** 改动集中在四处：pipeline 的 `embed.py`（分段函数加 overlap 参数 + 配置化）、新增 `structure_exam.py`（整卷转录文本 → 大题 section → 文本 LLM 拆题 → 复用 items/pair_items/approve 链路）、backend 新增 `GET /api/library/:id/content`、frontend `LibraryDetail` 加全文视图并复用 `PageDetail` 做 OCR 分块查看。
不改 schema；试卷拆题产物进现有 `items` 表，与练习册同构。

**Tech Stack:** Python（psycopg/OpenAI 兼容客户端，pipeline 用 `uv run`）、Hono + pg（backend）、React + react-markdown（frontend）、Playwright（e2e）。

**Spec:** `docs/superpowers/specs/2026-09-08-pipeline-overhaul-design.md`

**前置说明：**

- pipeline 测试需要 `KB_TEST_DATABASE_URL`（如 `postgresql://localhost/kb_test`），运行命令：`cd pipeline && uv run pytest tests/ -x -q`。
- backend 测试：`cd backend && npm test`。
- frontend 无单测，由 e2e 覆盖；e2e：`cd e2e && npm test`（Playwright 自动拉起三服务，需本机 ollama + PostgreSQL）。
- `Edit`/`Read` 工具拒绝 `.env` 文件，改 `pipeline/.env` 用 bash append + grep 验证（不读取全文）。

---

### Task 1: chunk 配置进 Config + .env 开启 paddleocr

**Files:**
- Modify: `pipeline/kb/config.py`
- Modify: `pipeline/.env.example`
- Modify: `pipeline/.env`（本机配置，bash 追加）
- Test: `pipeline/tests/test_config.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_config.py` 末尾追加：

```python
def test_load_config_chunk_defaults(tmp_path, monkeypatch):
    """章节 chunk 粒度可配：默认 500 字符 + 10% overlap。"""
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_CHUNK_MAX_CHARS", raising=False)
    monkeypatch.delenv("KB_CHUNK_OVERLAP_RATIO", raising=False)
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.chunk_max_chars == 500
    assert cfg.chunk_overlap_ratio == 0.1
    monkeypatch.setenv("KB_CHUNK_MAX_CHARS", "800")
    monkeypatch.setenv("KB_CHUNK_OVERLAP_RATIO", "0.2")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.chunk_max_chars == 800
    assert cfg.chunk_overlap_ratio == 0.2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_config.py::test_load_config_chunk_defaults -q`
Expected: FAIL（`AttributeError: 'Config' object has no attribute 'chunk_max_chars'`）

- [ ] **Step 3: 实现**

`pipeline/kb/config.py`：dataclass 加两个字段（放在 `trajectory_level` 之前）：

```python
    embed_model: str = "bge-m3"
    chunk_max_chars: int = 500  # KB_CHUNK_MAX_CHARS：章节向量化分段上限
    chunk_overlap_ratio: float = 0.1  # KB_CHUNK_OVERLAP_RATIO：相邻 chunk 尾部重叠比例
    trajectory_level: str = "simple"  # KB_TRAJECTORY_LEVEL: verbose|simple|off
```

`load_config` 返回值里加两行（放在 `embed_model=` 之后）：

```python
        embed_model=os.environ.get("KB_EMBED_MODEL", "bge-m3"),
        chunk_max_chars=int(os.environ.get("KB_CHUNK_MAX_CHARS", "500")),
        chunk_overlap_ratio=float(os.environ.get("KB_CHUNK_OVERLAP_RATIO", "0.1")),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_config.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 更新 .env.example 和本机 .env**

`pipeline/.env.example` 末尾追加：

```
# 章节向量化分段：chunk 字符上限与相邻重叠比例
KB_CHUNK_MAX_CHARS=500
KB_CHUNK_OVERLAP_RATIO=0.1
```

本机 `pipeline/.env` 开启 PaddleOCR 版面切块（bash 追加，不读全文）：

```bash
grep -q '^KB_LAYOUT_ENGINE=' pipeline/.env \
  && echo 'pipeline/.env 已有 KB_LAYOUT_ENGINE，请手动确认值为 paddleocr' \
  || echo 'KB_LAYOUT_ENGINE=paddleocr' >> pipeline/.env
grep -n '^KB_LAYOUT_ENGINE' pipeline/.env
```

Expected: 输出 `KB_LAYOUT_ENGINE=paddleocr` 所在行。

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/config.py pipeline/tests/test_config.py pipeline/.env.example
git commit -m "feat(pipeline): 章节 chunk 粒度配置化（KB_CHUNK_MAX_CHARS/KB_CHUNK_OVERLAP_RATIO）"
```

注意：`pipeline/.env` 在 .gitignore 里，不要 add。

---

### Task 2: segment_chapter 支持 overlap + embed_chapters 接配置

**Files:**
- Modify: `pipeline/kb/embed.py`（`segment_chapter` 65-82 行、`embed_chapters` 105 行附近）
- Test: `pipeline/tests/test_embed.py`（追加纯函数测试，不需要 DB）

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_embed.py` 末尾追加：

```python
def test_segment_chapter_default_unchanged():
    """默认参数保持 1600/无重叠（flat 页向量化路径不受影响）。"""
    from kb.embed import segment_chapter
    segs = segment_chapter("甲" * 5000)
    assert [len(s) for s in segs] == [1600, 1600, 1600, 200]


def test_segment_chapter_paragraph_aggregation_500():
    """空行分段落、按序聚合到 500 字符切 chunk。"""
    from kb.embed import segment_chapter
    paras = [f"第{i}段 " + "字" * 180 for i in range(6)]  # 每段 184 字符
    segs = segment_chapter("\n\n".join(paras), max_chars=500)
    assert len(segs) == 3  # 184*2+2=370 ≤500，再加一段 556 >500
    assert all(len(s) <= 500 for s in segs)


def test_segment_chapter_overlap():
    """overlap_chars：相邻 chunk 携带上一段尾部重叠。"""
    from kb.embed import segment_chapter
    text = "\n\n".join(["甲" * 300, "乙" * 300, "丙" * 300])
    segs = segment_chapter(text, max_chars=400, overlap_chars=50)
    assert segs[0] == "甲" * 300
    assert segs[1].startswith("甲" * 50) and segs[1].endswith("乙" * 300)
    assert segs[2].startswith("乙" * 50) and segs[2].endswith("丙" * 300)


def test_embed_chapters_uses_chunk_config(conn, tmp_path):
    """embed_chapters 按 cfg.chunk_max_chars/overlap 分段（spy segment 调用参数）。"""
    import uuid

    from kb.config import Config
    from kb import embed as embed_mod

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        chunk_max_chars=300,
        chunk_overlap_ratio=0.2,
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/c.md') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES (%s,%s,1,'章','内容')",
            (str(uuid.uuid4()), doc_id),
        )
    seen = []

    class FakeEmbed:
        class embeddings:
            @staticmethod
            def create(model, input):
                class D:
                    embedding = [0.0] * 1024

                class R:
                    data = [D()]

                return R()

    orig = embed_mod.segment_chapter

    def spy(content_md, max_chars=1600, overlap_chars=0):
        seen.append((max_chars, overlap_chars))
        return orig(content_md, max_chars=max_chars, overlap_chars=overlap_chars)

    embed_mod.segment_chapter = spy
    try:
        n = embed_mod.embed_chapters(conn, cfg, doc_id, client=FakeEmbed())
    finally:
        embed_mod.segment_chapter = orig
    assert n == 1
    assert seen == [(300, 60)]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_embed.py -q`
Expected: `test_segment_chapter_overlap` FAIL（segment_chapter 没有 overlap_chars 参数）；`test_embed_chapters_uses_chunk_config` FAIL（传参是 1600/0）

- [ ] **Step 3: 实现**

`pipeline/kb/embed.py` 替换 `segment_chapter`：

```python
def segment_chapter(content_md: str, max_chars: int = 1600,
                    overlap_chars: int = 0) -> list[str]:
    """章稿分段:空行分段落,聚合成 ≤max_chars 的段;超长单段硬切。
    overlap_chars>0 时相邻段携带上一段尾部重叠（章节向量化用；flat 页路径默认无重叠）。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", content_md or "") if p.strip()]
    segs: list[str] = []
    buf = ""
    for p in paras:
        if buf and len(buf) + len(p) + 2 <= max_chars:
            buf = f"{buf}\n\n{p}"
        else:
            if buf:
                segs.append(buf)
                buf = buf[-overlap_chars:] if overlap_chars > 0 else ""
            buf = f"{buf}\n\n{p}" if buf else p
        while len(buf) > max_chars:  # 单段超长:硬切（带重叠回退）
            segs.append(buf[:max_chars])
            buf = (buf[max_chars - overlap_chars:]
                   if 0 < overlap_chars < max_chars else buf[max_chars:])
    if buf:
        segs.append(buf)
    return segs
```

`embed_chapters` 里把：

```python
        for i, seg in enumerate(segment_chapter(r[4]), start=1):
```

改为：

```python
        overlap = int(cfg.chunk_max_chars * cfg.chunk_overlap_ratio)
        for i, seg in enumerate(segment_chapter(
                r[4], max_chars=cfg.chunk_max_chars, overlap_chars=overlap), start=1):
```

注意 `flat.embed_flat_pages` 调用 `segment_chapter(text)` 不传参，保持 1600/无重叠，不要动它。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_embed.py tests/test_flat.py tests/test_reindex.py -q`
Expected: 全部 PASS（test_flat/test_reindex 是回归保护）

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/embed.py pipeline/tests/test_embed.py
git commit -m "feat(pipeline): segment_chapter 支持 overlap，章节向量化按配置切 ~500 字符段"
```

---

### Task 3: structure_exam 模块——试卷 LLM 拆题

**Files:**
- Create: `pipeline/kb/structure_exam.py`
- Test: `pipeline/tests/test_structure_exam.py`

- [ ] **Step 1: 写失败测试**

创建 `pipeline/tests/test_structure_exam.py`：

```python
import uuid

import pytest

from kb.config import Config

_FENCE = "`" * 3


def _client_seq(texts):
    """按调用顺序返回不同响应的假客户端。"""
    it = iter(texts)

    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                text = next(it)

                class M:
                    content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def pdf_exam(conn):
    """PDF 试卷：2 页整页转录（选择题大题 + 答案区）。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'期末卷','exam','/tmp/x.pdf','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        for no, md in [(1, "一、选择题\n\n1. He ___ to school.\nA. go B. goes"),
                       (2, "参考答案\n\n1. B")]:
            cur.execute(
                """INSERT INTO pages (id, document_id, page_no, image_path, parse_status,
                                      adopted_source, page_md)
                   VALUES (%s,%s,%s,'/tmp/x.png','parsed','page_md',%s)""",
                (str(uuid.uuid4()), doc_id, no, md),
            )
    return doc_id


EXAM_JSON = _FENCE + "json\n" + (
    '[{"label": "1", "stem_md": "He ___ to school.\\nA. go B. goes",'
    ' "answer_md": "B", "page_start": 1, "page_end": 1}]'
) + "\n" + _FENCE


def test_split_sections_by_major_headings():
    from kb.structure_exam import split_sections
    text = "卷首说明\n\n一、选择题\n\n1. 题一\n\n二、填空题\n\n2. 题二"
    sections = split_sections(text)
    assert [t for t, _ in sections] == ["一、选择题", "二、填空题"]
    assert sections[0][1].startswith("卷首说明")  # 卷首并入第一 section
    assert "1. 题一" in sections[0][1] and "2. 题二" not in sections[0][1]


def test_split_sections_no_headings():
    from kb.structure_exam import split_sections
    assert split_sections("1. 唯一的题") == [("全卷", "1. 唯一的题")]


def test_run_exam_structure_pdf(conn, cfg, pdf_exam):
    """PDF 试卷：拼 page_md（带【页N】标记）-> 拆题 -> 章/题目/答案配对/struct_mode。"""
    from kb.structure_exam import run_exam_structure

    out = run_exam_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    assert out == {"mode": "exam", "sections": 1, "items": 2}
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, title, content_md, page_start, page_end FROM chapters")
        no, title, content_md, ps, pe = cur.fetchone()
        assert (no, title) == (1, "一、选择题")
        assert "【页1】" in content_md and (ps, pe) == (1, 1)
        cur.execute("SELECT content_type, label, page_start FROM items ORDER BY content_type")
        rows = cur.fetchall()
        assert rows == [("answer", "1", 1), ("exercise", "1", 1)]
        cur.execute(
            "SELECT count(*) FROM items WHERE content_type='exercise' AND paired_item_id IS NOT NULL"
        )
        assert cur.fetchone()[0] == 1  # 答案已配对
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (pdf_exam,))
        assert cur.fetchone()[0] == "toc"  # CHECK 只有 toc/flat；exam 走章节+条目结构记 toc


def test_run_exam_structure_docx(conn, cfg):
    """docx/md 试卷：现有章节即大题单元，不新建章。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'语法卷','exam','/tmp/x.docx','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO chapters (id, document_id, chapter_no, title, content_md)"
            " VALUES (%s,%s,1,'一、选择题','1. He ___ to school.')",
            (str(uuid.uuid4()), doc_id),
        )
    from kb.structure_exam import run_exam_structure

    out = run_exam_structure(conn, cfg, doc_id, client=_client_seq([EXAM_JSON]))
    assert out["items"] == 2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chapters WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 1  # 没新建章
        cur.execute("SELECT chapter, page_start FROM items WHERE content_type='exercise'")
        chapter, ps = cur.fetchone()
        assert chapter == "一、选择题" and ps is None  # docx 条目无页码


def test_run_exam_structure_section_failure_continues(conn, cfg):
    """单 section 失败记日志并继续，其它 section 照常入库。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'语法卷','exam','/tmp/x.docx','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        for no, title in [(1, "一、选择题"), (2, "二、填空题")]:
            cur.execute(
                "INSERT INTO chapters (id, document_id, chapter_no, title, content_md)"
                " VALUES (%s,%s,%s,%s,'内容')",
                (str(uuid.uuid4()), doc_id, no, title),
            )

    class Chat:
        class completions:
            calls = []

            @staticmethod
            def create(model, messages, max_tokens):
                Chat.completions.calls.append(1)
                if len(Chat.completions.calls) <= 2:
                    raise ConnectionError("Server disconnected")  # 重试一次后仍失败

                class M:
                    content = EXAM_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    from kb.structure_exam import run_exam_structure

    out = run_exam_structure(conn, cfg, doc_id, client=Client())
    assert out["items"] == 2  # 第二个 section 的题入库
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM pipeline_events"
            " WHERE document_id=%s AND event_type='error'",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1


def test_run_exam_structure_zero_questions_fails(conn, cfg, pdf_exam):
    from kb.structure_exam import run_exam_structure

    with pytest.raises(SystemExit, match="0 题"):
        run_exam_structure(conn, cfg, pdf_exam, client=_client_seq(["[]"]))


def test_run_exam_structure_idempotent(conn, cfg, pdf_exam):
    from kb.structure_exam import run_exam_structure

    run_exam_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    out = run_exam_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    assert out["items"] == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_structure_exam.py -q`
Expected: FAIL（`ModuleNotFoundError: kb.structure_exam`）

- [ ] **Step 3: 实现**

创建 `pipeline/kb/structure_exam.py`：

```python
"""试卷（--type exam）结构化：整卷转录文本 -> LLM 按题拆分 -> items + 答案配对。

不走目录/章节窗口：PDF 拼各页采用稿（【页N】标记溯源页码），docx/md 以现有章节为大题单元。
模式判定见 structure.run_structure：--flat > --exam > doc_type='exam' > 自动 toc/flat。
"""
from __future__ import annotations

import re
import time
import uuid

from openai import OpenAI

from kb.config import Config
from kb.metering import extract_usage, record_llm_call
from kb.toc import _parse_json_array

_SECTION_RE = re.compile(r"^(?:#{1,6}\s*)?第?[一二三四五六七八九十]+[、.．]\s*\S", re.M)

EXAM_PROMPT = (
    "下面是一份试卷「{section}」的全部内容（已按阅读顺序排列，页码以【页N】标记）。\n"
    "请把其中的题目逐题提取，输出 JSON 数组，每项：\n"
    "- label: 题号（字符串，优先数字，如 \"1\"、\"2\"）\n"
    "- stem_md: 题干完整内容（含选项；数学内容用 LaTeX $...$）\n"
    "- answer_md: 该题答案/解析（仅当内容里有答案区时给出，否则 null）\n"
    "- page_start / page_end: 该题所在页码（整数；无页标记则 null）\n"
    "规则：跨页/跨段的同一题合并成一题；答案区的答案按题号对应到题目；\n"
    "文字必须忠于原文：只能拼接整理、修正明显 OCR 错字；严禁改写、概括、补充。\n"
    "只输出 JSON。\n\n"
    "{exam_text}"
)


def split_sections(text: str) -> list[tuple[str, str]]:
    """按大题标题（一、二、…）切 section，卷首并入第一个；无匹配则整卷一个。"""
    matches = list(_SECTION_RE.finditer(text))
    if not matches:
        body = text.strip()
        return [("全卷", body)] if body else []
    sections = []
    for i, m in enumerate(matches):
        begin = 0 if i == 0 else m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        line_end = text.find("\n", m.start())
        title = text[m.start():line_end if line_end != -1 else len(text)]
        sections.append((title.strip().lstrip("#").strip(), text[begin:end].strip()))
    return sections


def exam_sections(conn, doc_id: str) -> list[dict]:
    """试卷的大题单元。PDF：拼各页采用稿后按大题标题切（write_chapter=True 需新建章）；
    docx/md：现有章节即大题单元（不新建章）。"""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pages WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            from kb.flat import page_contents
            contents = page_contents(cur, doc_id)
            text = "\n\n".join(f"【页{no}】\n{t}" for no, t in contents)
            return [{"chapter_no": i, "title": title, "text": body, "write_chapter": True}
                    for i, (title, body) in enumerate(split_sections(text), start=1)]
        cur.execute(
            "SELECT chapter_no, title, content_md FROM chapters"
            " WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        return [{"chapter_no": no, "title": title, "text": content or "",
                 "write_chapter": False}
                for no, title, content in cur.fetchall()]


def _as_page(v) -> int | None:
    return int(v) if isinstance(v, (int, float)) else None


def extract_section(conn, cfg: Config, doc_id: str, section: dict, model: str,
                    client, recorder=None) -> int:
    """一个大题 section 的 LLM 拆题。返回新增 item 数（exercise + answer）。
    幂等：该章已有 items 跳过。断连/JSON 解析失败重试一次，再失败抛给编排层。"""
    chapter_label = section["title"]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM items WHERE document_id=%s AND chapter=%s LIMIT 1",
            (doc_id, chapter_label),
        )
        if cur.fetchone():
            return 0
        if section["write_chapter"]:
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (document_id, chapter_no) DO UPDATE
                   SET title=EXCLUDED.title, content_md=EXCLUDED.content_md""",
                (str(uuid.uuid4()), doc_id, section["chapter_no"], section["title"],
                 section["text"]),
            )
        prompt = EXAM_PROMPT.format(section=chapter_label, exam_text=section["text"])
        resp = None
        for attempt in (1, 2):
            try:
                resp = client.chat.completions.create(
                    model=model, messages=[{"role": "user", "content": prompt}],
                    max_tokens=8192,
                )
                entries = _parse_json_array(resp.choices[0].message.content)
                break
            except Exception:  # noqa: BLE001 - 断连/解析失败重试一次
                if attempt == 2:
                    raise
                time.sleep(3)
        record_llm_call(conn, doc_id, "structure_exam", model, extract_usage(resp),
                        recorder=recorder, stage="structure",
                        prompt=prompt, output=resp.choices[0].message.content)
        n = 0
        pages: list[int] = []
        for entry in entries:
            label = str(entry.get("label") or "").strip()
            stem = (entry.get("stem_md") or "").strip()
            if not label or not stem:
                continue  # 脏条目跳过不炸
            ps = _as_page(entry.get("page_start"))
            pe = _as_page(entry.get("page_end")) or ps
            if ps is not None:
                pages.extend([ps, pe])
            for ctype, content in (("exercise", stem), ("answer", entry.get("answer_md"))):
                if not isinstance(content, str) or not content.strip():
                    continue
                cur.execute(
                    """INSERT INTO items (id, document_id, content_type, label, content_md,
                                          chapter, tags, page_start, page_end, source_model)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), doc_id, ctype, label, content.strip(),
                     chapter_label, [], ps, pe, model),
                )
                n += 1
        if section["write_chapter"] and pages:
            cur.execute(
                "UPDATE chapters SET page_start=%s, page_end=%s"
                " WHERE document_id=%s AND chapter_no=%s",
                (min(pages), max(pages), doc_id, section["chapter_no"]),
            )
    return n


def run_exam_structure(conn, cfg: Config, doc_id: str, client=None, recorder=None) -> dict:
    """试卷拆题编排：大题 section 逐个 LLM 提取，失败记日志继续；整卷 0 题判失败。
    幂等：整卷已有 items 直接返回。struct_mode 记 'toc'（章节+条目结构，approve 走条目链）。"""
    from kb.export_md import export_chapter_mds, export_page_mds
    from kb.structure import pair_items
    from kb.traj import Recorder

    rec = recorder or Recorder(conn, cfg, doc_id)
    base_url, api_key, model = cfg.doc_ognize_endpoint()
    client = client or OpenAI(base_url=base_url, api_key=api_key)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM items WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            rec.decision("structure", "试卷已有条目，跳过（幂等）")
            return {"mode": "exam", "sections": 0, "items": 0}
    sections = [s for s in exam_sections(conn, doc_id) if s["text"].strip()]
    if not sections:
        raise SystemExit("试卷没有可用转录文本，请先完成解析/入库")
    rec.decision("structure", f"试卷拆题: {len(sections)} 个大题单元",
                 payload={"sections": [s["title"] for s in sections]})
    total, failed = 0, []
    for s in sections:
        try:
            total += extract_section(conn, cfg, doc_id, s, model, client, recorder=rec)
        except Exception as e:  # noqa: BLE001 - 单 section 失败不阻塞其它 section
            failed.append(s["title"])
            rec.error("structure", f"大题「{s['title']}」拆题失败: {e}", exc=e)
            print(f"大题「{s['title']}」拆题失败: {e}")
    if total == 0:
        rec.end("structure", "试卷拆题失败：0 题", status="error")
        raise SystemExit("试卷拆题结果为 0 题，请检查转录质量或换更强的 DOC_OGNIZE 模型")
    paired = pair_items(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    print(f"条目: {total} 条入库; 答案配对 {paired} 处"
          + (f"; 失败大题: {'、'.join(failed)}" if failed else ""))
    print(f"落盘: {export_page_mds(conn, cfg, doc_id)} 页 md, "
          f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
    rec.end("structure", f"试卷拆题完成，{len(sections)} 个大题 {total} 条")
    return {"mode": "exam", "sections": len(sections), "items": total}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_structure_exam.py -q`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/structure_exam.py pipeline/tests/test_structure_exam.py
git commit -m "feat(pipeline): 试卷 LLM 拆题模块 structure_exam（大题 section -> items + 答案配对）"
```

---

### Task 4: run_structure / CLI / internal_api 接入 exam 分支

**Files:**
- Modify: `pipeline/kb/structure.py`（`run_structure` 167-192 行）
- Modify: `pipeline/kb/cli.py`（structure 子命令 58-63 行、分支 126-130 行）
- Modify: `pipeline/kb/internal_api.py`（approve-doc 的 `elif struct_mode == "toc"` 分支，约 237 行）
- Test: `pipeline/tests/test_structure_exam.py`（追加）、`pipeline/tests/test_internal_api.py` 已有用例做回归

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_structure_exam.py` 末尾追加：

```python
def test_run_structure_routes_exam_by_doc_type(conn, cfg, pdf_exam):
    """doc_type='exam' 的文档跑 structure 自动走试卷拆题（无需 --exam）。"""
    from kb.structure import run_structure

    out = run_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    assert out["mode"] == "exam"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM items WHERE document_id=%s", (pdf_exam,))
        assert cur.fetchone()[0] == 2


def test_run_structure_flat_flag_wins_over_exam(conn, cfg, pdf_exam):
    """显式 --flat 优先于 doc_type=exam（逃生门）。"""
    from kb.structure import run_structure

    out = run_structure(conn, cfg, pdf_exam, flat=True, client=_client_seq([EXAM_JSON]))
    assert out["mode"] == "flat"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM items WHERE document_id=%s", (pdf_exam,))
        assert cur.fetchone()[0] == 0  # 未拆题
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_structure_exam.py -q -k run_structure`
Expected: FAIL（doc_type=exam 的文档走了 flat 回退，items 为 0）

- [ ] **Step 3: 实现**

`pipeline/kb/structure.py` 的 `run_structure` 签名加 `exam: bool = False`，模式判定段（原 181-183 行）改为：

```python
def run_structure(conn, cfg: Config, doc_id: str, toc_pages: list[int] | None = None,
                  flat: bool = False, exam: bool = False, client=None) -> dict:
    """structure 编排（CLI 同款流程，可直接测试）。
    模式判定：--flat > --exam / doc_type='exam'（试卷拆题）> --toc-pages > 自动探测目录页，探测不到回退 flat。"""
```

函数体中：

```python
    with conn.cursor() as cur:
        cur.execute("SELECT doc_type FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"文档不存在: {doc_id}")
        if flat:
            mode = "flat"
        elif exam or row[0] == "exam":
            mode = "exam"
        else:
            mode = resolve_mode(cur, doc_id, flat=False, toc_pages=toc_pages)
    rec.decision("structure", f"模式判定: {mode}", payload={"mode": mode})
    if mode == "exam":
        from kb.structure_exam import run_exam_structure
        return run_exam_structure(conn, cfg, doc_id, client=client, recorder=rec)
```

（替换掉原来 `mode = resolve_mode(cur, doc_id, flat=flat, toc_pages=toc_pages)` 那一行；`if mode == "flat":` 分支保持原样。）

`pipeline/kb/cli.py`：structure 子命令加参数：

```python
    p_struct.add_argument("--exam", action="store_true",
                          help="试卷拆题模式：LLM 按题提取成条目（doc_type=exam 时自动启用）")
```

分发处（原 126-130 行）改为：

```python
    elif args.cmd == "structure":
        from kb.structure import run_structure

        toc_pages = [int(x) for x in args.toc_pages.split(",")] if args.toc_pages else None
        run_structure(conn, cfg, args.doc_id, toc_pages=toc_pages, flat=args.flat,
                      exam=args.exam)
```

`pipeline/kb/internal_api.py`：approve-doc 里把：

```python
                elif struct_mode == "toc":
```

改为：

```python
                elif struct_mode in ("toc", "exam"):
```

（试卷文档 struct_mode=NULL 时 approve-doc 会现场跑 run_structure 拿到 "exam"，必须进 approve_items 分支。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_structure_exam.py tests/test_structure.py tests/test_internal_api.py tests/test_traj_structure.py -q`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/structure.py pipeline/kb/cli.py pipeline/kb/internal_api.py pipeline/tests/test_structure_exam.py
git commit -m "feat(pipeline): structure 接入 exam 拆题分支（--exam / doc_type=exam 自动）"
```

---

### Task 5: backend `GET /api/library/:id/content`

**Files:**
- Modify: `backend/src/routes/library.ts`（在 `/:id/chunks` 之后加路由）
- Test: `backend/src/routes/library.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/routes/library.test.ts` 末尾追加：

```ts
describe("GET /api/library/:id/content", () => {
  it("PDF 文档按页返回采用稿（page_md 优先，否则块拼接）", async () => {
    const pool2 = {
      query: async (sql: string, _params?: unknown[]) => {
        if (sql.includes("FROM documents")) {
          return { rows: [{ id: DOC_ID, title: "卷", kind: "pdf" }] };
        }
        if (sql.includes("FROM pages")) {
          return { rows: [
            { page_no: 1, adopted_source: "page_md", page_md: "第一页稿", blocks_md: "块稿" },
            { page_no: 2, adopted_source: "blocks", page_md: null, blocks_md: "第二页块稿" },
          ] };
        }
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request(`/api/library/${DOC_ID}/content`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.unit_type).toBe("pages");
    expect(data.sections).toEqual([
      { page_no: 1, content_md: "第一页稿" },
      { page_no: 2, content_md: "第二页块稿" },
    ]);
  });

  it("docx/md 文档按章返回 content_md", async () => {
    const pool2 = {
      query: async (sql: string, _params?: unknown[]) => {
        if (sql.includes("FROM documents")) {
          return { rows: [{ id: DOC_ID, title: "书", kind: "text" }] };
        }
        if (sql.includes("FROM chapters")) {
          return { rows: [
            { chapter_no: 1, title: "第一讲", content_md: "第一章内容" },
            { chapter_no: 2, title: "第二讲", content_md: null },
          ] };
        }
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request(`/api/library/${DOC_ID}/content`);
    const data = await res.json();
    expect(data.unit_type).toBe("chapters");
    expect(data.sections).toEqual([
      { chapter_no: 1, title: "第一讲", content_md: "第一章内容" },
      { chapter_no: 2, title: "第二讲", content_md: "" },
    ]);
  });

  it("文档不存在返回 404", async () => {
    const pool2 = { query: async () => ({ rows: [] }) } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request(`/api/library/${DOC_ID}/content`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npm test -- library.test.ts`
Expected: 3 个新用例 FAIL（404 路由不存在）

- [ ] **Step 3: 实现**

`backend/src/routes/library.ts` 在 `app.get("/:id/chunks", ...)` 之后加：

```ts
  app.get("/:id/content", async (c) => {
    try {
      const { rows: [doc] } = await pool.query(
        `SELECT id::text, title,
                CASE WHEN lower(source_path) LIKE '%.pdf' THEN 'pdf' ELSE 'text' END AS kind
         FROM documents WHERE id=$1`, [c.req.param("id")]);
      if (!doc) return c.json({ error: "文档不存在" }, 404);
      if (doc.kind === "pdf") {
        const { rows } = await pool.query(
          `SELECT p.page_no, p.adopted_source, p.page_md,
                  (SELECT string_agg(b.content_md, E'\n\n' ORDER BY b.created_at)
                   FROM blocks b
                   WHERE b.page_id = p.id AND b.content_md IS NOT NULL
                     AND b.block_type NOT IN ('header','footer')) AS blocks_md
           FROM pages p WHERE p.document_id=$1 ORDER BY p.page_no`, [doc.id]);
        return c.json({
          id: doc.id, title: doc.title, unit_type: "pages",
          sections: rows.map((r) => ({
            page_no: r.page_no,
            content_md: (r.adopted_source === "page_md" && r.page_md)
              ? r.page_md : (r.blocks_md ?? ""),
          })),
        });
      }
      const { rows } = await pool.query(
        `SELECT chapter_no, title, content_md FROM chapters
         WHERE document_id=$1 ORDER BY chapter_no`, [doc.id]);
      return c.json({
        id: doc.id, title: doc.title, unit_type: "chapters",
        sections: rows.map((r) => ({
          chapter_no: r.chapter_no, title: r.title, content_md: r.content_md ?? "",
        })),
      });
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") return c.json({ error: "id 格式非法" }, 422);
      throw err;
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npm test -- library.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/library.ts backend/src/routes/library.test.ts
git commit -m "feat(backend): 资料库整文档内容接口 GET /api/library/:id/content"
```

---

### Task 6: frontend 资料库三视图（全文默认 / chunk / OCR 分块）

**Files:**
- Modify: `frontend/src/api/library.ts`（加 fetchLibraryContent）
- Modify: `frontend/src/components/LibraryDetail.tsx`

- [ ] **Step 1: api 层加 fetchLibraryContent**

`frontend/src/api/library.ts` 在 `LibraryChunk` 接口后加类型：

```ts
export interface LibraryContentSection {
  page_no?: number; chapter_no?: number; title?: string | null; content_md: string;
}

export interface LibraryContent {
  id: string; title: string; unit_type: "pages" | "chapters";
  sections: LibraryContentSection[];
}
```

在 `fetchLibraryChunks` 后加：

```ts
export async function fetchLibraryContent(
  id: string, fetchImpl: FetchLike = fetch,
): Promise<LibraryContent> {
  return req(`/api/library/${encodeURIComponent(id)}/content`, fetchImpl);
}
```

- [ ] **Step 2: LibraryDetail 加全文视图（默认）+ OCR 分块入口**

`frontend/src/components/LibraryDetail.tsx`：

import 区改为：

```tsx
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  approveLibraryDoc, fetchLibraryContent, fetchLibraryDoc, fetchLibraryChunks,
  reindexLibraryUnit, setPageExclusion,
  type LibraryChunk, type LibraryContent, type LibraryDetail as LibraryDetailData,
  type Pagination,
} from "../api/library";
import { PageDetail } from "./PageDetail";
```

新增 `FullContent` 组件（放在 `IndexLedger` 之后）：

```tsx
export function FullContent({ docId, fetchImpl = fetch }: {
  docId: string; fetchImpl?: typeof fetch;
}) {
  const [data, setData] = useState<LibraryContent | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchLibraryContent(docId, fetchImpl)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [docId, fetchImpl]);
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!data) return <div className="chat-empty">加载中…</div>;
  return (
    <div className="full-content">
      {data.sections.map((s, i) => (
        <section key={i} className="content-section">
          <h3>{s.title ?? `第 ${s.page_no} 页`}</h3>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
              {s.content_md || "（空）"}
            </ReactMarkdown>
          </div>
        </section>
      ))}
    </div>
  );
}
```

`LibraryDetail` 里：

- view state 改为 `useState<"content" | "table" | "thumbnails" | "chunks">("content")`；
- 新增 `const [pageId, setPageId] = useState<string | null>(null);`；
- 在 `if (!data) return ...` 之前加：

```tsx
  if (pageId) {
    return (
      <PageDetail pageId={pageId} fetchImpl={fetchImpl}
                  onExit={() => { setPageId(null); void reload(); }} onError={onError} />
    );
  }
```

- tabs 区加「全文」按钮放最前：

```tsx
        <button className={view === "content" ? "btn-primary" : "btn-ghost"} onClick={() => setView("content")}>全文</button>
```

- 视图渲染区加：

```tsx
      {view === "content" && <FullContent docId={data.id} fetchImpl={fetchImpl} />}
```

并把原 `{view !== "chunks" && (` 改为 `{view !== "chunks" && view !== "content" && (`。

- 页面表「操作」列在「重建」按钮旁加查看按钮：

```tsx
                      <button className="btn-ghost" onClick={() => setPageId(item.id)}>查看</button>
```

- 缩略图卡可点（OCR 分块入口）：

```tsx
            <div key={item.id} className={`page-card${item.excluded_from_index ? " excluded" : ""}`}
                 onClick={() => setPageId(item.id)}>
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: 无类型错误，构建成功

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/library.ts frontend/src/components/LibraryDetail.tsx
git commit -m "feat(frontend): 资料库详情三视图——全文(默认)/索引账页/OCR 分块(复用 PageDetail)"
```

---

### Task 7: e2e 用例——试卷拆题链路 + 资料库三视图 + chunk 粒度

**Files:**
- Create: `e2e/specs/exam-structure.spec.ts`

- [ ] **Step 1: 写 e2e spec**

创建 `e2e/specs/exam-structure.spec.ts`（模式参照 `e2e/specs/materials-review.spec.ts` 与 `flat-ingest.spec.ts`：种子直插 DB，CLI 用 execSync，真实三服务 + ollama）：

```ts
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 试卷拆题 + 资料库三视图 + chunk 粒度全链路。
    PDF 试卷（种子 page_md）跑真 structure（ollama）拆题；md 文档真 ingest 验证 ~500 chunk。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const EXAM_TITLE = `E2E-${RUN}-期末卷`;
const MD_TITLE = `E2E-${RUN}-长文章`;
const KEYWORD = `E2E${RUN}魔法词`;

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let examDocId = "";
let mdDocId = "";

test.beforeAll(async () => {
  // PDF 试卷种子：2 页整页转录，含一个大题 + 答案区；1 个带 bbox 的块供 OCR 分块视图断言
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, parse_status)
     VALUES ($1,'英语','exam',$2,'parsed') RETURNING id::text`,
    [EXAM_TITLE, `/tmp/e2e-${RUN}-exam.pdf`]);
  examDocId = doc.id;
  const pagesDir = path.join(STORAGE_ROOT, examDocId, "pages");
  mkdirSync(pagesDir, { recursive: true });
  for (const [no, md] of [
    [1, `一、选择题\n\n1. ${KEYWORD}: He ___ to school by bus.\nA. go B. goes C. went`],
    [2, `参考答案\n\n1. B`],
  ] as [number, string][]) {
    writeFileSync(path.join(pagesDir, `p${String(no).padStart(4, "0")}.png`), PNG_1PX);
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, parse_status, adopted_source, page_md)
       VALUES ($1,$2,$3,'parsed','page_md',$4) RETURNING id::text`,
      [examDocId, no, `storage/${examDocId}/pages/p${String(no).padStart(4, "0")}.png`, md]);
    if (no === 1) {
      const blocksDir = path.join(STORAGE_ROOT, examDocId, "blocks");
      mkdirSync(blocksDir, { recursive: true });
      writeFileSync(path.join(blocksDir, "b1.png"), PNG_1PX);
      await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md)
         VALUES ($1,'text',$2,$3,$4)`,
        [page.id, JSON.stringify([10, 20, 300, 120]),
         `storage/${examDocId}/blocks/b1.png`, `一、选择题 ${KEYWORD}`]);
    }
  }
});

test("t1 试卷 structure 自动走拆题：items + 答案配对 + struct_mode", async () => {
  test.setTimeout(300_000);  // 真 LLM 拆题
  execSync(`uv run python -m kb.cli structure ${examDocId}`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  const { rows: items } = await pool.query(
    "SELECT content_type, label, page_start FROM items WHERE document_id=$1", [examDocId]);
  expect(items.length).toBeGreaterThanOrEqual(1);
  expect(items.some((i) => i.content_type === "exercise")).toBe(true);
  const { rows: [doc] } = await pool.query(
    "SELECT struct_mode FROM documents WHERE id=$1", [examDocId]);
  expect(doc.struct_mode).toBe("toc");
});

test("t2 md 入库 chunk 粒度 ~500 + overlap", async () => {
  test.setTimeout(120_000);  // 真 embedding（ollama bge-m3）
  const para = `${KEYWORD}${"长".repeat(380)}`;  // 每段 ~390 字符，3 段 → 多 chunk
  const md = path.join(PIPELINE_DIR, ".tmp", `e2e-${RUN}.md`);
  mkdirSync(path.dirname(md), { recursive: true });
  writeFileSync(md, `# 长文\n\n${[para, para, para].join("\n\n")}`);
  const out = execSync(
    `uv run python -m kb.cli ingest "${md}" --title "${MD_TITLE}" --subject 语文 --type workbook`,
    { cwd: PIPELINE_DIR, encoding: "utf-8" });
  mdDocId = /document_id=([0-9a-f-]+)/.exec(out)?.[1] ?? "";
  expect(mdDocId).not.toBe("");
  const { rows: chunks } = await pool.query(
    `SELECT content_md FROM chunks WHERE document_id=$1 ORDER BY seg_no`, [mdDocId]);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const c of chunks) {
    const seg = c.content_md.split("\n\n").slice(1).join("\n\n");  // 去掉章节标签行
    expect(seg.length).toBeLessThanOrEqual(500);
  }
  // overlap：后一个 chunk 的开头 = 前一个 chunk 段尾 50 字符
  const seg0 = chunks[0].content_md.split("\n\n").slice(1).join("\n\n");
  const seg1 = chunks[1].content_md.split("\n\n").slice(1).join("\n\n");
  expect(seg1.startsWith(seg0.slice(-50))).toBe(true);
});

test("t3 资料库三视图：全文(默认)/索引账页/OCR 分块", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库", exact: true }).click();
  await page.getByText(EXAM_TITLE).click();
  // 默认全文视图：看到试卷转录文本
  await expect(page.locator(".full-content")).toContainText(KEYWORD);
  // OCR 分块：页面表 -> 查看 -> PageDetail 页图 + bbox 覆层
  await page.getByRole("button", { name: "页面表", exact: true }).click();
  await page.getByRole("button", { name: "查看" }).first().click();
  await expect(page.getByAltText("第 1 页")).toBeVisible();
  await expect(page.locator(".pd-image .bbox")).toHaveCount(1);
  await expect(page.locator(".blockitem")).toContainText(KEYWORD);
  await page.getByRole("button", { name: "← 返回列表" }).click();
  // 索引账页（chunk 视图）：approve 后出现 chunk
  await page.getByRole("button", { name: "整本入库" }).click();
  await page.getByRole("button", { name: "索引账页", exact: true }).click();
  await expect(page.locator(".chunk-line li").first()).toBeVisible();
  const { rows: chunks } = await pool.query(
    "SELECT count(*)::int AS n FROM chunks WHERE document_id=$1", [examDocId]);
  expect(chunks[0].n).toBeGreaterThanOrEqual(1);
});
```

注意：资料库列表点击文档标题进入详情的选择器（`page.getByText(EXAM_TITLE)`）以 `frontend/src/views/LibraryView.tsx` 实际渲染为准，写用例时先读该文件确认入口交互；若入口是按钮/卡片，换成对应 role 选择器。

- [ ] **Step 2: 跑 e2e 确认通过**

Run: `cd e2e && npx playwright test exam-structure`
Expected: 3 个用例 PASS（服务由 Playwright 自动拉起；t1 真 LLM 拆题若偶发失败，先看 pipeline_events 定位，不要直接放过）

- [ ] **Step 3: 全量回归**

Run: `cd pipeline && uv run pytest tests/ -q && cd ../backend && npm test && cd ../e2e && npm test`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/exam-structure.spec.ts
git commit -m "test(e2e): 试卷拆题链路 + 资料库三视图 + chunk 粒度"
```

---

### Task 8: AGENTS.md 同步

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新入库工作流描述**

`AGENTS.md` 第 4 条「PDF（docx/md 可选）跑 `structure <doc_id>` 拆条成题目级条目；无目录页的试卷集合自动回退「整卷按页」模式（不拆条，页级检索，`--flat` 显式强制）」改为：

```
4. `structure <doc_id>` 拆条成题目级条目：`--type exam` 的文档（或显式 `--exam`）走试卷拆题——整卷转录文本按大题分批喂 LLM，提取成题目级 items + 答案配对；练习册走目录页→章节拆条；无目录页且非试卷的文档回退「整卷按页」模式（`--flat` 显式强制）。
```

并在第 3 条「入库命令」后补一句 chunk 配置说明：

```
   章节向量化分段粒度由 `KB_CHUNK_MAX_CHARS`（默认 500）与 `KB_CHUNK_OVERLAP_RATIO`（默认 0.1）控制；已入库文档改配置后需重索引生效。
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 同步 exam 拆题与 chunk 配置"
```

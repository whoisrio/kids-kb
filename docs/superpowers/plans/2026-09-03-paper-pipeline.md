# Phase 2 试卷管线 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上传试卷(PDF/多图)→ VLM 拆题 + 对错预识别 → 复核视图键盘确认 → 写 attempts + 题库匹配,全链路含 Playwright E2E。

**Architecture:** 依据 `docs/superpowers/specs/2026-09-03-paper-pipeline-design.md`。backend(TS)当总指挥:收上传、pdf-lib 合成 PDF、状态机推进、检索匹配、确认落库;pipeline(Python)是无状态工人:渲染页图、每页单次 VLM、裁题图、全量替换写 `paper_questions`(经 `/internal/ingest-paper`、`/internal/recognize-page`);schema 变更全部在 `pipeline/kb/migrations/0011_papers.sql`。

**Tech Stack:** Python 3.13 + FastAPI + psycopg + pymupdf + pytest(pipeline/);Node + TS + Hono + pg + pdf-lib + vitest(backend/);React + Vite(前端复核视图);Playwright + pg(E2E);远端 VLM qwen3.8-27b + 本地 ollama bge-m3。

**执行顺序:** Task 1-5(pipeline 侧:数据模型→加工→内部 API)先做;Task 6-13(backend 侧)依赖 Task 1 的 migration 与 Task 5 的内部 API;Task 14-15(frontend)依赖 Task 11-12 的 API;Task 16(E2E)最后。同一 Workstream 内严格按序。

**测试约定:**

- Python:`cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
- backend:`cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`(vitest;真库测试用 `resetDbForTest` 重放 migrations)
- frontend:`cd frontend && npm test`
- E2E:`cd e2e && npm test`(真三服务 + ollama + 远端 VLM)

**Spec 偏差记录:**

- `papers.source_path` 加 `DEFAULT ''`:TS 建行时不写文件,pipeline 存 `source.pdf` 后回填绝对路径。
- `hybridSearch` 需小改造:`SearchHit` 贯通 `vec_score`(向量余弦),匹配阈值判定依赖它。

---

## Task 1: migration 0011——papers + paper_questions + attempts 放宽 + llm_calls.paper_id

**Files:**

- Create: `pipeline/kb/migrations/0011_papers.sql`
- Test: `pipeline/tests/test_paper_pipeline.py`

- [ ] **Step 1: 写失败的 schema 测试**

```python
"""试卷管线:页图渲染 -> 每页单次 VLM 拆题+对错识别 -> 裁题图 -> 全量替换落库。

设计:docs/superpowers/specs/2026-09-03-paper-pipeline-design.md
papers.status 由 TS 编排层管理;本模块只写 source_path/page_count/paper_questions 与文件。
"""
# tests/test_paper_pipeline.py 先只放 schema 断言;后续 Task 逐步补充。
import uuid

import pytest


@pytest.fixture()
def child(conn):
    cid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (id, name) VALUES (%s,%s)", (cid, "小宝"))
    return cid


def _paper(conn, child_id, status="processing"):
    pid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO papers (id, child_id, title, subject, status) VALUES (%s,%s,%s,%s,%s)",
            (pid, child_id, "期中卷", "数学", status),
        )
    return pid


def test_papers_schema(conn, child):
    with conn.cursor() as cur:
        # subject / status 受控词表
        cur.execute(
            "INSERT INTO papers (id, child_id, title, subject) VALUES (%s,%s,%s,%s)",
            (str(uuid.uuid4()), child, "x", "体育"),
        )
        with pytest.raises(Exception):
            conn.execute(
                "INSERT INTO papers (id, child_id, title, subject) VALUES (%s,%s,%s,%s)",
                (str(uuid.uuid4()), child, "x", "数学"),
            )
            conn.execute(
                "INSERT INTO papers (id, child_id, title, subject, status) VALUES (%s,%s,%s,%s,%s)",
                (str(uuid.uuid4()), child, "x", "数学", "bogus"),
            )


def test_attempts_relaxed_for_paper(conn, child):
    paper = _paper(conn, child)
    qid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO paper_questions
               (id, paper_id, page_no, seq_in_page, content_md, recognized_result)
               VALUES (%s,%s,1,1,'1+1=',NULL)""",
            (qid, paper),
        )
        # 只有 paper_question_id 也能入 attempts(item_id 为空合法)
        cur.execute(
            "INSERT INTO attempts (child_id, paper_question_id, result) VALUES (%s,%s,'wrong')",
            (child, qid),
        )
        # 两者皆空仍拒绝
        with pytest.raises(Exception):
            conn.execute(
                "INSERT INTO attempts (child_id, result) VALUES (%s,'wrong')", (child,)
            )
        # paper_question 级联删除连带 attempts
        cur.execute("DELETE FROM paper_questions WHERE id=%s", (qid,))
        n = cur.execute("SELECT count(*) FROM attempts WHERE paper_question_id=%s", (qid,)).fetchone()[0]
        assert n == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_paper_pipeline.py -q`
Expected: FAIL——`relation "papers" does not exist`。

- [ ] **Step 3: 写 migration**

```sql
-- 0011_papers.sql：试卷管线(papers/paper_questions)+ attempts 放宽 + llm_calls.paper_id
CREATE TABLE papers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    title text NOT NULL,
    subject text NOT NULL CHECK (subject IN ('语文', '数学', '英语', '其他')),
    source_path text NOT NULL DEFAULT '',
    page_count int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'ready_for_review', 'done', 'failed')),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE paper_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    page_no int NOT NULL,
    seq_in_page int NOT NULL,
    content_md text NOT NULL,
    answer_excerpt text,
    mark_desc text,
    recognized_result text CHECK (recognized_result IN ('correct', 'wrong', 'partial')),
    confirmed_result text CHECK (confirmed_result IN ('correct', 'wrong', 'partial')),
    error_cause text CHECK (error_cause IN ('粗心', '概念不清', '方法不会', '计算错')),
    note text,
    bbox jsonb,
    image_path text,
    matched_item_id uuid REFERENCES items(id) ON DELETE SET NULL,
    match_score real,
    matched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (paper_id, page_no, seq_in_page)
);
CREATE INDEX idx_paper_questions_paper ON paper_questions(paper_id);

-- attempts 放宽:试卷题来源入库(同一 paper_question 至多一条,改判 UPDATE)
ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_item_id_check;
ALTER TABLE attempts ADD COLUMN paper_question_id uuid
    REFERENCES paper_questions(id) ON DELETE CASCADE;
ALTER TABLE attempts ADD CONSTRAINT attempts_source_check
    CHECK (item_id IS NOT NULL OR paper_question_id IS NOT NULL);

-- token 计量挂试卷
ALTER TABLE llm_calls ADD COLUMN paper_id uuid REFERENCES papers(id) ON DELETE SET NULL;
```

- [ ] **Step 4: 跑测试确认通过(含迁移账本一致性回归)**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_paper_pipeline.py tests/test_db.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/migrations/0011_papers.sql pipeline/tests/test_paper_pipeline.py
git commit -m "feat(pipeline): migration 0011——papers/paper_questions + attempts 放宽 + llm_calls.paper_id"
```

---

## Task 2: metering 扩展(paper_id + modality)

**Files:**

- Modify: `pipeline/kb/metering.py`
- Test: `pipeline/tests/test_metering.py`(追加)

- [ ] **Step 1: 写失败测试(追加到 test_metering.py)**

```python
def test_record_llm_call_paper_fields(conn):
    from kb.metering import record_llm_call
    import uuid
    cid = str(uuid.uuid4())
    conn.execute("INSERT INTO children (id, name) VALUES (%s,'小宝')", (cid,))
    pid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO papers (id, child_id, title, subject) VALUES (%s,%s,'卷','数学')",
        (pid, cid),
    )
    record_llm_call(conn, None, "paper_vlm", "qwen3.8-27b", (11, 22),
                    paper_id=pid, modality="image")
    row = conn.execute(
        "SELECT document_id, paper_id, purpose, model, modality, prompt_tokens, completion_tokens "
        "FROM llm_calls ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    assert row == (None, pid, "paper_vlm", "qwen3.8-27b", "image", 11, 22)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_metering.py -q`
Expected: FAIL——`TypeError: record_llm_call() got an unexpected keyword argument 'paper_id'`。

- [ ] **Step 3: 实现**

`kb/metering.py` 的 `record_llm_call` 替换为:

```python
def record_llm_call(conn, doc_id: str | None, purpose: str, model: str,
                    usage: tuple[int | None, int | None],
                    paper_id: str | None = None,
                    modality: str | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO llm_calls (document_id, paper_id, purpose, model, modality,
                                      prompt_tokens, completion_tokens)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (doc_id, paper_id, purpose, model, modality, usage[0], usage[1]),
        )
```

- [ ] **Step 4: 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS(既有调用点位置参数不变,签名向后兼容)。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/metering.py pipeline/tests/test_metering.py
git commit -m "feat(pipeline): record_llm_call 支持 paper_id/modality"
```

---

## Task 3: paper_pipeline 纯函数——VLM 输出解析与规范化

**Files:**

- Create: `pipeline/kb/paper_pipeline.py`
- Test: `pipeline/tests/test_paper_pipeline.py`(追加)

- [ ] **Step 1: 写失败测试(追加)**

```python
class TestParsePageQuestions:
    def _run(self, text):
        from kb.paper_pipeline import parse_page_questions
        return parse_page_questions(text)

    def test_正常_JSON_规范化(self):
        qs = self._run(
            '{"questions": [{"seq_in_page": 3, "bbox": [10, 20, 500, 200],'
            ' "content_md": "246 × 37 =", "answer_excerpt": "9102",'
            ' "result": "wrong", "mark_desc": "老师红笔 ✗"}]}'
        )
        assert qs == [{
            "seq_in_page": 1,  # 按数组顺序重编,不信模型的编号
            "bbox": [10, 20, 500, 200],
            "content_md": "246 × 37 =",
            "answer_excerpt": "9102",
            "recognized_result": "wrong",
            "mark_desc": "老师红笔 ✗",
        }]

    def test_剥掉_markdown_围栏(self):
        qs = self._run('```json\n{"questions": [{"content_md": "1+1="}]}\n```')
        assert qs[0]["content_md"] == "1+1="

    def test_result_非法归_null_缺字段兜底(self):
        qs = self._run('{"questions": [{"content_md": "1+1=", "result": "对"}]}')
        assert qs[0]["recognized_result"] is None
        assert qs[0]["bbox"] is None
        assert qs[0]["answer_excerpt"] is None

    def test_bbox_越界_clamp_倒序交换_过小作废(self):
        assert self._run('{"questions": [{"content_md": "x", "bbox": [-50, 990, 2000, 2000]}]}')[0]["bbox"] == [0, 990, 1000, 1000]
        assert self._run('{"questions": [{"content_md": "x", "bbox": [500, 200, 100, 400]}]}')[0]["bbox"] == [100, 200, 500, 400]
        assert self._run('{"questions": [{"content_md": "x", "bbox": [10, 10, 12, 400]}]}')[0]["bbox"] is None

    def test_非_JSON_或缺_questions_抛_ValueError(self):
        import pytest as _pytest
        with _pytest.raises(ValueError):
            self._run("这不是 JSON")
        with _pytest.raises(ValueError):
            self._run('{"foo": 1}')
        with _pytest.raises(ValueError):
            self._run('{"questions": [{"answer_excerpt": "无题干"}]}')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql/kb_test uv run pytest tests/test_paper_pipeline.py::TestParsePageQuestions -q`
Expected: FAIL——`ModuleNotFoundError: No module named 'kb.paper_pipeline'`。

- [ ] **Step 3: 实现(本任务只写纯函数与 prompt 常量)**

```python
"""试卷管线:页图渲染 -> 每页单次 VLM 拆题+对错识别 -> 裁题图 -> 全量替换落库。

设计:docs/superpowers/specs/2026-09-03-paper-pipeline-design.md
papers.status 由 TS 编排层管理;本模块只写 source_path/page_count/paper_questions 与文件。
"""
from __future__ import annotations

import json
import re

PAPER_VLM_PROMPT = """你是试卷解析助手。把这一页试卷拆成一道道独立的题,并识别批改痕迹。
只输出纯 JSON(不要 markdown 围栏),结构:
{"questions": [
  {"seq_in_page": 1,
   "bbox": [x1, y1, x2, y2],
   "content_md": "题干全文,数学公式用 LaTeX",
   "answer_excerpt": "学生作答内容摘录(没有则空字符串)",
   "result": "correct|wrong|partial|null",
   "mark_desc": "批改痕迹描述,如「老师红笔 ✗」(没有则空字符串)"}
]}
规则:
- bbox 用 0-1000 归一化坐标,框住这道题的完整区域(题干+作答)。
- result 判定:明确 ✓ 或对勾 -> correct;✗、叉、红圈、扣分 -> wrong;半对(如 ✓ 但有扣分、半勾)-> partial;没有批改痕迹或拿不准 -> null。
- 忽略页眉、页脚、姓名栏、分数栏、页码;题目按从上到下的阅读顺序编号。
- 页面上没有题目时输出 {"questions": []}。"""

_RESULTS = {"correct", "wrong", "partial"}
_MAX_TOKENS = 8192


def _strip_fences(text: str) -> str:
    """剥 markdown 围栏,并截取最外层大括号(VLM 可能夹带前后说明文字)。"""
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", t).strip()
    m = re.search(r"\{.*\}", t, re.DOTALL)
    return m.group(0) if m else t


def _norm_bbox(raw) -> list[int] | None:
    if not (isinstance(raw, list) and len(raw) == 4):
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in raw)
    except (TypeError, ValueError):
        return None
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    clamp = lambda v: max(0, min(1000, v))  # noqa: E731
    x1, y1, x2, y2 = (clamp(v) for v in (x1, y1, x2, y2))
    if x2 - x1 < 5 or y2 - y1 < 5:  # 面积过小视为非法,题图兜底整页
        return None
    return [round(v) for v in (x1, y1, x2, y2)]


def parse_page_questions(text: str) -> list[dict]:
    """VLM 原始输出 -> 规范化题目列表;非法结构抛 ValueError。"""
    try:
        data = json.loads(_strip_fences(text))
    except json.JSONDecodeError as e:
        raise ValueError(f"不是合法 JSON: {e}") from e
    questions = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(questions, list):
        raise ValueError("缺少 questions 数组")
    out = []
    for i, q in enumerate(questions, start=1):
        if not isinstance(q, dict):
            raise ValueError(f"第 {i} 项不是对象")
        content = (q.get("content_md") or "").strip()
        if not content:
            raise ValueError(f"第 {i} 项缺少 content_md")
        result = q.get("result")
        if result not in _RESULTS:
            result = None
        out.append({
            "seq_in_page": i,  # 按数组顺序重编,不信模型的编号
            "bbox": _norm_bbox(q.get("bbox")),
            "content_md": content,
            "answer_excerpt": (q.get("answer_excerpt") or "").strip() or None,
            "recognized_result": result,
            "mark_desc": (q.get("mark_desc") or "").strip() or None,
        })
    return out
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_paper_pipeline.py -q`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/paper_pipeline.py pipeline/tests/test_paper_pipeline.py
git commit -m "feat(pipeline): 试卷 VLM 输出解析与规范化(纯函数)"
```

---

## Task 4: paper_pipeline——ingest_paper 与 recognize_page

**Files:**

- Modify: `pipeline/kb/paper_pipeline.py`(追加)
- Test: `pipeline/tests/test_paper_pipeline.py`(追加)

- [ ] **Step 1: 写失败测试(追加)**

```python
import json as _json


class FakeVLM:
    """按调用次数弹回预设响应;记录收到的 prompt 供断言。"""

    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.prompts: list[str] = []

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    def create(self, *, messages, **_kw):
        from types import SimpleNamespace
        self.prompts.append(messages[0]["content"][0]["text"])
        text = self.responses.pop(0)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20),
        )


def _make_pdf(tmp_path, pages: int = 1) -> str:
    import pymupdf as fitz
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=595, height=842)
    p = str(tmp_path / "source.pdf")
    doc.save(p)
    return p


def _vlm_json(questions: list[dict]) -> str:
    return _json.dumps({"questions": questions}, ensure_ascii=False)


def _responses_for(pages_with_questions: list[list[dict]]) -> list[str]:
    return [_vlm_json(qs) for qs in pages_with_questions]


class TestIngestPaper:
    def test_拆题落库_裁图_计量_页数回填(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper
        pid = _paper(conn, child)
        pdf = _make_pdf(tmp_path)
        vlm = FakeVLM(_responses_for([[
            {"seq_in_page": 1, "bbox": [0, 0, 500, 300], "content_md": "1. 246 × 37 =",
             "answer_excerpt": "9102", "result": "wrong", "mark_desc": "红笔 ✗"},
        ]]))
        out = ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(), client=vlm)
        assert out == {"pages": 1, "questions": 1}
        row = conn.execute(
            "SELECT page_no, seq_in_page, content_md, recognized_result, bbox, image_path, "
            "answer_excerpt, mark_desc FROM paper_questions WHERE paper_id=%s", (pid,)
        ).fetchone()
        assert row[0] == 1 and row[1] == 1
        assert row[2] == "1. 246 × 37 =" and row[3] == "wrong"
        assert row[4] == [0, 0, 500, 300]
        assert row[5] and Path(row[5]).exists()      # 题图裁切落盘
        assert row[6] == "9102" and row[7] == "红笔 ✗"
        paper = conn.execute(
            "SELECT source_path, page_count FROM papers WHERE id=%s", (pid,)).fetchone()
        assert Path(paper[0]).exists() and paper[1] == 1
        meter = conn.execute(
            "SELECT count(*) FROM llm_calls WHERE paper_id=%s AND purpose='paper_vlm' "
            "AND modality='image'", (pid,)).fetchone()[0]
        assert meter == 1

    def test_幂等_重跑全量替换(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper
        pid = _paper(conn, child)
        pdf = _make_pdf(tmp_path, pages=2)
        q = [{"seq_in_page": 1, "bbox": None, "content_md": "题", "result": None,
              "answer_excerpt": "", "mark_desc": ""}]
        ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(),
                     client=FakeVLM(_responses_for([q, q])))
        ingest_paper(conn, cfg, pid, client=FakeVLM(_responses_for([q, q])))  # 重驱动不带 bytes
        n = conn.execute(
            "SELECT count(*) FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert n == 2  # 不是 4

    def test_解析失败重试一次_再失败抛错且计量两次(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper
        pid = _paper(conn, child)
        pdf = _make_pdf(tmp_path)
        vlm = FakeVLM(["坏输出", "还是坏输出"])
        with pytest.raises(RuntimeError, match="解析失败"):
            ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(), client=vlm)
        assert len(vlm.prompts) == 2
        assert "严格修正" in vlm.prompts[1]  # 第二次带错误反馈
        assert conn.execute(
            "SELECT count(*) FROM llm_calls WHERE paper_id=%s", (pid,)).fetchone()[0] == 2


class TestRecognizePage:
    def test_只重跑目标页(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper, recognize_page
        pid = _paper(conn, child, status="ready_for_review")
        pdf = _make_pdf(tmp_path, pages=2)
        q = [{"seq_in_page": 1, "bbox": None, "content_md": "旧题", "result": None,
              "answer_excerpt": "", "mark_desc": ""}]
        ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(),
                     client=FakeVLM(_responses_for([q, q])))
        # 确认两题,模拟已有人工痕迹
        conn.execute("UPDATE paper_questions SET confirmed_result='correct' WHERE paper_id=%s", (pid,))
        new_q = [{"seq_in_page": 1, "bbox": None, "content_md": "新题", "result": "wrong",
                  "answer_excerpt": "", "mark_desc": ""}]
        out = recognize_page(conn, cfg, pid, 1, client=FakeVLM(_responses_for([new_q])))
        assert out == {"pages": 1, "questions": 1}
        rows = conn.execute(
            "SELECT page_no, content_md, confirmed_result FROM paper_questions "
            "WHERE paper_id=%s ORDER BY page_no, seq_in_page", (pid,)).fetchall()
        assert rows == [(1, "新题", None), (2, "旧题", "correct")]  # 页1重置,页2不动
```

测试文件头部追加 import(与现有 imports 合并):

```python
from pathlib import Path
import pytest
```

`cfg` fixture 追加(指向 tmp storage,避免污染 pipeline/storage):

```python
@pytest.fixture()
def cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="fake",
    )
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_paper_pipeline.py -q -k "Ingest or Recognize"`
Expected: FAIL——`ImportError: cannot import name 'ingest_paper'`。

- [ ] **Step 3: 实现(追加到 kb/paper_pipeline.py)**

```python
import base64
from pathlib import Path

import pymupdf as fitz
from openai import OpenAI

from kb.config import Config
from kb.metering import extract_usage, record_llm_call


def _vlm_call(client, model: str, image_path: str, feedback: str | None):
    """单次 VLM 调用;feedback 非空时为重试(带错误反馈)。"""
    prompt = PAPER_VLM_PROMPT
    if feedback:
        prompt += f"\n\n你上次的输出有问题:{feedback}\n请严格修正后重新输出,仍然只输出纯 JSON。"
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
        max_tokens=_MAX_TOKENS,
    )
    return resp.choices[0].message.content, extract_usage(resp)


def _recognize_page(conn, cfg: Config, paper_id: str, page_no: int,
                    image_path: str, client=None) -> list[dict]:
    """一页 VLM 识别:失败重试一次(带反馈),再失败抛 RuntimeError。每次调用都计量。"""
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    feedback: str | None = None
    for _ in range(2):
        text, usage = _vlm_call(client, cfg.vision_model, image_path, feedback)
        record_llm_call(conn, None, "paper_vlm", cfg.vision_model, usage,
                        paper_id=paper_id, modality="image")
        try:
            return parse_page_questions(text)
        except ValueError as e:
            feedback = str(e)
    raise RuntimeError(f"第 {page_no} 页 VLM 输出两次解析失败: {feedback}")


def _crop_question(pix: fitz.Pixmap, bbox: list[int], out_path: Path) -> None:
    w, h = pix.width, pix.height
    x1, y1, x2, y2 = bbox
    rect = fitz.Rect(w * x1 / 1000, h * y1 / 1000, w * x2 / 1000, h * y2 / 1000)
    fitz.Pixmap(pix, fitz.IRect(rect.x0, rect.y0, rect.x1, rect.y1)).save(str(out_path))


def _insert_questions(conn, paper_id: str, questions: list[dict]) -> None:
    from psycopg.types.json import Jsonb
    with conn.cursor() as cur:
        for q in questions:
            cur.execute(
                """INSERT INTO paper_questions
                   (paper_id, page_no, seq_in_page, content_md, answer_excerpt, mark_desc,
                    recognized_result, bbox, image_path)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (paper_id, q["page_no"], q["seq_in_page"], q["content_md"],
                 q["answer_excerpt"], q["mark_desc"], q["recognized_result"],
                 Jsonb(q["bbox"]) if q["bbox"] else None, q["image_path"]),
            )


def ingest_paper(conn, cfg: Config, paper_id: str, pdf_bytes: bytes | None = None,
                 client=None) -> dict:
    """全卷加工(幂等):存 source.pdf -> 渲染页图 -> 每页 VLM -> 裁题图 -> 全量替换。

    pdf_bytes 缺省 = 重驱动,复用已存的 source.pdf。原子性:DELETE+INSERT 包在一个事务里。
    """
    root = cfg.storage_dir / "papers" / paper_id
    pages_dir, questions_dir = root / "pages", root / "questions"
    source = root / "source.pdf"
    if pdf_bytes is not None:
        root.mkdir(parents=True, exist_ok=True)
        source.write_bytes(pdf_bytes)
    if not source.exists():
        raise FileNotFoundError("source.pdf 不存在(重驱动须先上传)")
    pages_dir.mkdir(parents=True, exist_ok=True)
    questions_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(str(source))
    recognized: list[dict] = []
    for i, page in enumerate(doc, start=1):
        img_rel = pages_dir / f"p{i:04d}.png"
        if not img_rel.exists():
            page.get_pixmap(dpi=cfg.dpi).save(str(img_rel))
        questions = _recognize_page(conn, cfg, paper_id, i, str(img_rel), client=client)
        pix = fitz.Pixmap(str(img_rel))
        for q in questions:
            if q["bbox"]:
                rel = questions_dir / f"p{i:04d}_q{q['seq_in_page']:02d}.png"
                _crop_question(pix, q["bbox"], rel)
                q["image_path"] = str(rel.resolve())
            else:
                q["image_path"] = None
            q["page_no"] = i
            recognized.append(q)

    with conn.transaction():  # autocommit 连接上的显式事务:全量替换原子生效
        with conn.cursor() as cur:
            cur.execute("DELETE FROM paper_questions WHERE paper_id=%s", (paper_id,))
        _insert_questions(conn, paper_id, recognized)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE papers SET source_path=%s, page_count=%s WHERE id=%s",
                (str(source.resolve()), doc.page_count, paper_id),
            )
    return {"pages": doc.page_count, "questions": len(recognized)}


def recognize_page(conn, cfg: Config, paper_id: str, page_no: int, client=None) -> dict:
    """页级重识别(幂等):删该页题目 -> 复用/渲染该页图 -> 单页 VLM -> 重插。"""
    with conn.cursor() as cur:
        source_path = cur.execute(
            "SELECT source_path FROM papers WHERE id=%s", (paper_id,)
        ).fetchone()
    if not source_path or not source_path[0]:
        raise FileNotFoundError("试卷还没有 source.pdf")
    doc = fitz.open(source_path[0])
    if not (1 <= page_no <= doc.page_count):
        raise ValueError(f"page_no 越界: {page_no} / {doc.page_count}")

    root = cfg.storage_dir / "papers" / paper_id
    pages_dir, questions_dir = root / "pages", root / "questions"
    pages_dir.mkdir(parents=True, exist_ok=True)
    questions_dir.mkdir(parents=True, exist_ok=True)
    img_rel = pages_dir / f"p{page_no:04d}.png"
    # 重识别 bbox 可能变,页图本身不重渲染(DPI 不变),但旧题图作废重裁
    if not img_rel.exists():
        doc[page_no - 1].get_pixmap(dpi=cfg.dpi).save(str(img_rel))
    questions = _recognize_page(conn, cfg, paper_id, page_no, str(img_rel), client=client)
    pix = fitz.Pixmap(str(img_rel))
    for q in questions:
        if q["bbox"]:
            rel = questions_dir / f"p{page_no:04d}_q{q['seq_in_page']:02d}.png"
            _crop_question(pix, q["bbox"], rel)
            q["image_path"] = str(rel.resolve())
        else:
            q["image_path"] = None
        q["page_no"] = page_no

    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM paper_questions WHERE paper_id=%s AND page_no=%s",
                (paper_id, page_no),
            )
        _insert_questions(conn, paper_id, questions)
    return {"pages": 1, "questions": len(questions)}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/paper_pipeline.py pipeline/tests/test_paper_pipeline.py
git commit -m "feat(pipeline): ingest_paper/recognize_page——渲染+VLM+裁图+全量替换落库"
```

---

## Task 5: internal API——/internal/ingest-paper 与 /internal/recognize-page

**Files:**

- Modify: `pipeline/kb/internal_api.py`
- Test: `pipeline/tests/test_internal_api.py`(追加)

- [ ] **Step 1: 写失败测试(追加到 test_internal_api.py)**

```python
class TestPaperEndpoints:
    def test_ingest_paper_收文件_全量替换_重复调用幂等(self, conn, child, tmp_path):
        """conn fixture 见 tests/conftest.py;child/paper helper 从 test_paper_pipeline 导入。"""
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        app = create_internal_app(get_conn=lambda: conn, vlm_client=FakeVLM([
            _vlm_json([{"content_md": "题1", "bbox": None}]),
            _vlm_json([{"content_md": "题1", "bbox": None}]),  # 第二次调用(幂等重跑)
        ]))
        client = TestClient(app)
        import pymupdf as fitz
        doc = fitz.open(); doc.new_page()
        pdf_bytes = doc.tobytes()
        r = client.post(f"/internal/ingest-paper?paper_id={pid}",
                        files={"file": ("source.pdf", pdf_bytes, "application/pdf")})
        assert r.status_code == 200 and r.json() == {"pages": 1, "questions": 1}
        # 重驱动(不带文件)
        r2 = client.post(f"/internal/ingest-paper?paper_id={pid}")
        assert r2.status_code == 200
        n = conn.execute("SELECT count(*) FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert n == 1

    def test_ingest_paper_卷不存在_500_detail(self, conn):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        client = TestClient(create_internal_app(get_conn=lambda: conn))
        r = client.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000",
                        files={"file": ("s.pdf", b"not a pdf", "application/pdf")})
        assert r.status_code == 500

    def test_recognize_page(self, conn, child, tmp_path):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        # 先 ingest 一页一题
        app = create_internal_app(get_conn=lambda: conn, vlm_client=FakeVLM([
            _vlm_json([{"content_md": "旧", "bbox": None}]),
            _vlm_json([{"content_md": "新", "bbox": None}]),
        ]))
        client = TestClient(app)
        import pymupdf as fitz
        doc = fitz.open(); doc.new_page()
        client.post(f"/internal/ingest-paper?paper_id={pid}",
                    files={"file": ("s.pdf", doc.tobytes(), "application/pdf")})
        r = client.post("/internal/recognize-page",
                        json={"paper_id": pid, "page_no": 1})
        assert r.status_code == 200 and r.json() == {"pages": 1, "questions": 1}
        md = conn.execute(
            "SELECT content_md FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert md == "新"
```

注意:`conn` fixture 每测试重置 schema;跨文件导入 helper(`FakeVLM/_paper/_vlm_json`)即可,不要复制。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q -k Paper`
Expected: FAIL——`TypeError: create_internal_app() got an unexpected keyword argument 'get_conn'`。

- [ ] **Step 3: 实现**

`kb/internal_api.py` 全量替换为:

```python
"""内部服务:只对 TS 后端暴露,不对前端。
rerank 是唯一需要本地模型权重的环节;试卷加工(渲染+VLM+拆题)在此挂载,
get_conn/vlm_client 可注入假实现(测试模式同 review_api)。"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Callable

import psycopg
from fastapi import FastAPI, HTTPException, UploadFile
from pydantic import BaseModel

STATIC_TITLE = "kb-internal"


class RerankRequest(BaseModel):
    query: str
    docs: list[str]


class RecognizePageRequest(BaseModel):
    paper_id: str
    page_no: int


def create_internal_app(reranker_factory=None, get_conn: Callable[[], psycopg.Connection] | None = None,
                        vlm_client=None, cfg=None) -> FastAPI:
    """reranker_factory/get_conn/vlm_client/cfg 均可注入假实现;
    默认懒加载 kb.rerank.get_reranker / 每请求开新连接 / load_config。"""
    if reranker_factory is None:
        def reranker_factory():
            from kb.rerank import get_reranker
            return get_reranker()
    own = get_conn is None
    if get_conn is None:
        def get_conn() -> psycopg.Connection:  # type: ignore[misc]
            from kb.db import connect
            from kb.config import load_config
            return connect(load_config().database_url)

    def _cfg():
        if cfg is not None:
            return cfg
        from kb.config import load_config
        return load_config()

    @contextmanager
    def conn_ctx():
        c = get_conn()
        try:
            yield c
        finally:
            if own:
                c.close()

    app = FastAPI(title=STATIC_TITLE, docs_url=None, redoc_url=None)

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

    @app.post("/internal/ingest-paper")
    async def ingest_paper(paper_id: str, file: UploadFile | None = None):
        """全卷加工。file 缺省 = 重驱动(复用已存 source.pdf)。
        失败把原因放 detail 返回 500,由 TS 编排层落 papers.error。"""
        from kb.paper_pipeline import ingest_paper as run
        pdf_bytes = await file.read() if file else None
        with conn_ctx() as conn:
            try:
                return run(conn, _cfg(), paper_id, pdf_bytes=pdf_bytes, client=vlm_client)
            except Exception as e:  # noqa: BLE001 —— 加工失败细节透传给编排层
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/recognize-page")
    def recognize_page(body: RecognizePageRequest):
        from kb.paper_pipeline import recognize_page as run
        with conn_ctx() as conn:
            try:
                return run(conn, _cfg(), body.paper_id, body.page_no, client=vlm_client)
            except Exception as e:  # noqa: BLE001
                raise HTTPException(status_code=500, detail=str(e)) from e

    return app
```

`python-multipart` 已是 fastapi 传递依赖(uv.lock 在列),无需新增。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/internal_api.py pipeline/tests/test_internal_api.py
git commit -m "feat(pipeline): /internal/ingest-paper + /internal/recognize-page(可注入测试)"
```

---

## Task 6: backend config——storageRoot + matchThreshold

**Files:**

- Modify: `backend/src/config.ts`
- Test: `backend/src/config.test.ts`(追加)

- [ ] **Step 1: 写失败测试(追加)**

```ts
describe("试卷配置", () => {
  it("storageRoot 缺省指向 ../pipeline/storage(相对 backend cwd 解析)", () => {
    const cfg = loadConfig({ KB_DATABASE_URL: "postgresql://localhost/kb" } as NodeJS.ProcessEnv);
    expect(cfg.storageRoot.endsWith("pipeline/storage")).toBe(true);
  });
  it("KB_STORAGE_ROOT 覆盖;matchThreshold 缺省 0.88 可覆盖", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "x",
      KB_STORAGE_ROOT: "/tmp/papers-root",
      KB_MATCH_THRESHOLD: "0.9",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.storageRoot).toBe("/tmp/papers-root");
    expect(cfg.matchThreshold).toBe(0.9);
  });
  it("matchThreshold 非法值回落默认", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "x", KB_MATCH_THRESHOLD: "abc",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.matchThreshold).toBe(0.88);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: FAIL——`storageRoot` 不存在。

- [ ] **Step 3: 实现**

`BackendConfig` 接口加两个字段;`loadConfig` 返回值补(文件顶部补 `import { resolve as pathResolve } from "node:path";`):

```ts
  /** pipeline 侧 storage 根(试卷页图/题图回传用)。 */
  storageRoot: string;
  /** 题库自动匹配阈值(余弦相似度)。 */
  matchThreshold: number;
```

```ts
    // 试卷页图/题图在 pipeline/storage 下;默认同仓部署,可 env 覆盖
    storageRoot: pick(env.KB_STORAGE_ROOT) ?? pathResolve("../pipeline/storage"),
    matchThreshold: (() => {
      const v = Number(pick(env.KB_MATCH_THRESHOLD));
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.88;
    })(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/config.ts backend/src/config.test.ts
git commit -m "feat(backend): KB_STORAGE_ROOT / KB_MATCH_THRESHOLD 配置"
```

---

## Task 7: retrieval——hybridSearch 贯通 vec_score

**Files:**

- Modify: `backend/src/retrieval/search.ts`
- Test: `backend/src/retrieval/search.test.ts`(追加)

- [ ] **Step 1: 写失败测试(追加)**

```ts
  it("hit 贯通 vec_score(向量余弦),供匹配阈值判定", async () => {
    // 复用 beforeAll 已插的 item1/chunk1(V1 向量,deps.embed 也返回 V1 方向):
    // item1 余弦=1;BM25-only 命中的 item 若不在向量召回里则无 vec_score
    const hits = await hybridSearch(pool, deps, "三位数乘两位数 竖式");
    const hit1 = hits.find((h) => h.item_id === "22222222-2222-2222-2222-222222222222");
    expect(hit1).toBeDefined();
    expect(hit1!.vec_score).toBeCloseTo(1, 5);
    // 命中但不在向量召回的条目不应有 vec_score
    const hit2 = hits.find((h) => h.item_id === "33333333-3333-3333-3333-333333333333");
    if (hit2) expect(hit2.vec_score).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/search.test.ts`
Expected: FAIL——`vec_score` 为 undefined。

- [ ] **Step 3: 实现**

`SearchHit` 接口加:

```ts
  /** 向量余弦(该条目所有 chunk 的最大值);仅 BM25 命中的条目无此字段。 */
  vec_score?: number;
```

`hybridSearch` 的 RRF 融合段替换为:

```ts
  const rrf = new Map<string, SearchHit>();
  vecHits.forEach((r, rank) => {
    const h = rrf.get(r.item_id) ?? { ...toHit(r), score: 0 };
    // vec_score 取该条目各 chunk 的最大余弦(一个条目一个 chunk,当前即本身)
    h.vec_score = Math.max(h.vec_score ?? -1, r.score ?? -1);
    h.score += 1 / (60 + rank + 1);
    rrf.set(r.item_id, h);
  });
  lexOrder.forEach(({ index }, rank) => {
    const r = allChunks[index];
    const h = rrf.get(r.item_id) ?? { ...toHit(r), score: 0 };
    h.score += 1 / (60 + rank + 1);
    rrf.set(r.item_id, h);
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/search.test.ts`
Expected: PASS(其余用例不回归——rerank 排序逻辑不动)。

- [ ] **Step 5: Commit**

```bash
git add backend/src/retrieval/search.ts backend/src/retrieval/search.test.ts
git commit -m "feat(backend): hybridSearch 贯通 vec_score(余弦)供匹配阈值"
```

---

## Task 8: retrieval——matchQuestion 匹配函数

**Files:**

- Create: `backend/src/retrieval/match.ts`
- Test: `backend/src/retrieval/match.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { matchQuestion } from "./match.js";
import type { SearchDeps } from "./search.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("matchQuestion（真库）", () => {
  let pool: pg.Pool;
  const same = [1, ...new Array(1023).fill(0)];
  const other = [0, 1, ...new Array(1022).fill(0)];
  const deps: SearchDeps = {
    embed: async () => [same],  // query 向量恒指向"同文"条目
    rerank: async (_q, docs) => docs.map(() => 1),
  };

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('11111111-1111-1111-1111-111111111111','数学书','数学','/tmp/a.pdf'),
        ('44444444-4444-4444-4444-444444444444','英语书','英语','/tmp/b.pdf')`,
    );
    await pool.query(
      `INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','exercise','1','135 ÷ 5 = 27'),
        ('55555555-5555-5555-5555-555555555555','44444444-4444-4444-4444-444444444444','exercise','2','英语阅读')`,
    );
    const vec = (arr: number[]) => `[${arr.join(",")}]`;
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','135 ÷ 5 = 27',
         '{"subject":"数学","label":"1","chapter":null,"doc_title":"数学书"}'::jsonb, $1::vector),
        ('55555555-5555-5555-5555-555555555555','44444444-4444-4444-4444-444444444444','英语阅读',
         '{"subject":"英语","label":"2","chapter":null,"doc_title":"英语书"}'::jsonb, $2::vector)`,
      [vec(same), vec(other)],
    );
  });
  afterAll(async () => { await pool.end(); });

  it("同学科过滤 + rerank 第一名超阈值 → auto", async () => {
    const { candidates, auto } = await matchQuestion(
      pool, deps, "135 ÷ 5 = 27", "数学", 0.88);
    expect(auto?.item_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(auto!.vec_score).toBeGreaterThan(0.88);
    expect(candidates.map((c) => c.item_id)).not.toContain("55555555-5555-5555-5555-555555555555");
  });

  it("rerank 第一名低于阈值 → auto 为 null(宁缺勿滥)", async () => {
    const { auto, candidates } = await matchQuestion(
      pool, deps, "135 ÷ 5 = 27", "数学", 0.999);
    expect(auto).toBeNull();
    expect(candidates.length).toBeGreaterThan(0);  // 候选照常供人工选择
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/match.test.ts`
Expected: FAIL——`Cannot find module './match.js'`。

- [ ] **Step 3: 实现**

```ts
/** 试卷题目 → 题库匹配:同学科混合检索 + rerank,第一名余弦超阈值自动关联。 */
import type pg from "pg";
import { hybridSearch, type SearchDeps, type SearchHit } from "./search.js";

export interface MatchResult {
  /** rerank 序 top-5 候选(供人工选择)。 */
  candidates: SearchHit[];
  /** 自动关联命中(第一名且 vec_score ≥ threshold);null = 需人工。 */
  auto: SearchHit | null;
}

export async function matchQuestion(
  pool: pg.Pool,
  deps: SearchDeps,
  content: string,
  subject: string,
  threshold: number,
): Promise<MatchResult> {
  const candidates = await hybridSearch(pool, deps, content, {
    topK: 5,
    filters: { subject },
  });
  const top = candidates[0];
  const auto = top && top.vec_score !== undefined && top.vec_score >= threshold ? top : null;
  return { candidates, auto };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/match.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/retrieval/match.ts backend/src/retrieval/match.test.ts
git commit -m "feat(backend): matchQuestion——同学科混合检索+阈值自动关联"
```

---

## Task 9: papers——pdf-lib 合成

**Files:**

- Create: `backend/src/papers/assemble.ts`
- Test: `backend/src/papers/assemble.test.ts`

依赖:`cd backend && npm install pdf-lib`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { assemblePdf } from "./assemble.js";

// 1x1 透明 PNG(固定 base64;JPG 基准样例见下,若解析失败可用 pipeline 重新生成:
// uv run --project ../pipeline python -c "import pymupdf as f; p=f.Pixmap(f.csRGB,f.IRect(0,0,1,1)); p.clear_with(255); p.save('/tmp/1x1.jpg')"
// 然后 base64 < /tmp/1x1.jpg 替换)
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPG_1PX =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const png = (name = "a.png") => ({ name, bytes: Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)) });

describe("assemblePdf", () => {
  it("多张图片按顺序合成,每图一页", async () => {
    const { bytes, pageCount } = await assemblePdf([png("1.png"), png("2.jpg")]);
    expect(pageCount).toBe(2);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  it("PDF 直接并入(单 PDF 上传)", async () => {
    const src = await PDFDocument.create();
    src.addPage([300, 400]);
    src.addPage([300, 400]);
    const { pageCount } = await assemblePdf([
      { name: "x.pdf", bytes: await src.save() },
    ]);
    expect(pageCount).toBe(2);
  });

  it("空列表抛错;不支持的扩展名抛错", async () => {
    await expect(assemblePdf([])).rejects.toThrow("至少");
    await expect(assemblePdf([{ name: "a.heic", bytes: new Uint8Array() }])).rejects.toThrow("不支持的文件类型");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/papers/assemble.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

```ts
/** 上传文件归一化:多张 JPG/PNG(每图一页)+ 可选 PDF → 合成单个 PDF。 */
import { PDFDocument } from "pdf-lib";

export interface UploadFileInput {
  name: string;
  bytes: Uint8Array;
}

const ALLOWED = /\.(pdf|jpe?g|png)$/i;

export async function assemblePdf(
  files: UploadFileInput[],
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  if (files.length === 0) throw new Error("至少上传一个文件(PDF/JPG/PNG)");
  const doc = await PDFDocument.create();
  for (const f of files) {
    if (!ALLOWED.test(f.name)) throw new Error(`不支持的文件类型: ${f.name}(仅 PDF/JPG/PNG)`);
    if (/\.pdf$/i.test(f.name)) {
      const src = await PDFDocument.load(f.bytes);
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    } else if (/\.jpe?g$/i.test(f.name)) {
      const img = await doc.embedJpg(f.bytes);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      const img = await doc.embedPng(f.bytes);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
  }
  return { bytes: await doc.save(), pageCount: doc.getPageCount() };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx vitest run src/papers/assemble.test.ts`
Expected: PASS(JPG 用例若因基准 base64 损坏失败,按测试注释用 pymupdf 重新生成替换后重跑)。

- [ ] **Step 5: Commit**

```bash
git add backend/src/papers/assemble.ts backend/src/papers/assemble.test.ts backend/package.json backend/package-lock.json
git commit -m "feat(backend): pdf-lib 上传合成(多图每图一页/PDF 并入)"
```

---

## Task 10: papers——后台任务 drivePaper + redriveStuckPapers

**Files:**

- Create: `backend/src/papers/jobs.ts`
- Test: `backend/src/papers/jobs.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { resetDbForTest } from "../db.js";
import { drivePaper, redriveStuckPapers } from "./jobs.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const ITEM = "22222222-2222-2222-2222-222222222222";

maybe("试卷后台任务（真库 + 假 pipeline fetch）", () => {
  let pool: pg.Pool;

  async function seedPaper(status = "processing") {
    const { rows: [p] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'卷','数学',$2,1) RETURNING id::text`, [CHILD, status]);
    return p.id as string;
  }

  async function seedQuestion(paperId: string, content: string) {
    const { rows: [q] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
       VALUES ($1,1,1,$2) RETURNING id::text`, [paperId, content]);
    return q.id as string;
  }

  const okPipeline = async () => new Response(JSON.stringify({ pages: 1, questions: 1 }));
  // embed 返回指向 ITEM chunk 的向量 → 余弦 1 → 自动关联
  const vec = `[${[1, ...new Array(1023).fill(0)].join(",")}]`;
  const deps = {
    pipelineUrl: "http://pipeline.test",
    matchThreshold: 0.88,
    embed: async () => [[1, ...new Array(1023).fill(0)]],
    rerank: async (_q: string, docs: string[]) => docs.map(() => 1),
    fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/internal/ingest-paper")) return okPipeline();
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch,
  };

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query("INSERT INTO children (id, name) VALUES ($1,'小宝')", [CHILD]);
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('33333333-3333-3333-3333-333333333333','数学书','数学','/tmp/a.pdf')`);
    await pool.query(
      `INSERT INTO items (id, document_id, content_type, label, content_md) VALUES
        ($1,'33333333-3333-3333-3333-333333333333','exercise','1','135 ÷ 5 =')`, [ITEM]);
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ($1,'33333333-3333-3333-3333-333333333333','135 ÷ 5 =',
         '{"subject":"数学","label":"1"}'::jsonb, $2::vector)`, [ITEM, vec]);
  });
  afterAll(async () => { await pool.end(); });

  it("成功路径:调 pipeline -> 自动匹配 -> ready_for_review", async () => {
    const id = await seedPaper();
    await seedQuestion(id, "135 ÷ 5 =");
    await drivePaper(pool, deps, id);
    const paper = (await pool.query(
      "SELECT status, error FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("ready_for_review");
    expect(paper.error).toBeNull();
    const q = (await pool.query(
      "SELECT matched_item_id::text, match_score FROM paper_questions WHERE paper_id=$1", [id])).rows[0];
    expect(q.matched_item_id).toBe(ITEM);
    expect(q.match_score).toBeGreaterThan(0.88);
    // 首次驱动带 multipart body
    const call = (deps.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("/internal/ingest-paper");
  });

  it("pipeline 失败 -> failed + error 文案", async () => {
    const id = await seedPaper();
    await pool.query("DELETE FROM paper_questions WHERE paper_id=$1", [id]);
    const badDeps = { ...deps, fetchImpl: (async () =>
      new Response(JSON.stringify({ detail: "VLM 超时" }), { status: 500 })) as unknown as typeof fetch };
    await drivePaper(pool, badDeps, id);
    const paper = (await pool.query(
      "SELECT status, error FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("failed");
    expect(paper.error).toContain("VLM 超时");
  });

  it("0 题识别 -> failed", async () => {
    const id = await seedPaper();
    await drivePaper(pool, { ...deps, fetchImpl: okPipeline as unknown as typeof fetch }, id);
    const paper = (await pool.query(
      "SELECT status, error FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("failed");
    expect(paper.error).toContain("未识别出题目");
  });

  it("redriveStuckPapers 重驱动滞留 processing 的卷", async () => {
    await seedPaper();        // processing
    await seedPaper("done");  // 不动
    const n = await redriveStuckPapers(pool, { ...deps, fetchImpl: okPipeline as unknown as typeof fetch });
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it("匹配失败不致命:卷仍 ready_for_review(人工匹配兜底)", async () => {
    const id = await seedPaper();
    await seedQuestion(id, "x");
    await drivePaper(pool, { ...deps, embed: async () => { throw new Error("ollama 挂了"); } }, id);
    const paper = (await pool.query(
      "SELECT status FROM papers WHERE id=$1", [id])).rows[0];
    expect(paper.status).toBe("ready_for_review");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/papers/jobs.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

```ts
/** 试卷后台任务:调 pipeline 加工 -> 逐题自动匹配 -> 状态推进。
    进程内去重(inflight),幂等可重驱动;匹配失败不致命(复核页人工匹配兜底)。 */
import type pg from "pg";
import { matchQuestion } from "../retrieval/match.js";
import type { RerankFn } from "../retrieval/rerank.js";

export interface PaperJobDeps {
  pipelineUrl: string;
  matchThreshold: number;
  embed: (texts: string[]) => Promise<number[][]>;
  rerank: RerankFn | null;
  fetchImpl?: typeof fetch;
}

const inflight = new Map<string, Promise<void>>();

export function drivePaper(
  pool: pg.Pool,
  deps: PaperJobDeps,
  paperId: string,
  opts: { pdfBytes?: Uint8Array; pageNo?: number } = {},
): Promise<void> {
  const running = inflight.get(paperId);
  if (running) return running;
  const job = runPaperJob(pool, deps, paperId, opts)
    .catch(async (err) => {
      console.error(`试卷 ${paperId} 处理失败`, err);
      await pool.query(
        "UPDATE papers SET status='failed', error=$1, updated_at=now() WHERE id=$2",
        [err instanceof Error ? err.message : String(err), paperId],
      );
    })
    .finally(() => inflight.delete(paperId));
  inflight.set(paperId, job);
  return job;
}

async function runPaperJob(pool: pg.Pool, deps: PaperJobDeps, paperId: string,
                           opts: { pdfBytes?: Uint8Array; pageNo?: number }) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.pipelineUrl.replace(/\/$/, "");

  let resp: Response;
  if (opts.pageNo === undefined) {
    const url = `${base}/internal/ingest-paper?paper_id=${encodeURIComponent(paperId)}`;
    if (opts.pdfBytes) {
      const form = new FormData();
      form.append("file", new Blob([opts.pdfBytes as BlobPart], { type: "application/pdf" }), "source.pdf");
      resp = await fetchImpl(url, { method: "POST", body: form });
    } else {
      resp = await fetchImpl(url, { method: "POST" });  // 重驱动:复用 pipeline 已存 source.pdf
    }
  } else {
    resp = await fetchImpl(`${base}/internal/recognize-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_id: paperId, page_no: opts.pageNo }),
    });
  }
  if (!resp.ok) {
    const detail = (await resp.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(String(detail.detail ?? `pipeline ${resp.status}`));
  }

  // 逐题自动匹配(失败不致命:人工匹配兜底)
  const { rows: questions } = await pool.query<{ id: string; content_md: string; subject: string }>(
    `SELECT pq.id::text, pq.content_md, p.subject FROM paper_questions pq
     JOIN papers p ON p.id = pq.paper_id
     WHERE pq.paper_id = $1 AND pq.matched_item_id IS NULL`,
    [paperId],
  );
  for (const q of questions) {
    try {
      const { auto } = await matchQuestion(
        pool, { embed: deps.embed, rerank: deps.rerank }, q.content_md, q.subject, deps.matchThreshold);
      if (auto) {
        await pool.query(
          `UPDATE paper_questions SET matched_item_id=$1, match_score=$2, matched_at=now()
           WHERE id=$3`, [auto.item_id, auto.vec_score, q.id]);
      }
    } catch (err) {
      console.error(`题目 ${q.id} 匹配失败(可人工匹配兜底)`, err);
    }
  }

  const { rows: [{ n }] } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM paper_questions WHERE paper_id=$1", [paperId]);
  if (n === 0) throw new Error("未识别出题目");
  await pool.query(
    "UPDATE papers SET status='ready_for_review', error=NULL, updated_at=now() WHERE id=$1",
    [paperId],
  );
}

/** backend 启动时重驱动滞留 processing 的卷(pipeline 幂等,安全)。 */
export async function redriveStuckPapers(pool: pg.Pool, deps: PaperJobDeps): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id::text FROM papers WHERE status='processing'");
  for (const r of rows) void drivePaper(pool, deps, r.id);
  return rows.length;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/papers/jobs.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/papers/jobs.ts backend/src/papers/jobs.test.ts
git commit -m "feat(backend): drivePaper 后台任务——pipeline 加工+自动匹配+状态推进"
```

---

## Task 11: routes——papers CRUD/上传/重试/重识别/图片

**Files:**

- Create: `backend/src/routes/papers.ts`
- Test: `backend/src/routes/papers.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { papersRoutes } from "./papers.js";
import type { PaperJobDeps } from "../papers/jobs.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const STORAGE_ROOT = "/tmp/kb-papers-test";

maybe("papers API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let deps: PaperJobDeps;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query("INSERT INTO children (id, name) VALUES ($1,'小宝')", [CHILD]);
    deps = {
      pipelineUrl: "http://x", matchThreshold: 0.88,
      embed: async () => { throw new Error("不应在路由测试里匹配"); },
      rerank: null,
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    };
    app = new Hono();
    app.route("/api/papers", papersRoutes(pool, deps, { storageRoot: "/tmp/kb-e2e-storage" } as never));
  });
  afterAll(async () => { await pool.end(); });

  function multipart(fields: Record<string, string>, files: { name: string; bytes: Uint8Array }[] = []) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append("files", new Blob([f.bytes]), f.name);
    return form;
  }

  async function upload(ok = true) {
    const png = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0));
    return app.request("/api/papers", {
      method: "POST",
      body: multipart(
        ok ? { child_id: CHILD, title: "期中卷", subject: "数学" } : {},
        [{ name: "p1.png", bytes: png }],
      ),
    });
  }

  it("上传:建行 processing + 触发后台任务 + 201", async () => {
    // drivePaper 会真调 fakeDeps.fetchImpl(返回 {} 也行,失败会落 failed,不影响建行断言)
    const resp = await upload();
    expect(resp.status).toBe(201);
    const body = await resp.json();
    expect(body.status).toBe("processing");
    expect(body.page_count).toBe(1);
    const row = (await pool.query("SELECT status, source_path FROM papers WHERE id=$1", [body.id])).rows[0];
    expect(row.status).toMatch(/processing|failed/);
  });

  it("上传校验:缺字段 422 / child 不存在 404 / 非法文件类型 422 / 无文件 422", async () => {
    expect((await upload(false)).status).toBe(422);
    const png = new Uint8Array([1]);
    const badChild = await app.request("/api/papers", { method: "POST",
      body: multipart({ child_id: "99999999-9999-9999-9999-999999999999", title: "t", subject: "数学" },
        [{ name: "a.png", bytes: png }]) });
    expect(badChild.status).toBe(404);
    const badType = await app.request("/api/papers", { method: "POST",
      body: multipart({ child_id: CHILD, title: "t", subject: "数学" },
        [{ name: "a.heic", bytes: png }]) });
    expect(badType.status).toBe(422);
    const noFile = await app.request("/api/papers", { method: "POST",
      body: multipart({ child_id: CHILD, title: "t", subject: "数学" }) });
    expect(noFile.status).toBe(422);
  });

  it("列表带确认进度;详情带全局序号;PATCH 改元数据", async () => {
    const up = await (await upload()).json();
    await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md) VALUES
        ($1,1,1,'q1'),($1,2,1,'q2')`, [up.id]);
    await pool.query(
      "UPDATE paper_questions SET confirmed_result='wrong' WHERE paper_id=$1 AND page_no=1", [up.id]);
    const list = await (await app.request("/api/papers?child_id=" + CHILD)).json();
    const mine = list.papers.find((p: { id: string }) => p.id === up.id);
    expect(mine).toMatchObject({ total_questions: 2, confirmed_questions: 1, status: "processing" });

    const detail = await (await app.request(`/api/papers/${up.id}`)).json();
    expect(detail.questions.map((q: { seq: number }) => q.seq)).toEqual([1, 2]);
    expect(detail.questions[0]).toMatchObject({ page_no: 1, content_md: "q1" });

    const patched = await app.request(`/api/papers/${up.id}`, {
      method: "PATCH", body: JSON.stringify({ title: "期末卷", subject: "英语" }),
      headers: { "Content-Type": "application/json" } });
    expect(patched.status).toBe(200);
    expect((await patched.json()).title).toBe("期末卷");
  });

  it("retry 只允许 failed;re-recognize 校验页码范围", async () => {
    const up = await (await upload()).json();
    const r1 = await app.request(`/api/papers/${up.id}/retry`, { method: "POST" });
    expect(r1.status).toBe(409);  // processing 不许 retry
    await pool.query("UPDATE papers SET status='failed', error='x' WHERE id=$1", [up.id]);
    const r2 = await app.request(`/api/papers/${up.id}/retry`, { method: "POST" });
    expect(r2.status).toBe(200);
    const rr = await app.request(`/api/papers/${up.id}/re-recognize`, {
      method: "POST", body: JSON.stringify({ page_no: 99 }),
      headers: { "Content-Type": "application/json" } });
    expect(rr.status).toBe(422);
  });

  it("页图回传:存在则 200 + image/png,缺失则 404", async () => {
    const { rows: [paper] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'图卷','数学','ready_for_review',1) RETURNING id::text`, [CHILD]);
    await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
       VALUES ($1,1,1,'q')`, [paper.id]);
    // 文件不存在 → 404
    const miss = await app.request(`/api/papers/${paper.id}/pages/1/image`);
    expect(miss.status).toBe(404);
    // 写入文件 → 200 + png
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(STORAGE_ROOT, "papers", paper.id, "pages");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "p0001.png"), Buffer.from("fakepng"));
    const ok = await app.request(`/api/papers/${paper.id}/pages/1/image`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
  });
});
```

注意:上传路由 `void drivePaper(...)` 会真实执行后台任务(用 fakeDeps 的 fetchImpl 返回 `{}`→JSON 解析 ok 但 resp.ok 检查……`new Response("{}")` status 200 → 匹配阶段 embed 抛错被 catch → 卷 ready/failed 由题目数决定;新建行无题目 → failed)。断言只看建行结果,不脆弱。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

```ts
/** 试卷产品 API:上传/列表/详情/元数据修改/重试/页级重识别/图片回传。 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { PaperJobDeps } from "../papers/jobs.js";
import { drivePaper } from "../papers/jobs.js";
import { assemblePdf } from "../papers/assemble.js";
import type { BackendConfig } from "../config.js";

const SUBJECTS = new Set(["语文", "数学", "英语", "其他"]);

function mapPgError(c: Context, err: unknown): Response {
  const code = (err as { code?: string })?.code;
  if (code === "23503") return c.json({ error: "child_id 不存在" }, 404);
  if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
  throw err;
}

export function papersRoutes(pool: pg.Pool, deps: PaperJobDeps, cfg: BackendConfig): Hono {
  const app = new Hono({ strict: false });

  app.post("/", async (c) => {
    let form: FormData;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "请求体须为 multipart" }, 400);
    }
    const childId = String(form.get("child_id") ?? "");
    const title = String(form.get("title") ?? "").trim();
    const subject = String(form.get("subject") ?? "");
    const files = [...form.getAll("files")].filter((f): f is File => f instanceof File);
    if (!childId || !title || !subject) {
      return c.json({ error: "child_id/title/subject 必填" }, 422);
    }
    if (!SUBJECTS.has(subject)) return c.json({ error: "subject 取值: 语文/数学/英语/其他" }, 422);
    if (files.length === 0) return c.json({ error: "至少上传一个文件(PDF/JPG/PNG)" }, 422);
    try {
      const { rows: child } = await pool.query("SELECT 1 FROM children WHERE id=$1", [childId]);
      if (!child.length) return c.json({ error: "child_id 不存在" }, 404);
      const assembled = await assemblePdf(
        files.map((f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const { rows: [paper] } = await pool.query(
        `INSERT INTO papers (child_id, title, subject, page_count)
         VALUES ($1,$2,$3,$4)
         RETURNING id::text, title, subject, status, page_count, created_at`,
        [childId, title, subject, assembled.pageCount]);
      void drivePaper(pool, deps, paper.id, { pdfBytes: assembled.bytes });
      return c.json(paper, 201);
    } catch (err) {
      if (err instanceof Error && /不支持的文件类型|至少上传/.test(err.message)) {
        return c.json({ error: err.message }, 422);
      }
      return mapPgError(c, err);
    }
  });

  app.get("/", async (c) => {
    const childId = c.req.query("child_id");
    const params: unknown[] = [];
    let where = "";
    if (childId) { where = "WHERE p.child_id=$1"; params.push(childId); }
    const { rows } = await pool.query(
      `SELECT p.id::text, p.title, p.subject, p.status, p.error, p.page_count, p.created_at,
              count(q.id)::int AS total_questions,
              count(q.id) FILTER (WHERE q.confirmed_result IS NOT NULL)::int AS confirmed_questions
       FROM papers p LEFT JOIN paper_questions q ON q.paper_id = p.id
       ${where} GROUP BY p.id ORDER BY p.created_at DESC`, params);
    return c.json({ papers: rows });
  });

  app.get("/:id", async (c) => {
    try {
      const { rows: [paper] } = await pool.query(
        `SELECT id::text, title, subject, child_id::text, status, error, page_count, created_at
         FROM papers WHERE id=$1`, [c.req.param("id")]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      const { rows: questions } = await pool.query(
        `SELECT pq.id::text, pq.page_no, pq.seq_in_page,
                row_number() OVER (ORDER BY pq.page_no, pq.seq_in_page)::int AS seq,
                pq.content_md, pq.answer_excerpt, pq.mark_desc,
                pq.recognized_result, pq.confirmed_result, pq.error_cause, pq.note,
                pq.matched_item_id::text, pq.match_score,
                i.label AS matched_label, i.chapter AS matched_chapter, d.title AS matched_doc_title
         FROM paper_questions pq
         LEFT JOIN items i ON i.id = pq.matched_item_id
         LEFT JOIN documents d ON d.id = i.document_id
         WHERE pq.paper_id=$1 ORDER BY pq.page_no, pq.seq_in_page`, [c.req.param("id")]);
      return c.json({ ...paper, questions });
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.patch("/:id", async (c) => {
    let body: { title?: string; subject?: string; child_id?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const title = body.title?.trim();
    if (body.title !== undefined && !title) return c.json({ error: "title 不能为空" }, 422);
    if (body.subject !== undefined && !SUBJECTS.has(body.subject)) {
      return c.json({ error: "subject 取值: 语文/数学/英语/其他" }, 422);
    }
    try {
      const { rows: [paper] } = await pool.query(
        `UPDATE papers SET
           title=coalesce($2, title), subject=coalesce($3, subject), child_id=coalesce($4, child_id),
           updated_at=now()
         WHERE id=$1
         RETURNING id::text, title, subject, child_id::text, status, page_count`,
        [c.req.param("id"), title ?? null, body.subject ?? null, body.child_id ?? null]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      return c.json(paper);
    } catch (err) {
      return mapPgError(c, err);
    }
  });

  app.post("/:id/retry", async (c) => {
    const { rows: [paper] } = await pool.query(
      "SELECT id::text, status FROM papers WHERE id=$1", [c.req.param("id")]);
    if (!paper) return c.json({ error: "试卷不存在" }, 404);
    if (paper.status !== "failed") return c.json({ error: "只有 failed 卷可重试" }, 409);
    await pool.query(
      "UPDATE papers SET status='processing', error=NULL, updated_at=now() WHERE id=$1", [paper.id]);
    void drivePaper(pool, deps, paper.id);
    return c.json({ id: paper.id, status: "processing" });
  });

  app.post("/:id/re-recognize", async (c) => {
    let body: { page_no?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const pageNo = Number(body.page_no);
    if (!Number.isInteger(pageNo) || pageNo < 1) return c.json({ error: "page_no 须为正整数" }, 422);
    const { rows: [paper] } = await pool.query(
      "SELECT id::text, status, page_count FROM papers WHERE id=$1", [c.req.param("id")]);
    if (!paper) return c.json({ error: "试卷不存在" }, 404);
    if (pageNo > paper.page_count) return c.json({ error: `page_no 越界(共 ${paper.page_count} 页)` }, 422);
    if (paper.status === "processing") return c.json({ error: "处理中,勿并发重识别" }, 409);
    await pool.query(
      "UPDATE papers SET status='processing', updated_at=now() WHERE id=$1", [paper.id]);
    void drivePaper(pool, deps, paper.id, { pageNo });
    return c.json({ id: paper.id, status: "processing", page_no: pageNo });
  });

  app.get("/:id/pages/:page_no/image", async (c) => {
    const pageNo = Number(c.req.param("page_no"));
    const { rows: [paper] } = await pool.query(
      "SELECT id::text, page_count FROM papers WHERE id=$1", [c.req.param("id")]);
    if (!paper) return c.json({ error: "试卷不存在" }, 404);
    if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > paper.page_count) {
      return c.json({ error: "page_no 越界" }, 422);
    }
    const path = join(cfg.storageRoot, "papers", paper.id, "pages", `p${String(pageNo).padStart(4, "0")}.png`);
    try {
      const buf = await readFile(path);
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
    } catch {
      return c.json({ error: "页图缺失" }, 404);
    }
  });

  return app;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/papers.ts backend/src/routes/papers.test.ts
git commit -m "feat(backend): papers API——上传/列表/详情/元数据/重试/重识别/页图"
```

---

## Task 12: routes——paper-questions 确认/匹配/候选/题图

**Files:**

- Create: `backend/src/routes/paperQuestions.ts`
- Test: `backend/src/routes/paperQuestions.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { paperQuestionsRoutes } from "./paperQuestions.js";
import type { PaperJobDeps } from "../papers/jobs.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const CHILD = "11111111-1111-1111-1111-111111111111";
const DOC = "33333333-3333-3333-3333-333333333333";
const ITEM = "22222222-2222-2222-2222-222222222222";

maybe("paper-questions API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let paperId: string;
  let q1: string;
  let q2: string;

  const deps: PaperJobDeps = {
    pipelineUrl: "http://x", matchThreshold: 0.88,
    // embed 指向 ITEM(向量 V1),candidates 接口会命中它
    embed: async () => [[1, ...new Array(1023).fill(0)]],
    rerank: async (_q: string, docs: string[]) => docs.map(() => 1),
  };

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    await pool.query("INSERT INTO children (id, name) VALUES ($1,'小宝')", [CHILD]);
    await pool.query(
      "INSERT INTO documents (id, title, subject, source_path) VALUES ($1,'数学书','数学','/tmp/a.pdf')", [DOC]);
    await pool.query(
      "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES ($1,$2,'exercise','1','135 ÷ 5 =')",
      [ITEM, DOC]);
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
        ($1,$2,'135 ÷ 5 =','{"subject":"数学","label":"1","doc_title":"数学书"}'::jsonb,
         '[${[1, ...new Array(1023).fill(0)].join(",")}]'::vector)`, [ITEM, DOC]);
    const { rows: [p] } = await pool.query(
      "INSERT INTO papers (child_id, title, subject, status, page_count) VALUES ($1,'卷','数学','ready_for_review',1) RETURNING id::text",
      [CHILD]);
    paperId = p.id;
    const { rows: [a] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, recognized_result)
       VALUES ($1,1,1,'135 ÷ 5 =','wrong') RETURNING id::text`, [paperId]);
    q1 = a.id;
    const { rows: [b] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md)
       VALUES ($1,1,2,'画一画') RETURNING id::text`, [paperId]);
    q2 = b.id;
    app = new Hono();
    app.route("/api/paper-questions", paperQuestionsRoutes(pool, deps));
  });
  afterAll(async () => { await pool.end(); });

  it("confirm:写 confirmed + INSERT attempt;全确认推进 done", async () => {
    const r = await app.request(`/api/paper-questions/${q1}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "wrong", error_cause: "计算错", note: "对位错" }),
      headers: { "Content-Type": "application/json" } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.paper_status).toBe("ready_for_review");  // 还有 q2 未确认
    const attempt = (await pool.query(
      "SELECT child_id::text, item_id, paper_question_id::text, result, error_cause, note FROM attempts")).rows[0];
    expect(attempt).toMatchObject({
      child_id: CHILD, item_id: null, paper_question_id: q1,
      result: "wrong", error_cause: "计算错", note: "对位错",
    });
    await app.request(`/api/paper-questions/${q2}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "correct" }),
      headers: { "Content-Type": "application/json" } });
    const paper = (await pool.query("SELECT status FROM papers WHERE id=$1", [paperId])).rows[0];
    expect(paper.status).toBe("done");
  });

  it("改判 = UPDATE 同一条 attempt(不追加);匹配后同步 item_id", async () => {
    await app.request(`/api/paper-questions/${q1}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "partial", error_cause: "粗心" }),
      headers: { "Content-Type": "application/json" } });
    const n = (await pool.query("SELECT count(*)::int AS n FROM attempts")).rows[0].n;
    expect(n).toBe(2);  // q1 + q2 各一条,改判没加行
    // 人工匹配 q1 -> ITEM
    const m = await app.request(`/api/paper-questions/${q1}/match`, {
      method: "PUT", body: JSON.stringify({ item_id: ITEM, score: 0.93 }),
      headers: { "Content-Type": "application/json" } });
    expect(m.status).toBe(200);
    const attempt = (await pool.query(
      "SELECT item_id::text, result FROM attempts WHERE paper_question_id=$1", [q1])).rows[0];
    expect(attempt).toMatchObject({ item_id: ITEM, result: "partial" });
    // 清除匹配 -> item_id 回 NULL(paper_question_id 仍在,CHECK 满足)
    await app.request(`/api/paper-questions/${q1}/match`, {
      method: "PUT", body: JSON.stringify({ item_id: null }),
      headers: { "Content-Type": "application/json" } });
    const cleared = (await pool.query(
      "SELECT item_id FROM attempts WHERE paper_question_id=$1", [q1])).rows[0];
    expect(cleared.item_id).toBeNull();
  });

  it("校验:result 枚举 422;match 不存在 item 404;不存在题目 404", async () => {
    const bad = await app.request(`/api/paper-questions/${q1}/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "对" }),
      headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(422);
    const badItem = await app.request(`/api/paper-questions/${q1}/match`, {
      method: "PUT", body: JSON.stringify({ item_id: "99999999-9999-9999-9999-999999999999" }),
      headers: { "Content-Type": "application/json" } });
    expect(badItem.status).toBe(404);
    const missing = await app.request(`/api/paper-questions/88888888-8888-8888-8888-888888888888/confirm`, {
      method: "PUT", body: JSON.stringify({ result: "wrong" }),
      headers: { "Content-Type": "application/json" } });
    expect(missing.status).toBe(404);
  });

  it("candidates:实时检索返回 top 候选(带 doc_title/label)", async () => {
    const r = await app.request(`/api/paper-questions/${q1}/candidates`);
    expect(r.status).toBe(200);
    const { candidates } = await r.json();
    expect(candidates[0]).toMatchObject({
      item_id: ITEM, doc_title: "数学书", label: "1",
    });
    expect(candidates[0].vec_score).toBeGreaterThan(0.88);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/paperQuestions.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

```ts
/** 试卷题确认流:对错确认(attempts upsert)、题库匹配设置、实时候选、题图回传。 */
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { PaperJobDeps } from "../papers/jobs.js";
import { matchQuestion } from "../retrieval/match.js";

const RESULTS = new Set(["correct", "wrong", "partial"]);
const CAUSES = new Set(["粗心", "概念不清", "方法不会", "计算错"]);

async function withTx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function paperQuestionsRoutes(pool: pg.Pool, deps: PaperJobDeps): Hono {
  const app = new Hono({ strict: false });

  app.put("/:id/confirm", async (c) => {
    let body: { result?: string; error_cause?: string; note?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const result = body.result ?? "";
    if (!RESULTS.has(result)) return c.json({ error: "result 取值: correct|wrong|partial" }, 422);
    if (body.error_cause != null && !CAUSES.has(body.error_cause)) {
      return c.json({ error: "error_cause 取值: 粗心/概念不清/方法不会/计算错" }, 422);
    }
    const qid = c.req.param("id");
    try {
      return await withTx(pool, async (client) => {
        const { rows: [q] } = await client.query(
          `SELECT pq.id::text, pq.matched_item_id, p.child_id, p.id::text AS paper_id
           FROM paper_questions pq JOIN papers p ON p.id = pq.paper_id WHERE pq.id=$1`, [qid]);
        if (!q) return c.json({ error: "题目不存在" }, 404);
        await client.query(
          `UPDATE paper_questions SET confirmed_result=$1, error_cause=$2, note=$3, updated_at=now()
           WHERE id=$4`, [result, body.error_cause ?? null, body.note ?? null, qid]);
        const { rows: existing } = await client.query(
          "SELECT id::text FROM attempts WHERE paper_question_id=$1", [qid]);
        if (existing.length) {  // 改判 = UPDATE,不追加
          await client.query(
            `UPDATE attempts SET item_id=$1, result=$2, error_cause=$3, note=$4
             WHERE paper_question_id=$5`,
            [q.matched_item_id, result, body.error_cause ?? null, body.note ?? null, qid]);
        } else {
          await client.query(
            `INSERT INTO attempts (child_id, item_id, paper_question_id, result, error_cause, note)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [q.child_id, q.matched_item_id, qid, result, body.error_cause ?? null, body.note ?? null]);
        }
        const { rows: [paper] } = await client.query(
          `UPDATE papers SET status = CASE
             WHEN NOT EXISTS (
               SELECT 1 FROM paper_questions WHERE paper_id=$1 AND confirmed_result IS NULL)
             THEN 'done' ELSE 'ready_for_review' END,
             updated_at=now()
           WHERE id=$1 RETURNING status`, [q.paper_id]);
        return c.json({
          id: qid, confirmed_result: result,
          error_cause: body.error_cause ?? null, note: body.note ?? null,
          paper_status: paper.status,
        });
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      throw err;
    }
  });

  app.put("/:id/match", async (c) => {
    let body: { item_id?: string | null; score?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const qid = c.req.param("id");
    const itemId = body.item_id ?? null;
    try {
      return await withTx(pool, async (client) => {
        const { rows: [q] } = await client.query(
          "SELECT id::text FROM paper_questions WHERE id=$1", [qid]);
        if (!q) return c.json({ error: "题目不存在" }, 404);
        if (itemId) {
          const { rows: item } = await client.query("SELECT 1 FROM items WHERE id=$1", [itemId]);
          if (!item.length) return c.json({ error: "item_id 不存在" }, 404);
        }
        await client.query(
          `UPDATE paper_questions
           SET matched_item_id=$1, match_score=$2, matched_at=CASE WHEN $1::uuid IS NULL THEN NULL ELSE now() END,
               updated_at=now()
           WHERE id=$3`, [itemId, itemId ? body.score ?? null : null, qid]);
        await client.query(
          "UPDATE attempts SET item_id=$1 WHERE paper_question_id=$2", [itemId, qid]);
        return c.json({ id: qid, matched_item_id: itemId, match_score: itemId ? body.score ?? null : null });
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      if (code === "23503") return c.json({ error: "item_id 不存在" }, 404);
      throw err;
    }
  });

  app.get("/:id/candidates", async (c) => {
    const { rows: [q] } = await pool.query(
      `SELECT pq.content_md, p.subject FROM paper_questions pq
       JOIN papers p ON p.id = pq.paper_id WHERE pq.id=$1`, [c.req.param("id")]);
    if (!q) return c.json({ error: "题目不存在" }, 404);
    const { candidates } = await matchQuestion(
      pool, { embed: deps.embed, rerank: deps.rerank }, q.content_md, q.subject, deps.matchThreshold);
    return c.json({ candidates });
  });

  app.get("/:id/image", async (c) => {
    const { rows: [q] } = await pool.query(
      "SELECT image_path FROM paper_questions WHERE id=$1", [c.req.param("id")]);
    if (!q) return c.json({ error: "题目不存在" }, 404);
    if (!q.image_path) return c.json({ error: "该题无裁图" }, 404);
    try {
      const buf = await readFile(q.image_path);
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
    } catch {
      return c.json({ error: "题图缺失" }, 404);
    }
  });

  return app;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/paperQuestions.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/paperQuestions.ts backend/src/routes/paperQuestions.test.ts
git commit -m "feat(backend): paper-questions 确认/匹配/候选/题图 API(attempts upsert)"
```

---

## Task 13: index.ts 接线 + 启动重驱动

**Files:**

- Modify: `backend/src/index.ts`
- Test: `backend/src/index.test.ts`(若不存在则 Create;用 chat.test.ts 的注入模式)

- [ ] **Step 1: 写失败测试(Create backend/src/index.test.ts)**

```ts
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

/** createApp 可注入任务依赖(测试不打真 pipeline)。 */
it("createApp 挂载试卷路由(未挂载时是 404 not found,挂载后是业务错误)", async () => {
  const app = createApp({
    databaseUrl: "postgresql://localhost/kb",
    chatBaseUrl: "http://x", chatApiKey: "k", chatModel: "m", chatModels: ["m"],
    embedBaseUrl: "http://x", embedModel: "e", pipelineUrl: "http://x",
    rerankProvider: "none", port: 8787,
    storageRoot: "/tmp", matchThreshold: 0.88,
  }, {
    paperJobs: {
      pipelineUrl: "http://x", matchThreshold: 0.88,
      embed: async () => { throw new Error("no"); }, rerank: null,
    },
  });
  const resp = await app.request("/api/papers");
  // 不带真库时列表查询会抛错;只要路由挂上了,错误就不是 404 "not found" 文本
  expect([500, 200]).toContain(resp.status);
});
```

实现说明:`createApp(cfg, opts?: { paperJobs?: PaperJobDeps })`——第二个参数只透传给试卷任务;缺省现场组装(embed 用 cfg、rerank 用 makeReranker)。此测试只验证路由挂载,不触库细节。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/index.test.ts`
Expected: FAIL——createApp 不接受第二参数/路由未挂载(404)。

- [ ] **Step 3: 实现**

`backend/src/index.ts` 的 `createApp` 改为:

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig, type BackendConfig } from "./config.js";
import { getPool } from "./db.js";
import { chatRoute, makeAgentFactory } from "./agent/chat.js";
import { JsonlSessionStore } from "./agent/sessions.js";
import { embedTexts } from "./retrieval/embed.js";
import { makeReranker } from "./retrieval/rerank.js";
import { hybridSearch } from "./retrieval/search.js";
import { childrenRoutes } from "./routes/children.js";
import { attemptsRoutes } from "./routes/attempts.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { modelsRoutes } from "./routes/models.js";
import { papersRoutes } from "./routes/papers.js";
import { paperQuestionsRoutes } from "./routes/paperQuestions.js";
import { redriveStuckPapers, type PaperJobDeps } from "./papers/jobs.js";

export function createApp(
  cfg: BackendConfig = loadConfig(),
  opts: { paperJobs?: PaperJobDeps } = {},
) {
  const app = new Hono();
  const pool = getPool(cfg.databaseUrl);
  const rerank = makeReranker(cfg.rerankProvider, cfg.pipelineUrl);
  const search = (q: string, filters?: Record<string, string>) =>
    hybridSearch(pool, {
      embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
      rerank,
    }, q, { filters });
  const paperJobs: PaperJobDeps = opts.paperJobs ?? {
    pipelineUrl: cfg.pipelineUrl,
    matchThreshold: cfg.matchThreshold,
    embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
    rerank,
  };
  const factory = makeAgentFactory(cfg, pool, search);
  const sessionStore = new JsonlSessionStore();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/chat", chatRoute(factory, {
    store: sessionStore,
    defaultModel: cfg.chatModel,
    models: cfg.chatModels,
    onUsage: async (u, model) => {
      await pool.query(
        `INSERT INTO llm_calls (document_id, purpose, model, modality, prompt_tokens, completion_tokens)
         VALUES (NULL, 'chat', $1, 'text', $2, $3)`,
        [model, u.input, u.output],
      );
    },
  }));
  app.route("/api/sessions", sessionsRoutes(sessionStore));
  app.route("/api/models", modelsRoutes(cfg.chatModels));
  app.route("/api/children", childrenRoutes(pool));
  app.route("/api/attempts", attemptsRoutes(pool));
  app.route("/api/papers", papersRoutes(pool, paperJobs, cfg));
  app.route("/api/paper-questions", paperQuestionsRoutes(pool, paperJobs));
  return app;
}

if (process.env.VITEST === undefined) {
  const cfg = loadConfig();
  serve({ fetch: createApp(cfg).fetch, port: cfg.port }, (info) => {
    console.log(`backend  listening on http://127.0.0.1:${info.port}`);
    // 启动重驱动:滞留 processing 的卷(pipeline 幂等,安全)
    const pool = getPool(cfg.databaseUrl);
    const jobs: PaperJobDeps = {
      pipelineUrl: cfg.pipelineUrl,
      matchThreshold: cfg.matchThreshold,
      embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
      rerank: makeReranker(cfg.rerankProvider, cfg.pipelineUrl),
    };
    void redriveStuckPapers(pool, jobs).then((n) => {
      if (n > 0) console.log(`重驱动 ${n} 卷滞留 processing 的试卷`);
    });
  });
}
```

- [ ] **Step 4: 全量回归 + 构建**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test && npm run build`
Expected: 全部 PASS + tsc 构建通过。

- [ ] **Step 5: Commit**

```bash
git add backend/src/index.ts backend/src/index.test.ts
git commit -m "feat(backend): 试卷路由接线 + 启动重驱动滞留卷"
```

---

## Task 14: frontend——api/papers.ts

**Files:**

- Create: `frontend/src/api/papers.ts`
- Test: `frontend/src/api/papers.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { confirmQuestion, fetchPapers, uploadPaper } from "./papers";

const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("papers api", () => {
  it("uploadPaper:multipart 携带文件与字段", async () => {
    let captured: FormData | null = null;
    const paper = await uploadPaper(
      { child_id: "c1", title: "期中卷", subject: "数学", files: [new File([new Uint8Array([1])], "a.png")] },
      async (_url, init) => {
        captured = init?.body as FormData;
        return jsonResp({ id: "p1", status: "processing" }, 201);
      });
    expect(paper.id).toBe("p1");
    expect(captured!.get("child_id")).toBe("c1");
    expect(captured!.get("subject")).toBe("数学");
    expect((captured!.getAll("files")[0] as File).name).toBe("a.png");
  });

  it("fetchPapers:GET /api/papers?child_id=", async () => {
    let url = "";
    const { papers } = await fetchPapers("c1", async (input) => {
      url = String(input);
      return jsonResp({ papers: [{ id: "p1", status: "done" }] });
    });
    expect(url).toBe("/api/papers?child_id=c1");
    expect(papers[0].id).toBe("p1");
  });

  it("confirmQuestion:PUT body + 返回 paper_status;非 2xx 抛错", async () => {
    let captured = "";
    const out = await confirmQuestion("q1", { result: "wrong", error_cause: "计算错" }, async (input, init) => {
      captured = String(init?.body);
      return jsonResp({ id: "q1", paper_status: "done" });
    });
    expect(out.paper_status).toBe("done");
    expect(JSON.parse(captured)).toEqual({ result: "wrong", error_cause: "计算错" });
    await expect(confirmQuestion("q1", { result: "wrong" }, async () => jsonResp({}, 422)))
      .rejects.toThrow("请求失败: 422");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/api/papers.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

```ts
/** 试卷产品 API(frontend 视角)。类型与 backend 路由返回对齐。 */

export type PaperStatus = "processing" | "ready_for_review" | "done" | "failed";

export interface PaperSummary {
  id: string;
  title: string;
  subject: string;
  status: PaperStatus;
  error: string | null;
  page_count: number;
  created_at: string;
  total_questions: number;
  confirmed_questions: number;
}

export interface PaperQuestion {
  id: string;
  paper_id: string;
  page_no: number;
  seq_in_page: number;
  seq: number;
  content_md: string;
  answer_excerpt: string | null;
  mark_desc: string | null;
  recognized_result: "correct" | "wrong" | "partial" | null;
  confirmed_result: "correct" | "wrong" | "partial" | null;
  error_cause: string | null;
  note: string | null;
  matched_item_id: string | null;
  match_score: number | null;
  matched_label: string | null;
  matched_chapter: string | null;
  matched_doc_title: string | null;
}

export interface PaperDetail extends PaperSummary {
  child_id: string;
  questions: PaperQuestion[];
}

export interface MatchCandidate {
  item_id: string;
  content_md: string;
  vec_score?: number;
  label?: string | null;
  chapter?: string | null;
  doc_title?: string | null;
}

type FetchLike = typeof fetch;

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
  return (await resp.json()) as T;
}

export function uploadPaper(
  form: { child_id: string; title: string; subject: string; files: File[] },
  fetchImpl: FetchLike = fetch,
): Promise<PaperSummary> {
  const fd = new FormData();
  fd.append("child_id", form.child_id);
  fd.append("title", form.title);
  fd.append("subject", form.subject);
  form.files.forEach((f) => fd.append("files", f));
  return fetchImpl("/api/papers", { method: "POST", body: fd }).then((r) => json<PaperSummary>(r));
}

export function fetchPapers(childId?: string, fetchImpl: FetchLike = fetch) {
  const qs = childId ? `?child_id=${encodeURIComponent(childId)}` : "";
  return fetchImpl(`/api/papers${qs}`).then((r) => json<{ papers: PaperSummary[] }>(r));
}

export function fetchPaperDetail(id: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}`).then((r) => json<PaperDetail>(r));
}

export function patchPaper(id: string, body: { title?: string; subject?: string; child_id?: string },
                           fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => json<PaperSummary>(r));
}

export function retryPaper(id: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}/retry`, { method: "POST" })
    .then((r) => json<{ id: string; status: PaperStatus }>(r));
}

export function reRecognizePaper(id: string, pageNo: number, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}/re-recognize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_no: pageNo }),
  }).then((r) => json<{ id: string; status: PaperStatus }>(r));
}

export function confirmQuestion(
  id: string,
  body: { result: string; error_cause?: string; note?: string },
  fetchImpl: FetchLike = fetch,
) {
  return fetchImpl(`/api/paper-questions/${encodeURIComponent(id)}/confirm`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => json<{ id: string; paper_status: PaperStatus }>(r));
}

export function matchQuestion(
  id: string,
  itemId: string | null,
  score?: number,
  fetchImpl: FetchLike = fetch,
) {
  return fetchImpl(`/api/paper-questions/${encodeURIComponent(id)}/match`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id: itemId, score }),
  }).then((r) => json<{ id: string; matched_item_id: string | null }>(r));
}

export function fetchCandidates(id: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/paper-questions/${encodeURIComponent(id)}/candidates`)
    .then((r) => json<{ candidates: MatchCandidate[] }>(r));
}

export function questionImageUrl(id: string): string {
  return `/api/paper-questions/${encodeURIComponent(id)}/image`;
}

export function pageImageUrl(paperId: string, pageNo: number): string {
  return `/api/papers/${encodeURIComponent(paperId)}/pages/${pageNo}/image`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/api/papers.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/papers.ts frontend/src/api/papers.test.ts
git commit -m "feat(frontend): 试卷 api 层"
```

---

## Task 15: frontend——ReviewView + 上传弹层 + 键盘流转 + Rail 接线

**Files:**

- Create: `frontend/src/views/ReviewView.tsx`
- Create: `frontend/src/components/PaperQueue.tsx`
- Create: `frontend/src/components/UploadDialog.tsx`
- Create: `frontend/src/components/QuestionCard.tsx`
- Create: `frontend/src/components/MatchPicker.tsx`
- Modify: `frontend/src/components/Rail.tsx`(复核按钮启用 + 视图切换 props)
- Modify: `frontend/src/App.tsx`(视图切换)
- Modify: `frontend/src/theme.css`(复核样式)
- Test: `frontend/src/views/ReviewView.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { ReviewView } from "./ReviewView";

afterEach(() => vi.unstubAllGlobals());

const CHILDREN = [{ id: "c1", name: "小宝", grade: null, created_at: "2026-01-01" }];

function paper(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "p1", title: "期中卷", subject: "数学", status, error: null, page_count: 1,
    created_at: "2026-09-03", total_questions: 2, confirmed_questions: 0, ...extra,
  };
}

function detail(questions: unknown[]) {
  return {
    id: "p1", title: "期中卷", subject: "数学", child_id: "c1", status: "ready_for_review",
    error: null, page_count: 1, created_at: "2026-09-03",
    total_questions: questions.length, confirmed_questions: 0, questions,
  };
}

const Q1 = {
  id: "q1", paper_id: "p1", page_no: 1, seq_in_page: 1, seq: 1,
  content_md: "135 ÷ 5 =", answer_excerpt: "27", mark_desc: "红笔 ✗",
  recognized_result: "wrong", confirmed_result: null, error_cause: null, note: null,
  matched_item_id: null, match_score: null, matched_label: null,
  matched_chapter: null, matched_doc_title: null,
};
const Q2 = { ...Q1, id: "q2", seq_in_page: 2, seq: 2, content_md: "画一画", recognized_result: null };

function stub(routes: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal("fetch", fetchRouter(routes));
}

describe("ReviewView", () => {
  it("挂载:左侧卷列表 + 选中卷加载题目详情", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1, Q2])),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    // VLM 预识别展示 + 预选中提示
    expect(screen.getByText(/红笔 ✗/)).toBeInTheDocument();
  });

  it("键盘流转:1=错(确认并下一条),Enter=采纳预选;焦点在输入框时不触发", async () => {
    const confirms: unknown[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1, Q2])),
      "/api/paper-questions/q1/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q1", paper_status: "ready_for_review" });
      },
      "/api/paper-questions/q2/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q2", paper_status: "done" });
      },
    });
    render(<ReviewView />);
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    // 焦点在备注框时按 1 不触发(keydown 冒泡到 window,target 是输入框被拦)
    fireEvent.keyDown(screen.getByLabelText("备注"), { key: "1" });
    expect(confirms).toEqual([]);
    // 焦点在 body:1 = 错,确认并跳下一条
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(confirms[0]).toEqual({ result: "wrong" }));
    await waitFor(() => expect(screen.getByText("画一画")).toBeInTheDocument());
    // Enter = 采纳预选(Q2 无预选,不触发)
    fireEvent.keyDown(window, { key: "Enter" });
    expect(confirms).toHaveLength(1);
  });

  it("确认带错因与备注(先填后按键)", async () => {
    const confirms: unknown[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/paper-questions/q1/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q1", paper_status: "done" });
      },
    });
    render(<ReviewView />);
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("错因"), { target: { value: "计算错" } });
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "对位错" } });
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(confirms[0]).toEqual({
      result: "wrong", error_cause: "计算错", note: "对位错",
    }));
  });

  it("匹配:待匹配题点开候选浮层点选关联", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/paper-questions/q1/candidates": () => jsonResponse({
        candidates: [{ item_id: "i1", content_md: "135 ÷ 5 =", vec_score: 0.93, label: "1", chapter: "第3讲", doc_title: "数学书" }],
      }),
      "/api/paper-questions/q1/match": () => jsonResponse({ id: "q1", matched_item_id: "i1" }),
    });
    render(<ReviewView />);
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /待匹配/ }));
    const popover = await screen.findByRole("dialog");
    fireEvent.click(within(popover).getByText(/数学书/));
    await waitFor(() =>
      expect(screen.getByText(/数学书 · 第3讲 · 1/)).toBeInTheDocument());
  });

  it("上传弹层:填表提交 multipart 后刷新列表并选中", async () => {
    let captured: FormData | null = null;
    let listCalls = 0;
    stub({
      "/api/children": () => jsonResponse(CHILDREN),
      "/api/papers": () => {
        listCalls++;
        return jsonResponse({ papers: listCalls === 1 ? [] : [paper("processing")] });
      },
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/papers/upload": () => { throw new Error("不应调用"); },
    });
    // 覆盖 POST /api/papers(路由按 method 区分——fetchRouter 只按 URL,这里手写)
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/papers" && init?.method === "POST") {
        captured = init.body as FormData;
        return jsonResponse(paper("processing"), 201);
      }
      if (url === "/api/children") return jsonResponse(CHILDREN);
      if (url === "/api/papers") return jsonResponse({ papers: [paper("processing")] });
      if (url === "/api/papers/p1") return jsonResponse(detail([Q1]));
      return new Response("404", { status: 404 });
    });
    render(<ReviewView />);
    fireEvent.click(screen.getByRole("button", { name: "上传试卷" }));
    fireEvent.change(await screen.findByLabelText("孩子"), { target: { value: "c1" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "期中卷" } });
    fireEvent.change(screen.getByLabelText("科目"), { target: { value: "数学" } });
    const file = new File([new Uint8Array([1])], "p1.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(captured!.get("title")).toBe("期中卷"));
    // 列表刷新出现新卷(用队列项断言,避免与详情区《》标题歧义)
    await waitFor(() => expect(screen.getByRole("button", { name: /期中卷/ })).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/ReviewView.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现组件**

`frontend/src/components/PaperQueue.tsx`:

```tsx
import type { PaperSummary } from "../api/papers";

const STATUS_TEXT: Record<string, string> = {
  processing: "处理中",
  ready_for_review: "待复核",
  done: "已完成",
  failed: "失败",
};

interface PaperQueueProps {
  papers: PaperSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpload: () => void;
}

export function PaperQueue({ papers, selectedId, onSelect, onUpload }: PaperQueueProps) {
  return (
    <aside className="papers-queue">
      <div className="pq-head">
        <span className="label">试卷</span>
        <button className="new-btn" onClick={onUpload}>＋ 上传试卷</button>
      </div>
      <div className="pq-list">
        {papers.length === 0 && <div className="empty">还没有上传试卷</div>}
        {papers.map((p) => (
          <button
            key={p.id}
            className={`paper-item${p.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="t">{p.title}</span>
            <span className="m">
              <span className={`status ${p.status}`}>{STATUS_TEXT[p.status]}</span>
              {p.status === "failed" && <span className="err" title={p.error ?? ""}>重试</span>}
              {p.total_questions > 0 && (
                <span>{p.confirmed_questions}/{p.total_questions}</span>
              )}
              <span>{p.subject}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
```

`frontend/src/components/UploadDialog.tsx`:

```tsx
import { useState } from "react";
import { uploadPaper, type PaperSummary } from "../api/papers";

interface UploadDialogProps {
  children: { id: string; name: string }[];
  onDone: (paper: PaperSummary) => void;
  onClose: () => void;
}

const SUBJECTS = ["语文", "数学", "英语", "其他"];

export function UploadDialog({ children: kids, onDone, onClose }: UploadDialogProps) {
  const [childId, setChildId] = useState(kids[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("数学");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!childId || !title.trim() || files.length === 0) {
      setError("孩子、标题、文件都必填");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onDone(await uploadPaper(
        { child_id: childId, title: title.trim(), subject, files }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="上传试卷" onClick={(e) => e.stopPropagation()}>
        <h2>上传试卷</h2>
        <label>
          孩子
          <select aria-label="孩子" value={childId} onChange={(e) => setChildId(e.target.value)}>
            {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
        <label>
          标题
          <input aria-label="标题" value={title} onChange={(e) => setTitle(e.target.value)}
                 placeholder="如：三年级数学期中卷" />
        </label>
        <label>
          科目
          <select aria-label="科目" value={subject} onChange={(e) => setSubject(e.target.value)}>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          文件（PDF/JPG/PNG，可多选）
          <input aria-label="文件" type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
                 onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </label>
        {files.length > 0 && <div className="file-list">{files.map((f) => f.name).join("、")}</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>提交</button>
        </div>
      </div>
    </div>
  );
}
```

`frontend/src/components/QuestionCard.tsx`:

```tsx
import { questionImageUrl, type PaperQuestion } from "../api/papers";

/** 当前题双栏:原卷裁图 | 识别内容(题干/作答/痕迹/匹配行)。 */
export function QuestionCard({ question }: { question: PaperQuestion }) {
  return (
    <div className="qcard-paper">
      <div className="pane">
        <h3>原卷裁图</h3>
        <div className="crop-box">
          <img src={questionImageUrl(question.id)} alt={`第 ${question.seq} 题裁图`}
               onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      </div>
      <div className="pane">
        <h3>识别出的题目</h3>
        <div className="content">
          <p className="stem">{question.content_md}</p>
          {question.answer_excerpt && (
            <p className="muted">识别到的作答：{question.answer_excerpt}</p>
          )}
          {question.mark_desc && <p className="muted">批改痕迹：{question.mark_desc}</p>}
          {question.matched_doc_title ? (
            <p className="match-line">
              题库匹配：{question.matched_doc_title}
              {question.matched_chapter ? ` · ${question.matched_chapter}` : ""}
              {question.matched_label ? ` · ${question.matched_label}` : ""}
              {question.match_score != null && ` · ${(question.match_score).toFixed(2)}`}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

`frontend/src/components/MatchPicker.tsx`:

```tsx
import { useEffect, useState } from "react";
import { fetchCandidates, matchQuestion, type MatchCandidate, type PaperQuestion } from "../api/papers";

/** 候选浮层:实时检索 top-5,点选关联;已匹配可清除。 */
export function MatchPicker({ question, onMatched }: {
  question: PaperQuestion;
  onMatched: (q: PaperQuestion) => void;
}) {
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchCandidates(question.id).then((r) => setCandidates(r.candidates)).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [question.id]);

  const pick = async (item: MatchCandidate | null) => {
    try {
      await matchQuestion(question.id, item?.item_id ?? null, item?.vec_score);
      onMatched({
        ...question,
        matched_item_id: item?.item_id ?? null,
        match_score: item?.vec_score ?? null,
        matched_label: item?.label ?? null,
        matched_chapter: item?.chapter ?? null,
        matched_doc_title: item?.doc_title ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="dialog-mask">
      <div className="dialog" role="dialog" aria-label="选择题库条目">
        <h2>匹配题库条目</h2>
        <div className="cand-list">
          {error && <div className="form-error">{error}</div>}
          {!error && candidates.length === 0 && <div className="empty">没有候选</div>}
          {candidates.map((c) => (
            <button key={c.item_id} className="cand" onClick={() => void pick(c)}>
              <span className="t">{c.content_md.slice(0, 60)}</span>
              <span className="m">
                {c.doc_title}{c.chapter ? ` · ${c.chapter}` : ""}{c.label ? ` · ${c.label}` : ""}
                {c.vec_score != null && ` · ${c.vec_score.toFixed(2)}`}
              </span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          {question.matched_item_id && (
            <button onClick={() => void pick(null)}>清除匹配</button>
          )}
          <button className="primary" onClick={() => onMatched(question)}>关闭</button>
        </div>
      </div>
    </div>
  );
}
```

`frontend/src/views/ReviewView.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  confirmQuestion, fetchPapers, fetchPaperDetail, retryPaper, reRecognizePaper,
  type PaperDetail, type PaperQuestion, type PaperSummary,
} from "../api/papers";
import { MatchPicker } from "../components/MatchPicker";
import { PaperQueue } from "../components/PaperQueue";
import { QuestionCard } from "../components/QuestionCard";
import { UploadDialog } from "../components/UploadDialog";

const CAUSES = ["粗心", "概念不清", "方法不会", "计算错"];

/** 复核视图:左列试卷队列 + 右侧当前题确认流(键盘 1/2/3 + Enter)。 */
export function ReviewView() {
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [kids, setKids] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [cause, setCause] = useState("");
  const [note, setNote] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadPapers = useCallback(async () => {
    try {
      const { papers: list } = await fetchPapers();
      setPapers(list);
    } catch (err) {
      console.error("试卷列表加载失败", err);
    }
  }, []);

  useEffect(() => {
    void loadPapers();
    fetch("/api/children").then((r) => r.json()).then((d: { children: { id: string; name: string }[] }) =>
      setKids(d.children)).catch(() => {});
  }, [loadPapers]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await fetchPaperDetail(id));
      setQIndex(0);
    } catch (err) {
      console.error("试卷详情加载失败", err);
    }
  }, []);

  // 有 processing 卷时轮询;选中卷处理完自动刷新详情
  useEffect(() => {
    if (!papers.some((p) => p.status === "processing")) return;
    const t = setInterval(() => void loadPapers(), 2000);
    return () => clearInterval(t);
  }, [papers, loadPapers]);
  useEffect(() => {
    const listed = papers.find((p) => p.id === selectedId);
    if (detail && detail.status === "processing" && listed && listed.status !== "processing") {
      void loadDetail(selectedId!);
    }
  }, [papers, loadDetail, detail, selectedId]);

  useEffect(() => {
    const q = detail?.questions[qIndex];
    setCause(q?.error_cause ?? "");
    setNote(q?.note ?? "");
  }, [qIndex, detail]);

  const current = detail?.questions[qIndex] ?? null;

  const doConfirm = useCallback(async (result: string) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const body: { result: string; error_cause?: string; note?: string } = { result };
      if (cause) body.error_cause = cause;
      if (note.trim()) body.note = note.trim();
      const out = await confirmQuestion(current.id, body);
      setDetail((d) => d && ({
        ...d, status: out.paper_status,
        questions: d.questions.map((q, i) =>
          i === qIndex ? { ...q, confirmed_result: result as PaperQuestion["confirmed_result"],
            error_cause: cause || null, note: note.trim() || null } : q),
      }));
      if (qIndex < (detail?.questions.length ?? 0) - 1) setQIndex(qIndex + 1);
    } catch (err) {
      console.error("确认失败", err);
    } finally {
      setBusy(false);
    }
  }, [current, busy, cause, note, qIndex, detail]);

  // 键盘流转:1=错 2=对 3=半对,Enter=采纳预选;焦点在表单控件时不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, select, textarea, button")) return;
      if (!current || busy) return;
      if (e.key === "1") void doConfirm("wrong");
      if (e.key === "2") void doConfirm("correct");
      if (e.key === "3") void doConfirm("partial");
      if (e.key === "Enter" && current.recognized_result) void doConfirm(current.recognized_result);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, busy, doConfirm]);

  return (
    <div className="review-wrap">
      <PaperQueue
        papers={papers}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); void loadDetail(id); }}
        onUpload={() => setUploadOpen(true)}
      />
      <div className="review-detail">
        {!detail && <div className="chat-empty">左侧选择一份试卷,或上传新试卷。</div>}
        {detail?.status === "processing" && (
          <div className="chat-empty">处理中——渲染页图与 VLM 识别,共 {detail.page_count} 页……</div>
        )}
        {detail?.status === "failed" && (
          <div className="fail-box">
            <div>处理失败:{detail.error}</div>
            <button className="primary" onClick={() => {
              void retryPaper(detail.id).then(() => {
                setDetail({ ...detail, status: "processing", error: null });
                void loadPapers();
              });
            }}>重试</button>
          </div>
        )}
        {detail && current && detail.status !== "processing" && (
          <>
            <div className="rd-head">
              <span className="label">第 {current.seq} 题 · 共 {detail.questions.length} 题</span>
              <span className="src">《{detail.title}》第 {current.page_no} 页
                {current.recognized_result ? ` · VLM 预识别为「${
                  { wrong: "错", correct: "对", partial: "半对" }[current.recognized_result] }」` : ""}
                {current.confirmed_result ? " · 已确认" : ""}
              </span>
              {current.page_no <= detail.page_count && (
                <button className="ghost" onClick={() => {
                  void reRecognizePaper(detail.id, current.page_no).then(() => {
                    setDetail({ ...detail, status: "processing" });
                    void loadPapers();
                  });
                }}>重识别本页</button>
              )}
            </div>
            <div className="qnav">
              {detail.questions.map((q, i) => (
                <button key={q.id} className={i === qIndex ? "on" : ""}
                        data-confirmed={q.confirmed_result ?? ""}
                        onClick={(e) => { e.currentTarget.blur(); setQIndex(i); }}>{q.seq}</button>
              ))}
            </div>
            <QuestionCard question={current} />
            <div className="verdict">
              <span className="tip">这题</span>
              {/* blur：点击后焦点回到 body，键盘流转不被按钮拦截 */}
              <button className="w" onClick={(e) => { e.currentTarget.blur(); void doConfirm("wrong"); }} disabled={busy}>✗ 错</button>
              <button className="r" onClick={(e) => { e.currentTarget.blur(); void doConfirm("correct"); }} disabled={busy}>✓ 对</button>
              <button className="h" onClick={(e) => { e.currentTarget.blur(); void doConfirm("partial"); }} disabled={busy}>½ 半对</button>
              <select aria-label="错因" value={cause} onChange={(e) => setCause(e.target.value)}>
                <option value="">错因(可选)</option>
                {CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder="备注,如「竖式对位错」" />
              {!current.matched_item_id && (
                <button className="ghost" onClick={() => setMatchOpen(true)}>待匹配 · 选择题库条目</button>
              )}
            </div>
            <div className="keyhint">快捷键:1 做错 · 2 做对 · 3 半对 · Enter 采纳预选并下一条</div>
            {matchOpen && (
              <MatchPicker question={current} onMatched={(q) => {
                setDetail((d) => d && ({ ...d, questions: d.questions.map((x, i) => i === qIndex ? q : x) }));
                setMatchOpen(false);
              }} />
            )}
          </>
        )}
      </div>
      {uploadOpen && (
        <UploadDialog
          children={kids}
          onClose={() => setUploadOpen(false)}
          onDone={(p) => {
            setUploadOpen(false);
            setSelectedId(p.id);
            void loadPapers();
            void loadDetail(p.id);
          }}
        />
      )}
    </div>
  );
}
```

`frontend/src/components/Rail.tsx` 顶部按钮区改为(加 props):

```tsx
interface RailProps {
  activeView: "chat" | "review";
  onSelect: (view: "chat" | "review") => void;
}

export function Rail({ activeView, onSelect }: RailProps) {
  return (
    <nav className="rail">
      {/* …brand 不变… */}
      <div className="nav">
        <button className={activeView === "chat" ? "active" : ""} onClick={() => onSelect("chat")}>
          <span className="dot"></span><span className="txt">聊天</span>
        </button>
        <button className={activeView === "review" ? "active" : ""} onClick={() => onSelect("review")}>
          <span className="dot"></span><span className="txt">复核</span>
        </button>
        {/* 统计/资料库/用量 保持 disabled 不变 */}
      </div>
      {/* …rail-foot 不变… */}
    </nav>
  );
}
```

`frontend/src/App.tsx` 改为视图切换(聊天视图保留会话侧栏/模型下拉;复核视图顶栏换文案):

```tsx
export function App() {
  const [kid, setKid] = useState("小宝");
  const [view, setView] = useState<"chat" | "review">("chat");
  const chat = useChat();
  return (
    <div className="app">
      <Rail activeView={view} onSelect={setView} />
      {view === "chat" && (
        <SessionsSidebar
          sessions={chat.sessions} activeId={chat.activeSessionId}
          onSelect={(id) => void chat.selectSession(id)} onNew={chat.newChat} />
      )}
      <main>
        <div className="topbar">
          <div>
            <span className="date">{today()}</span>
            <h1>{view === "chat" ? "聊天" : "复核"}</h1>
          </div>
          {view === "chat" ? (
            <>
              <span className="hint">问孩子学习情况，或找题、看讲解</span>
              <ModelPicker models={chat.models} value={chat.model} onChange={chat.selectModel} />
              <div className="kid-switch">
                {["小宝", "朵朵"].map((k) => (
                  <button key={k} className={kid === k ? "on" : ""} onClick={() => setKid(k)}>{k}</button>
                ))}
              </div>
            </>
          ) : (
            <span className="hint">确认试卷对错与题库匹配</span>
          )}
        </div>
        {view === "chat"
          ? <ChatView messages={chat.messages} streaming={chat.streaming} onSend={chat.send} />
          : <ReviewView />}
      </main>
    </div>
  );
}
```

`frontend/src/theme.css` 追加(复用既有令牌,不引入新色):

```css
/* ---------- 复核视图 ---------- */
.review-wrap { flex: 1; display: flex; min-height: 0; }
.papers-queue {
  width: 240px; flex-shrink: 0; border-right: 1px solid var(--hairline);
  display: flex; flex-direction: column; gap: 10px; padding: 20px 12px 14px;
}
.pq-head { display: flex; align-items: center; justify-content: space-between; padding: 0 8px; }
.pq-head .label { font-size: 11px; color: var(--pencil); letter-spacing: .08em; }
.pq-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.paper-item { border: 0; background: transparent; border-radius: 8px; padding: 8px 10px;
  text-align: left; position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.paper-item:hover { background: rgba(255,255,255,.6); }
.paper-item.active { background: var(--card); box-shadow: 0 1px 3px rgba(43,43,38,.08); }
.paper-item.active::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px;
  width: 2.5px; background: var(--redpen); border-radius: 2px; }
.paper-item .t { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.paper-item .m { font-size: 11px; color: var(--pencil); font-family: var(--mono); display: flex; gap: 8px; }
.paper-item .m .status.processing { color: var(--amber); }
.paper-item .m .status.done { color: var(--teal); }
.paper-item .m .status.failed { color: var(--redpen); }
.review-detail { flex: 1; min-width: 0; padding: 20px 40px 24px; display: flex; flex-direction: column;
  gap: 12px; overflow-y: auto; }
.rd-head { display: flex; align-items: baseline; gap: 14px; }
.rd-head .label { font-family: var(--serif); font-weight: 700; font-size: 17px; }
.rd-head .src { font-size: 12.5px; color: var(--pencil); }
.qnav { display: flex; flex-wrap: wrap; gap: 6px; }
.qnav button { width: 28px; height: 28px; border: 1px solid var(--hairline); border-radius: 8px;
  background: var(--card); font-size: 12.5px; color: var(--pencil); font-family: var(--mono); }
.qnav button.on { border-color: var(--redpen); color: var(--redpen); font-weight: 600; }
.qnav button[data-confirmed="wrong"] { border-color: var(--redpen); color: var(--redpen); }
.qnav button[data-confirmed="correct"] { border-color: var(--teal); color: var(--teal); }
.qnav button[data-confirmed="partial"] { border-color: var(--amber); color: var(--amber); }
.qcard-paper { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.qcard-paper .pane { background: var(--card); border: 1px solid var(--hairline); border-radius: 12px;
  padding: 14px 16px; min-height: 120px; }
.qcard-paper h3 { font-size: 12.5px; color: var(--pencil); font-weight: 500; margin-bottom: 8px; }
.crop-box img { max-width: 100%; border-radius: 6px; border: 1px solid var(--hairline); }
.qcard-paper .stem { font-size: 15px; margin-bottom: 6px; }
.qcard-paper .muted { color: var(--pencil); font-size: 13px; }
.qcard-paper .match-line { font-size: 13px; color: var(--teal); margin-top: 6px; }
.verdict { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.verdict .tip { font-family: var(--serif); font-weight: 600; }
.verdict button.w, .verdict button.r, .verdict button.h {
  border: 1.8px solid; border-radius: 10px; padding: 8px 18px; font-size: 14px; background: var(--card); }
.verdict button.w { border-color: var(--redpen); color: var(--redpen); }
.verdict button.r { border-color: var(--teal); color: var(--teal); }
.verdict button.h { border-color: var(--amber); color: var(--amber); }
.verdict select, .verdict input { border: 1px solid var(--hairline); border-radius: 10px;
  background: var(--card); padding: 8px 12px; font-size: 13.5px; font-family: inherit; }
.verdict input { flex: 1; min-width: 180px; outline: none; }
.keyhint { font-size: 12px; color: var(--pencil); }
.fail-box { display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
  color: var(--redpen); background: var(--redpen-soft); border-radius: 12px; padding: 16px 20px; }
.fail-box button { border: 0; border-radius: 8px; background: var(--redpen); color: #fff; padding: 6px 16px; }
button.ghost { border: 1px dashed #D8D4C9; background: transparent; color: var(--pencil);
  border-radius: 999px; padding: 4px 12px; font-size: 12.5px; }
button.ghost:hover { color: var(--redpen); border-color: var(--redpen); }
.dialog-mask { position: fixed; inset: 0; background: rgba(43,43,38,.35); display: grid;
  place-items: center; z-index: 50; }
.dialog { background: var(--paper); border: 1px solid var(--hairline); border-radius: 14px;
  padding: 22px 26px; width: 440px; max-width: 92vw; display: flex; flex-direction: column; gap: 12px; }
.dialog h2 { font-family: var(--serif); font-size: 18px; }
.dialog label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--pencil); }
.dialog select, .dialog input[type="text"], .dialog input:not([type="file"]) {
  border: 1px solid var(--hairline); border-radius: 8px; padding: 8px 10px;
  font-size: 14px; font-family: inherit; background: var(--card); }
.file-list { font-size: 12.5px; color: var(--pencil); }
.form-error { color: var(--redpen); font-size: 13px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; }
.dialog-actions button { border: 1px solid var(--hairline); border-radius: 8px;
  background: var(--card); padding: 7px 18px; font-size: 14px; }
.dialog-actions button.primary { border: 0; background: var(--redpen); color: #fff; }
.cand-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
.cand { border: 1px solid var(--hairline); border-radius: 10px; background: var(--card);
  padding: 10px 12px; text-align: left; display: flex; flex-direction: column; gap: 3px; }
.cand .t { font-size: 13.5px; }
.cand .m { font-size: 12px; color: var(--pencil); font-family: var(--mono); }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd frontend && npx vitest run`
Expected: 全部 PASS(既有 34 用例 + 新增 5 用例)。

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat(frontend): 复核视图——试卷队列/上传弹层/键盘确认流/匹配浮层"
```

---

## Task 16: E2E——合成试卷 fixtures + 全链路 spec

**Files:**

- Create: `e2e/fixtures/make_paper.py`
- Create: `e2e/specs/paper-pipeline.spec.ts`

- [ ] **Step 0: 真库应用 migration(E2E 用真库 kb,需先上表结构)**

```bash
cd pipeline && uv run python -m kb.cli migrate
```

Expected: `已执行 migration: 0011_papers.sql`(或后续重跑显示无新增)。

- [ ] **Step 1: 生成合成试卷的 fixture 脚本**

```python
"""生成 E2E 合成试卷:3 张 PNG(每张一题),第 1 题红 ✗、第 2 题红 ✓、第 3 题无痕迹。

用法(在 e2e/ 目录): uv run --project ../pipeline python fixtures/make_paper.py <out_dir>
依赖 pipeline 的 pymupdf(内置 CJK 字体 china-s)。
"""
import sys
from pathlib import Path

import pymupdf as fitz

QUESTIONS = [
    ("1. 246 × 37 =", "wrong"),    # 红 ✗
    ("2. 135 ÷ 5 =", "correct"),   # 红 ✓
    ("3. 507 − 348 =", None),      # 无痕迹
]


def make(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    for i, (text, mark) in enumerate(QUESTIONS):
        page = doc.new_page(width=595, height=420)
        page.insert_text((60, 80), "三年级数学期中练习", fontname="china-s", fontsize=14)
        page.insert_text((60, 160), text, fontname="china-s", fontsize=16)
        # 作答
        page.insert_text((240, 160), "9102" if i == 0 else "27" if i == 1 else "159",
                         fontname="china-s", fontsize=16, color=(0, 0, 0.6))
        if mark == "wrong":  # 红 ✗(两条交叉线)
            page.draw_line(fitz.Point(390, 140), fitz.Point(420, 172), color=(0.9, 0, 0), width=2.5)
            page.draw_line(fitz.Point(420, 140), fitz.Point(390, 172), color=(0.9, 0, 0), width=2.5)
        if mark == "correct":  # 红 ✓
            page.draw_line(fitz.Point(390, 158), fitz.Point(404, 172), color=(0.9, 0, 0), width=2.5)
            page.draw_line(fitz.Point(404, 172), fitz.Point(426, 138), color=(0.9, 0, 0), width=2.5)
        pix = page.get_pixmap(dpi=150)
        pix.save(str(out_dir / f"paper{i + 1}.png"))
    doc.close()


if __name__ == "__main__":
    make(Path(sys.argv[1]))
```

验证脚本可跑:`cd e2e && uv run --project ../pipeline python fixtures/make_paper.py /tmp/kb-paper-fixture && ls /tmp/kb-paper-fixture`
Expected: 3 个 PNG。

- [ ] **Step 2: 写 E2E spec**

```ts
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

/** 试卷管线全链路 E2E:上传(3 图) -> VLM 拆题 -> 匹配 -> 键盘确认 -> attempts 落库。
    前置:e2e/playwright.config.ts 的三服务编排(复用/拉起)+ ollama + 远端 VLM。
    数据写真库 kb(真实计量);测试结束清理种子题库与本次试卷。 */

const RUN = Date.now().toString(36);
const TITLE = `E2E-${RUN}-期中卷`;
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const Q2_TEXT = "135 ÷ 5 =";  // 与种子 item 同文(自动匹配用例)

test.describe.configure({ mode: "serial" });

const pool = new pg.Pool({ connectionString: DB_URL });

let paperId = "";
let childId = "";
let seedDocId = "";
let seedItemId = "";

test.beforeAll(async () => {
  // 1) 生成 3 张合成试卷图(借 pipeline 的 pymupdf)
  const e2eDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const outDir = path.join(tmpdir(), `kb-e2e-paper-${RUN}`);
  execSync(`uv run --project ../pipeline python fixtures/make_paper.py ${outDir}`, { cwd: e2eDir });
  // 2) 种子孩子 + 同文题库 item(bge-m3 embedding 直插 chunks)
  const { rows: [child] } = await pool.query(
    `INSERT INTO children (name, grade) VALUES ($1,'三年级') RETURNING id::text`, [`E2E-${RUN}-小宝`]);
  childId = child.id;
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ($1,'数学','workbook',$2) RETURNING id::text`,
    [`E2E-${RUN}-数学书`, `/tmp/e2e-${RUN}.pdf`]);
  seedDocId = doc.id;
  const { rows: [item] } = await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, qc_status, subject)
     VALUES ($1,'exercise','1',$2,'approved','数学') RETURNING id::text`, [seedDocId, Q2_TEXT]);
  seedItemId = item.id;
  const emb = await (await fetch("http://127.0.0.1:11434/v1/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: Q2_TEXT }),
  })).json() as { data: { embedding: number[] }[] };
  await pool.query(
    `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding) VALUES
      ($1,$2,$3,'{"subject":"数学","label":"1","chapter":null,"doc_title":null}'::jsonb,$4::vector)`,
    [seedItemId, seedDocId, Q2_TEXT, `[${emb.data[0].embedding.join(",")}]`]);
  // 存 outDir 供测试体用
  (globalThis as { __paperDir?: string }).__paperDir = outDir;
});

test.afterAll(async () => {
  // 清理:本次试卷(级联 paper_questions/attempts)+ 种子题库(item 被 attempts 引用,先删 attempts)
  if (paperId) await pool.query("DELETE FROM papers WHERE id=$1", [paperId]);
  if (seedDocId) {
    await pool.query("DELETE FROM attempts WHERE item_id=$1", [seedItemId]);
    await pool.query("DELETE FROM documents WHERE id=$1", [seedDocId]);  // 级联 items/chunks
  }
  await pool.end();
});

function paperDir(): string {
  return (globalThis as { __paperDir?: string }).__paperDir!;
}

async function waitPaperStatus(page: Page, status: string, timeout = 300_000) {
  await expect.poll(async () => {
    const r = await page.request.get(`/api/papers/${paperId}`);
    return r.ok() ? ((await r.json()) as { status: string }).status : "";
  }, { timeout }).toBe(status);
}

test("t1 上传 3 图 -> processing -> ready_for_review,拆题与预识别正确", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: "上传试卷" }).click();
  await page.getByLabel("孩子").selectOption({ label: `E2E-${RUN}-小宝` });
  await page.getByLabel("标题").fill(TITLE);
  await page.getByLabel("科目").selectOption("数学");
  const files = readdirSync(paperDir()).filter((f) => f.endsWith(".png")).sort()
    .map((f) => path.join(paperDir(), f));
  await page.getByLabel("文件").setInputFiles(files);
  await page.getByRole("button", { name: "提交" }).click();
  // 列表出现新卷(用队列项定位,避免与详情区《》标题歧义)并选中
  const queueItem = page.getByRole("button", { name: TITLE });
  await expect(queueItem).toBeVisible({ timeout: 30_000 });
  await queueItem.click();
  const detail = (await (await page.request.get(`/api/papers?child_id=${childId}`)).json()) as {
    papers: { id: string; title: string }[];
  };
  paperId = detail.papers.find((p) => p.title === TITLE)!.id;
  await waitPaperStatus(page, "ready_for_review");
  await page.reload();
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: TITLE }).click();

  // 拆题:3 题,顺序与识别断言(痕迹识别允许 null 降级,题干必须识别出)
  const detailJson = (await (await page.request.get(`/api/papers/${paperId}`)).json()) as {
    questions: { seq: number; content_md: string; recognized_result: string | null }[];
  };
  expect(detailJson.questions.length).toBe(3);
  expect(detailJson.questions[0].content_md).toContain("246");
  expect(detailJson.questions[1].content_md).toContain("135");
  expect(["wrong", null]).toContain(detailJson.questions[0].recognized_result);
  expect(["correct", null]).toContain(detailJson.questions[1].recognized_result);
  expect(detailJson.questions[2].recognized_result).toBeNull();
  // VLM 计量挂 paper_id
  const meter = await pool.query(
    "SELECT count(*)::int AS n FROM llm_calls WHERE paper_id=$1 AND purpose='paper_vlm' AND modality='image'",
    [paperId]);
  expect(meter.rows[0].n).toBeGreaterThanOrEqual(3);
});

test("t2 自动匹配:同文题已关联(matched_item_id = 种子)", async () => {
  const { rows } = await pool.query(
    `SELECT matched_item_id::text, match_score FROM paper_questions
     WHERE paper_id=$1 AND content_md LIKE '%135%'`, [paperId]);
  expect(rows[0].matched_item_id).toBe(seedItemId);
  expect(rows[0].match_score).toBeGreaterThan(0.88);
});

test("t3 键盘确认 3 题 -> attempts 逐字段 -> done", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: TITLE }).click();
  await expect(page.locator(".qnav button")).toHaveCount(3);
  // q1: 错 + 错因(选完错因后点头部区域移开焦点,否则键盘会被输入控件拦截)
  await page.locator('select[aria-label="错因"]').selectOption("计算错");
  await page.locator(".rd-head").click();
  await page.keyboard.press("1");
  await expect(page.locator('.qnav button[data-confirmed="wrong"]').first()).toBeVisible();
  // q2: 对(Enter 采纳预识别 correct;若预识别为 null 则按 2)
  const q2recog = await page.locator(".rd-head .src").textContent();
  await page.keyboard.press(q2recog?.includes("对") && !q2recog.includes("半对") ? "Enter" : "2");
  await expect(page.locator('.qnav button[data-confirmed="correct"]').first()).toBeVisible();
  // q3: 对(无预识别,按 2)
  await page.keyboard.press("2");
  await expect(page.locator('.qnav button[data-confirmed="correct"]')).toHaveCount(2);
  // 状态 done + attempts 逐字段
  await expect.poll(async () =>
    ((await (await page.request.get(`/api/papers/${paperId}`)).json()) as { status: string }).status
  ).toBe("done");
  const { rows: attempts } = await pool.query(
    `SELECT a.result, a.error_cause, a.note, a.item_id::text, a.paper_question_id::text
     FROM attempts a WHERE a.paper_question_id IN
       (SELECT id FROM paper_questions WHERE paper_id=$1)
     ORDER BY a.created_at`, [paperId]);
  expect(attempts).toHaveLength(3);
  expect(attempts[0]).toMatchObject({ result: "wrong", error_cause: "计算错" });
  expect(attempts[1].result).toBe("correct");
  expect(attempts[1].item_id).toBe(seedItemId);  // 自动匹配同步进 attempt
  expect(attempts[2]).toMatchObject({ result: "correct", item_id: null });
  expect(attempts.every((a) => a.paper_question_id)).toBe(true);
});

test("t4 改判 UPDATE 不追加;PATCH 元数据", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: TITLE }).click();
  await expect(page.locator(".qnav button")).toHaveCount(3);
  await page.locator(".qnav button").nth(0).click();
  await page.locator('button:has-text("半对")').first().click();
  // 确认后 attempts 的 q1 行更新为 partial(轮询 DB)
  await expect.poll(async () => {
    const { rows } = await pool.query(
      `SELECT array_agg(result ORDER BY created_at) AS results
       FROM attempts WHERE paper_question_id IN (SELECT id FROM paper_questions WHERE paper_id=$1)`,
      [paperId]);
    return rows[0].results as string[];
  }).toContain("partial");
  const { rows: [{ n }] } = await pool.query(
    `SELECT count(*)::int AS n
     FROM attempts WHERE paper_question_id IN (SELECT id FROM paper_questions WHERE paper_id=$1)`,
    [paperId]);
  expect(n).toBe(3);  // 改判没加行
  // 元数据修改
  const r = await page.request.patch(`/api/papers/${paperId}`, {
    data: { title: `${TITLE}-改` },
  });
  expect(r.ok()).toBe(true);
});
```

- [ ] **Step 3: 跑 E2E(全链路,慢——真 VLM)**

Run: `cd e2e && npx playwright test specs/paper-pipeline.spec.ts`
Expected: 4 passed(首跑观察 VLM 对合成试卷的识别质量;若痕迹识别不稳,按测试内的降级断言通过,并记录到 spec 风险节)。

- [ ] **Step 4: 全套件回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test && npm run build`
Run: `cd frontend && npm test && npm run build`
Run: `cd e2e && npx playwright test`
Expected: 四层全绿(含 Phase 1.5 的 chat-session spec)。

- [ ] **Step 5: Commit**

```bash
git add e2e/fixtures e2e/specs/paper-pipeline.spec.ts
git commit -m "test(e2e): 试卷管线全链路——合成试卷上传/VLM/匹配/键盘确认/attempts 断言"
```

---

## 完成核对(spec 验收标准)

- [ ] 拍 3 张照片顺序上传 → 合成 PDF → 复核视图出现,题目拆分与预识别正确(t1)
- [ ] 键盘 1/2/3 + Enter 连续确认,attempts 与 paper_questions 逐字段正确(t3)
- [ ] 同题已在题库 → 自动关联;不满足阈值 → 人工候选选择(t2 + 单测)
- [ ] 改判与元数据修改即时生效;页级重识别重置该页;failed 可重试(t4 + 单测)
- [ ] 四层测试绿:pipeline + backend + frontend + Playwright E2E(Task 16 Step 4)

# Pipeline Trajectory 日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 pipeline 的 OCR/VLM 调用、质检、用户编辑、structure、向量化等操作以 run+event 的 trajectory 形式完整记录（DB 表 + JSONL 镜像），支持 verbose/simple/off 三级配置，并提供 by 文档 / by 页的查询 API 与前端展示。

**Architecture:** 新 migration 建 `pipeline_events` 表（事实来源，删文档级联删）；pipeline 侧新增 `kb/traj.py` Recorder 统一埋点（级别裁剪 → 写库 → 追加 JSONL 镜像，失败不阻塞主链路）；用户编辑由 backend `review.ts` 直写 `user_edit` 事件；查询走 backend 新路由 `trajectory.ts` 直读 DB；前端复核页加「处理日志」tab 与「本页日志」面板。

**Tech Stack:** Python 3 + psycopg 3（pipeline）、FastAPI internal API、Hono + pg + vitest（backend）、React + 原生 CSS 变量主题（frontend，无 Tailwind）、Playwright（e2e）。

**Spec:** `docs/superpowers/specs/2026-09-07-pipeline-trajectory-design.md`（commit fe4881b）

**关键约定（探索确认的代码事实，实施时不要重新发明）：**

- pipeline DB 连接 `autocommit=True`，业务代码直接 `with conn.cursor() as cur:` 执行 SQL；uuid 列传 `str(...)`；JSONB 用 `psycopg.types.json.Jsonb`。
- 现有迁移到 `0016_library_index_controls.sql`，新迁移为 `0017_pipeline_events.sql`，会被 `migrate(conn)` 自动按文件名序执行；backend 测试的 `resetDbForTest` 也重放同一目录。
- storage 镜像布局是 `storage/<doc_id>/{pages,chapters,media}`（**没有** `docs/` 层），JSONL 落 `storage/<doc_id>/trajectory/<run_id>.jsonl`。
- `record_llm_call(conn, doc_id, purpose, model, usage, paper_id=None, modality=None)` 在 `pipeline/kb/metering.py`，所有 LLM 调用必经；现有调用点多数拿不到 page_id（仅 parse.py 循环内有）。
- pipeline pytest 用 `conn` fixture（`pipeline/tests/conftest.py`，已迁移全部表，需 `KB_TEST_DATABASE_URL`）；Config 手工构造（`Config(database_url=..., storage_dir=tmp_path/"storage", vision_base_url=..., vision_api_key=..., vision_model=...)`，其余走默认值）。
- backend 是 **vitest**（不是 jest）；路由工厂模式 `xxxRoutes(pool, deps) -> Hono`，测试里 `new Hono()` 挂路由后 `app.request(...)` 内存打，无需端口；非法 UUID 错误码 `22P02` 返 422。
- frontend 无组件库：语义 className + 原生 button + `<details>`；API client 在 `frontend/src/api/review.ts` 同款 `req<T>` 封装。

---

### Task 1: migration 0017 `pipeline_events` 表

**Files:**
- Create: `pipeline/kb/migrations/0017_pipeline_events.sql`
- Test: `pipeline/tests/test_traj_migration.py`

- [ ] **Step 1: 写失败测试**

```python
# pipeline/tests/test_traj_migration.py
"""pipeline_events 表：migration 建表 + 删文档级联删事件。"""
import uuid


def _mk_doc(cur, title="traj 测试"):
    doc_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
        (doc_id, title, f"/tmp/{doc_id}.pdf"),
    )
    return doc_id


def test_pipeline_events_table_exists(conn):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
        cur.execute(
            """INSERT INTO pipeline_events (run_id, document_id, stage, event_type, summary)
               VALUES (%s,%s,'parse','stage_start','测试事件')""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            "SELECT stage, event_type, status, actor FROM pipeline_events WHERE document_id=%s",
            (doc_id,),
        )
        assert cur.fetchone() == ("parse", "stage_start", "ok", "pipeline")


def test_pipeline_events_cascade_on_document_delete(conn):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
        cur.execute(
            """INSERT INTO pipeline_events (run_id, document_id, stage, event_type, summary)
               VALUES (%s,%s,'parse','stage_start','测试事件')""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute("DELETE FROM documents WHERE id=%s", (doc_id,))
        cur.execute("SELECT count(*) FROM pipeline_events WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_traj_migration.py -v`
Expected: FAIL，`relation "pipeline_events" does not exist`

- [ ] **Step 3: 写 migration**

```sql
-- pipeline/kb/migrations/0017_pipeline_events.sql
-- pipeline trajectory 事件日志：run + event 模型；删文档/删页级联清。
CREATE TABLE pipeline_events (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE SET NULL,
    stage TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload JSONB,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'skipped')),
    actor TEXT NOT NULL DEFAULT 'pipeline',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_events_doc_ts ON pipeline_events (document_id, created_at);
CREATE INDEX pipeline_events_doc_page_ts ON pipeline_events (document_id, page_id, created_at);
CREATE INDEX pipeline_events_run ON pipeline_events (run_id);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_traj_migration.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/migrations/0017_pipeline_events.sql pipeline/tests/test_traj_migration.py
git commit -m "feat(pipeline): pipeline_events trajectory 事件表 migration"
```

---

### Task 2: `KB_TRAJECTORY_LEVEL` 配置项

**Files:**
- Modify: `pipeline/kb/config.py`
- Modify: `pipeline/.env.example`
- Test: `pipeline/tests/test_config.py`（若无则新建）

- [ ] **Step 1: 写失败测试**

```python
# pipeline/tests/test_config.py
"""KB_TRAJECTORY_LEVEL 配置加载。"""
from kb.config import load_config


def test_trajectory_level_default_simple(monkeypatch, tmp_path):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    monkeypatch.delenv("KB_TRAJECTORY_LEVEL", raising=False)
    cfg = load_config(env_path=tmp_path / "nonexistent.env")
    assert cfg.trajectory_level == "simple"


def test_trajectory_level_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    monkeypatch.setenv("KB_TRAJECTORY_LEVEL", "verbose")
    cfg = load_config(env_path=tmp_path / "nonexistent.env")
    assert cfg.trajectory_level == "verbose"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_config.py -v`
Expected: FAIL，`AttributeError: 'Config' object has no attribute 'trajectory_level'`（或 load_config 报错）

- [ ] **Step 3: 实现**

`pipeline/kb/config.py` 的 `Config` dataclass 加字段（放在 `embed_model` 之后）：

```python
    trajectory_level: str = "simple"  # KB_TRAJECTORY_LEVEL: verbose|simple|off
```

`load_config()` 返回 `Config(...)` 的调用处加一行：

```python
        trajectory_level=os.environ.get("KB_TRAJECTORY_LEVEL", "simple"),
```

`pipeline/.env.example` 末尾追加：

```dotenv
# trajectory 处理日志级别：verbose 记录完整 prompt/输出，simple 只记摘要，off 不记录
KB_TRAJECTORY_LEVEL=simple
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_config.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/config.py pipeline/.env.example pipeline/tests/test_config.py
git commit -m "feat(pipeline): KB_TRAJECTORY_LEVEL 配置项（verbose|simple|off，默认 simple）"
```

---

### Task 3: `kb/traj.py` Recorder

**Files:**
- Create: `pipeline/kb/traj.py`
- Test: `pipeline/tests/test_traj.py`

- [ ] **Step 1: 写失败测试**

```python
# pipeline/tests/test_traj.py
"""Recorder：级别裁剪、JSONL 镜像、记录失败不阻塞主链路。"""
import json
import uuid

import pytest

from kb.config import Config
from kb.traj import Recorder


def _cfg(tmp_path, level):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


def _mk_doc(cur):
    doc_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
        (doc_id, "traj", f"/tmp/{doc_id}.pdf"),
    )
    return doc_id


def _events(conn, doc_id):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT stage, event_type, summary, payload, status FROM pipeline_events
               WHERE document_id=%s ORDER BY id""",
            (doc_id,),
        )
        return cur.fetchall()


def test_verbose_writes_payload_and_jsonl(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "verbose"), doc_id)
    rec.llm_call("parse", "transcribe qwen3:4b", model="qwen3:4b",
                 usage=(100, 50), prompt="完整提示词", output="完整输出")
    rows = _events(conn, doc_id)
    assert len(rows) == 1
    assert rows[0][3] == {"prompt": "完整提示词", "output": "完整输出"}
    mirror = tmp_path / "storage" / doc_id / "trajectory" / f"{rec.run_id}.jsonl"
    lines = mirror.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["stage"] == "parse"


def test_simple_strips_payload(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "simple"), doc_id)
    rec.llm_call("parse", "transcribe qwen3:4b", model="qwen3:4b",
                 usage=(100, 50), prompt="完整提示词", output="完整输出")
    rows = _events(conn, doc_id)
    assert len(rows) == 1
    assert rows[0][2] == "transcribe qwen3:4b"  # summary 保留
    assert rows[0][3] is None                   # payload 被裁剪


def test_off_is_noop(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "off"), doc_id)
    rec.start("parse", "开始解析")
    rec.llm_call("parse", "x", model="m")
    assert _events(conn, doc_id) == []
    assert not (tmp_path / "storage" / doc_id / "trajectory").exists()


def test_db_failure_does_not_raise(tmp_path):
    class BadConn:
        def cursor(self):
            raise RuntimeError("db down")
    rec = Recorder(BadConn(), _cfg(tmp_path, "simple"), str(uuid.uuid4()))
    rec.start("parse", "开始解析")  # 不抛异常
    rec.error("parse", "失败")      # 不抛异常


def test_start_end_duration(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "simple"), doc_id)
    t0 = rec.start("parse", "开始")
    rec.end("parse", "结束", started=t0)
    rows = _events(conn, doc_id)
    assert [r[1] for r in rows] == ["stage_start", "stage_end"]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT duration_ms FROM pipeline_events WHERE document_id=%s AND event_type='stage_end'",
            (doc_id,),
        )
        assert cur.fetchone()[0] is not None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_traj.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'kb.traj'`

- [ ] **Step 3: 实现 `pipeline/kb/traj.py`**

```python
"""Trajectory 事件记录：pipeline_events 表 + JSONL 镜像；记录失败只警告不阻塞主链路。

级别：verbose 记完整 payload（prompt/输出/diff），simple 只记摘要与元信息，off 不记。
JSONL 镜像在 storage/<doc_id>/trajectory/<run_id>.jsonl，只写归档，DB 是事实来源。
"""
from __future__ import annotations

import json
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from psycopg.types.json import Jsonb


def new_run_id() -> str:
    return str(uuid.uuid4())


class Recorder:
    """一次操作（run）的事件记录器；level=off 时全部方法为 no-op。"""

    def __init__(self, conn, cfg, document_id: str, run_id: str | None = None,
                 actor: str = "pipeline"):
        self._conn = conn
        self._doc_id = str(document_id)
        self.run_id = run_id or new_run_id()
        self._actor = actor
        self._level = getattr(cfg, "trajectory_level", "simple") if cfg else "simple"
        self._storage_dir = Path(cfg.storage_dir) if cfg else None

    @property
    def enabled(self) -> bool:
        return self._level != "off"

    def start(self, stage: str, summary: str, *, page_id=None, payload=None) -> float:
        """阶段开始；返回 monotonic 起点供 end() 算耗时。"""
        self._emit(stage, "stage_start", summary, page_id=page_id, payload=payload)
        return time.monotonic()

    def end(self, stage: str, summary: str, *, started: float | None = None,
            page_id=None, item_id=None, payload=None, status: str = "ok") -> None:
        duration_ms = int((time.monotonic() - started) * 1000) if started else None
        self._emit(stage, "stage_end", summary, page_id=page_id, item_id=item_id,
                   payload=payload, duration_ms=duration_ms, status=status)

    def llm_call(self, stage: str, summary: str, *, page_id=None, item_id=None,
                 model=None, usage=(None, None), duration_ms=None,
                 prompt=None, output=None, status: str = "ok") -> None:
        payload = None
        if prompt is not None or output is not None:
            payload = {"prompt": prompt, "output": output}
        self._emit(stage, "llm_call", summary, page_id=page_id, item_id=item_id,
                   payload=payload, model=model, usage=usage,
                   duration_ms=duration_ms, status=status)

    def decision(self, stage: str, summary: str, *, page_id=None, item_id=None,
                 payload=None) -> None:
        """非 LLM 的关键决策/结果（如 approve 条数、向量化条数）。"""
        self._emit(stage, "decision", summary, page_id=page_id, item_id=item_id,
                   payload=payload)

    def error(self, stage: str, summary: str, *, page_id=None, exc=None) -> None:
        payload = {"traceback": traceback.format_exc()} if exc is not None else None
        self._emit(stage, "error", summary, page_id=page_id, payload=payload,
                   status="error")

    def _emit(self, stage, event_type, summary, *, page_id=None, item_id=None,
              payload=None, model=None, usage=(None, None), duration_ms=None,
              status="ok") -> None:
        if not self.enabled:
            return
        if self._level != "verbose":
            payload = None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO pipeline_events
                       (run_id, document_id, page_id, item_id, stage, event_type,
                        summary, payload, model, prompt_tokens, completion_tokens,
                        duration_ms, status, actor)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (self.run_id, self._doc_id,
                     str(page_id) if page_id else None,
                     str(item_id) if item_id else None,
                     stage, event_type, summary,
                     Jsonb(payload) if payload is not None else None,
                     model, usage[0], usage[1], duration_ms, status, self._actor),
                )
        except Exception as e:  # noqa: BLE001 - 记录失败不阻塞主链路
            print(f"[traj] 事件写库失败（忽略）: {e}")
            return
        self._mirror(stage, event_type, summary, page_id=page_id, item_id=item_id,
                     payload=payload, model=model, usage=usage,
                     duration_ms=duration_ms, status=status)

    def _mirror(self, stage, event_type, summary, **kw) -> None:
        if self._storage_dir is None:
            return
        try:
            path = (self._storage_dir / self._doc_id / "trajectory"
                    / f"{self.run_id}.jsonl")
            path.parent.mkdir(parents=True, exist_ok=True)
            line = {
                "run_id": self.run_id, "document_id": self._doc_id,
                "stage": stage, "event_type": event_type, "summary": summary,
                "actor": self._actor,
                "created_at": datetime.now(timezone.utc).isoformat(),
                **kw,
            }
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
        except Exception as e:  # noqa: BLE001 - 镜像失败不阻塞主链路
            print(f"[traj] JSONL 镜像写入失败（忽略）: {e}")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_traj.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/traj.py pipeline/tests/test_traj.py
git commit -m "feat(pipeline): traj Recorder——pipeline_events + JSONL 镜像，三级裁剪，失败不阻塞"
```

---

### Task 4: `metering.record_llm_call` 扩展 recorder 挂钩

**Files:**
- Modify: `pipeline/kb/metering.py`
- Test: `pipeline/tests/test_traj.py`（追加）

- [ ] **Step 1: 追加失败测试**

```python
# 追加到 pipeline/tests/test_traj.py
def test_record_llm_call_forwards_to_recorder(conn, tmp_path):
    from kb.metering import record_llm_call
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "verbose"), doc_id)
    record_llm_call(conn, doc_id, "transcribe", "qwen3:4b", (10, 20),
                    recorder=rec, stage="parse", page_id=None,
                    duration_ms=123, prompt="p", output="o")
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM llm_calls WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 1  # 原有计量不受影响
    rows = _events(conn, doc_id)
    assert len(rows) == 1
    assert rows[0][0] == "parse" and rows[0][1] == "llm_call"
    assert rows[0][3] == {"prompt": "p", "output": "o"}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT model, prompt_tokens, completion_tokens, duration_ms"
            " FROM pipeline_events WHERE document_id=%s", (doc_id,))
        assert cur.fetchone() == ("qwen3:4b", 10, 20, 123)


def test_record_llm_call_without_recorder_unchanged(conn):
    from kb.metering import record_llm_call
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    record_llm_call(conn, doc_id, "transcribe", "qwen3:4b", (1, 2))
    assert _events(conn, doc_id) == []  # 不传 recorder 不产生事件
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_traj.py -v`
Expected: FAIL，`TypeError: record_llm_call() got an unexpected keyword argument 'recorder'`

- [ ] **Step 3: 修改 `pipeline/kb/metering.py` 的 `record_llm_call`**

完整替换该函数（`extract_usage` 不动）：

```python
def record_llm_call(conn, doc_id: str | None, purpose: str, model: str,
                    usage: tuple[int | None, int | None],
                    paper_id: str | None = None,
                    modality: str | None = None,
                    recorder=None, stage: str | None = None,
                    page_id: str | None = None,
                    duration_ms: int | None = None,
                    prompt: str | None = None,
                    output: str | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO llm_calls (document_id, paper_id, purpose, model, modality,
                                      prompt_tokens, completion_tokens)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (doc_id, paper_id, purpose, model, modality, usage[0], usage[1]),
        )
    if recorder is not None and doc_id is not None:
        recorder.llm_call(stage or purpose, f"{purpose} {model}",
                          page_id=page_id, model=model, usage=usage,
                          duration_ms=duration_ms, prompt=prompt, output=output)
```

- [ ] **Step 4: 跑测试确认通过（含既有计量测试回归）**

Run: `cd pipeline && uv run pytest tests/test_traj.py tests/test_metering.py -v`
Expected: 全部 passed（`record_llm_call` 新参数全是可选的，既有调用点不破坏）

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/metering.py pipeline/tests/test_traj.py
git commit -m "feat(pipeline): record_llm_call 挂钩 trajectory recorder（可选参数）"
```

---

### Task 5: ingest 链路埋点（pipeline.py / parse.py / qc.py / pagelvl.py / crosscheck.py）

**Files:**
- Modify: `pipeline/kb/pipeline.py`（ingest 编排，建 Recorder，阶段 start/end，透传）
- Modify: `pipeline/kb/parse.py`（run_parse 加 recorder 参数，两处 record_llm_call 透传 page_id/耗时/输入输出）
- Modify: `pipeline/kb/qc.py`（run_qc 加 recorder 参数透传给 auto_page_vlm）
- Modify: `pipeline/kb/pagelvl.py`（transcribe_page/auto_page_vlm 加 recorder 参数）
- Modify: `pipeline/kb/crosscheck.py`（run_llm_crosscheck 加 recorder 参数）
- Test: `pipeline/tests/test_traj_ingest.py`

注意：`run_layout` 无 LLM 调用，只需在 ingest 层包 stage_start/end。`render_document` 同理。

- [ ] **Step 1: 写失败测试**

```python
# pipeline/tests/test_traj_ingest.py
"""ingest 编排：run 级阶段事件 + parse 的 llm_call 事件带 page_id。"""
import uuid

import pymupdf
import pytest

from kb.config import Config
from kb.pipeline import ingest


class _FakeMessage:
    content = "转录内容"


class _FakeChoice:
    message = _FakeMessage()


class _FakeUsage:
    prompt_tokens = 10
    completion_tokens = 5


class _FakeResp:
    choices = [_FakeChoice()]
    usage = _FakeUsage()


class _FakeCompletions:
    def create(self, **kw):
        return _FakeResp()


class _FakeChat:
    completions = _FakeCompletions()


class FakeClient:
    chat = _FakeChat()


def _cfg(tmp_path, level="simple"):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


@pytest.fixture()
def pdf(tmp_path):
    p = tmp_path / "a.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(p)
    doc.close()
    return p


def test_ingest_records_stage_events(conn, tmp_path, pdf):
    cfg = _cfg(tmp_path)
    doc_id = ingest(conn, cfg, pdf, "traj 测试", client=FakeClient())
    with conn.cursor() as cur:
        cur.execute(
            """SELECT DISTINCT stage FROM pipeline_events
               WHERE document_id=%s AND event_type='stage_start'""",
            (doc_id,),
        )
        stages = {r[0] for r in cur.fetchall()}
    assert {"render", "layout", "parse", "qc", "crosscheck"} <= stages
    # 同一 run：所有事件 run_id 相同
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(DISTINCT run_id) FROM pipeline_events WHERE document_id=%s",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1


def test_ingest_off_records_nothing(conn, tmp_path, pdf):
    cfg = _cfg(tmp_path, level="off")
    doc_id = ingest(conn, cfg, pdf, "traj 测试", client=FakeClient())
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pipeline_events WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_traj_ingest.py -v`
Expected: FAIL——`pipeline_events` 无行（stages 集合为空）

- [ ] **Step 3: 修改 `pipeline/kb/pipeline.py`**

完整替换 `ingest()`（文件其余部分不动）：

```python
def ingest(conn, cfg: Config, pdf_path, title: str,
           subject: str | None = None, grade: str | None = None,
           doc_type: str = "workbook", client=None,
           start: int = 1, end: int | None = None) -> str:
    from kb.traj import Recorder

    doc_id = render_document(conn, cfg, pdf_path, title, subject, grade, doc_type,
                             start=start, end=end)
    rec = Recorder(conn, cfg, doc_id)
    rec.start("ingest", f"入库《{title}》", payload={
        "title": title, "pdf_path": str(pdf_path), "start": start, "end": end,
        "doc_type": doc_type, "subject": subject, "grade": grade,
    })
    t = rec.start("render", f"渲染 {doc_id} 页面")
    rec.end("render", "渲染完成", started=t)
    t = rec.start("layout", "版面切块")
    run_layout(conn, doc_id, analyzer=make_layout_analyzer(cfg))
    rec.end("layout", "版面切块完成", started=t)
    t = rec.start("parse", "区块转录")
    n_parsed = run_parse(conn, cfg, doc_id, client=client, recorder=rec)
    rec.end("parse", f"区块转录完成，{n_parsed} 块", started=t)
    t = rec.start("qc", "质检")
    run_qc(conn, doc_id, cfg=cfg, recorder=rec)  # 实质问题多的页自动触发整页 VLM 第二解析
    rec.end("qc", "质检完成", started=t)
    t = rec.start("crosscheck", "双模型比对")
    n_dis = run_llm_crosscheck(conn, cfg, doc_id, recorder=rec)
    rec.end("crosscheck", f"双模型比对完成，新增 {n_dis} 条分歧", started=t)
    t = rec.start("export", "页级镜像落盘")
    export_page_mds(conn, cfg, doc_id)  # 页级 markdown 落盘镜像
    rec.end("export", "页级镜像落盘完成", started=t)
    rec.end("ingest", f"入库完成 document_id={doc_id}")
    return doc_id
```

（原文件第一行注释/import 保留；`render_document`/`run_layout` 等 import 位置不变。）

- [ ] **Step 4: 修改 `pipeline/kb/parse.py`**

`run_parse` 签名加 `recorder=None`：

```python
def run_parse(conn, cfg: Config, doc_id: str, client=None, ocr=None,
              recorder=None) -> int:
```

循环体（parse.py:130-141）的两处转录分支替换为（引入 `time` 于文件头部 import）：

```python
        for block_id, crop_path, page_id, block_type in rows:
            try:
                if block_type in _OCRABLE_TYPES:
                    text, source, usage = ocr(crop_path), "rapidocr", (None, None)
                    if starred_math(text):  # OCR 把竖式拍成星号 -> 升级视觉模型
                        t0 = time.monotonic()
                        text, usage = transcribe_image(client, cfg.vision_model, crop_path)
                        source = cfg.vision_model
                        record_llm_call(
                            conn, doc_id, "transcribe", cfg.vision_model, usage,
                            recorder=recorder, stage="parse", page_id=str(page_id),
                            duration_ms=int((time.monotonic() - t0) * 1000),
                            prompt=TRANSCRIBE_PROMPT, output=text)
                else:
                    t0 = time.monotonic()
                    text, usage = transcribe_image(client, cfg.vision_model, crop_path)
                    source = cfg.vision_model
                    record_llm_call(
                        conn, doc_id, "transcribe", cfg.vision_model, usage,
                        recorder=recorder, stage="parse", page_id=str(page_id),
                        duration_ms=int((time.monotonic() - t0) * 1000),
                        prompt=TRANSCRIBE_PROMPT, output=text)
            except Exception as e:  # noqa: BLE001 - 单块失败不中断
                if recorder is not None:
                    recorder.error("parse", f"块转录失败: {str(e)[:200]}",
                                   page_id=str(page_id), exc=e)
                cur.execute(
                    "UPDATE pages SET parse_status='failed', parse_error=%s WHERE id=%s",
                    (str(e)[:500], page_id),
                )
                continue
```

（`import time` 加到 parse.py 头部。其余行不动。）

- [ ] **Step 5: 修改 `pipeline/kb/qc.py`**

`run_qc` 签名与 auto_page_vlm 调用（qc.py:131, 178-180）：

```python
def run_qc(conn, doc_id: str, cfg=None, vlm_client=None, recorder=None) -> int:
```

```python
    if cfg is not None:
        from kb.pagelvl import auto_page_vlm
        auto_page_vlm(conn, cfg, doc_id, client=vlm_client, recorder=recorder)
```

- [ ] **Step 6: 修改 `pipeline/kb/pagelvl.py`**

`transcribe_page`（pagelvl.py:24-39）完整替换：

```python
def transcribe_page(conn, cfg: Config, page_id: str, client=None,
                    recorder=None) -> str:
    """整页图发远端 VLM，page_md/page_md_model 落库。手动重发覆盖旧值。返回 page_md。"""
    import time

    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT image_path, document_id FROM pages WHERE id=%s", (page_id,))
        image_path, doc_id = cur.fetchone()
    t0 = time.monotonic()
    text, usage = transcribe_image(client, cfg.vision_model, image_path,
                                   prompt=PAGE_VLM_PROMPT)
    record_llm_call(conn, str(doc_id), "page_vlm", cfg.vision_model, usage,
                    recorder=recorder, stage="page_vlm", page_id=str(page_id),
                    duration_ms=int((time.monotonic() - t0) * 1000),
                    prompt=PAGE_VLM_PROMPT, output=text)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_md=%s, page_md_model=%s WHERE id=%s",
            (text, cfg.vision_model, page_id),
        )
    return text
```

`auto_page_vlm` 签名（pagelvl.py:42）加 `recorder=None`，循环内调用改 `transcribe_page(conn, cfg, pid, client=client, recorder=recorder)`。

- [ ] **Step 7: 修改 `pipeline/kb/crosscheck.py`**

`run_llm_crosscheck` 签名（crosscheck.py:30）加 `recorder=None`；转录与计量（crosscheck.py:55-56）替换为：

```python
            import time
            t0 = time.monotonic()
            second, usage = transcribe_image(client, cfg.vision_compare_model, crop_path)
            record_llm_call(conn, doc_id, "crosscheck", cfg.vision_compare_model, usage,
                            recorder=recorder, stage="crosscheck",
                            duration_ms=int((time.monotonic() - t0) * 1000),
                            prompt=TRANSCRIBE_PROMPT, output=second)
```

（`TRANSCRIBE_PROMPT` 从 `kb.parse` import——crosscheck.py 已 import `transcribe_image`，同处加 `TRANSCRIBE_PROMPT`。）

- [ ] **Step 8: 跑测试确认通过（含 ingest 相关回归）**

Run: `cd pipeline && uv run pytest tests/test_traj_ingest.py tests/test_metering.py tests/test_traj.py -v`
Expected: 全部 passed

- [ ] **Step 9: Commit**

```bash
git add pipeline/kb/pipeline.py pipeline/kb/parse.py pipeline/kb/qc.py pipeline/kb/pagelvl.py pipeline/kb/crosscheck.py pipeline/tests/test_traj_ingest.py
git commit -m "feat(pipeline): ingest 链路 trajectory 埋点（阶段事件 + 逐块 llm_call 带 page_id）"
```

---

### Task 6: structure 链路埋点（run_structure / structure_chapter / extract_toc）

**Files:**
- Modify: `pipeline/kb/structure.py`
- Modify: `pipeline/kb/toc.py`
- Test: `pipeline/tests/test_traj_structure.py`

- [ ] **Step 1: 写失败测试**

```python
# pipeline/tests/test_traj_structure.py
"""structure 编排：run 级阶段事件 + 拆条 llm_call。"""
import json
import uuid

from kb.config import Config
from kb.structure import run_structure


class _FakeMessage:
    def __init__(self, content):
        self.content = content


class _FakeResp:
    def __init__(self, content):
        self.choices = [type("C", (), {"message": _FakeMessage(content)})()]
        self.usage = type("U", (), {"prompt_tokens": 10, "completion_tokens": 5})()


class FakeStructureClient:
    """structure_chapter 的 chat.completions.create 返回空条目数组。"""

    class chat:
        class completions:
            @staticmethod
            def create(**kw):
                return _FakeResp("[]")


def _cfg(tmp_path, level="simple"):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


def test_run_structure_flat_records_stages(conn, tmp_path):
    """flat 模式（无目录页回退）：record 出 structure 阶段事件。"""
    with conn.cursor() as cur:
        doc_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
            (doc_id, "flat 测试", f"/tmp/{doc_id}.pdf"),
        )
        cur.execute(
            "INSERT INTO pages (id, document_id, page_no, image_path) VALUES (%s,%s,%s,%s)",
            (str(uuid.uuid4()), doc_id, 1, "/tmp/p1.png"),
        )
    out = run_structure(conn, _cfg(tmp_path), doc_id, flat=True)
    assert out["mode"] == "flat"
    with conn.cursor() as cur:
        cur.execute(
            """SELECT stage, event_type FROM pipeline_events
               WHERE document_id=%s ORDER BY id""",
            (doc_id,),
        )
        rows = cur.fetchall()
    assert ("structure", "stage_start") in rows
    assert ("structure", "stage_end") in rows
    # 同一 run
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(DISTINCT run_id) FROM pipeline_events WHERE document_id=%s",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_traj_structure.py -v`
Expected: FAIL（pipeline_events 无行）

- [ ] **Step 3: 修改 `pipeline/kb/structure.py`**

`structure_chapter` 签名（structure.py:58）加 `recorder=None`；计量行（structure.py:109）替换为：

```python
        record_llm_call(conn, doc_id, "structure", model, extract_usage(resp),
                        recorder=recorder, stage="structure",
                        prompt=prompt, output=resp.choices[0].message.content)
```

`run_structure`（structure.py:164-229）改造——函数开头建 Recorder，阶段事件包住关键节点：

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
    from kb.traj import Recorder

    rec = Recorder(conn, cfg, doc_id)
    rec.start("structure", "结构化拆条开始",
              payload={"flat": flat, "toc_pages": toc_pages})
    with conn.cursor() as cur:
        mode = resolve_mode(cur, doc_id, flat=flat, toc_pages=toc_pages)
    rec.decision("structure", f"模式判定: {mode}", payload={"mode": mode})
    if mode == "flat":
        if not flat:
            print("未找到目录页，回退整卷按页模式（--toc-pages 可显式指定目录页）")
        build_flat_chapter(conn, doc_id)
        print(f"整卷按页模式: 合成 1 章（不拆条,页级通过后按页向量化）; "
              f"落盘 {export_page_mds(conn, cfg, doc_id)} 页 md, "
              f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
        rec.end("structure", "整卷按页模式完成")
        return {"mode": "flat", "chapters": 1, "items": 0}
```

（中间事务段不动。）目录模式段（structure.py:207 起）：

```python
    n_toc = extract_toc(conn, cfg, doc_id, client=client, toc_pages=toc_pages,
                        recorder=rec)
    n_cal = calibrate_pages(conn, doc_id)
    print(f"目录: {n_toc} 章入库, {n_cal} 章完成页码校准")
    rec.decision("structure", f"目录: {n_toc} 章入库, {n_cal} 章完成页码校准")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = [r[0] for r in cur.fetchall()]
    total = 0
    for no in chapters:
        try:
            total += structure_chapter(conn, cfg, doc_id, no, client=client,
                                       recorder=rec)
        except SystemExit as e:
            rec.error("structure", f"第 {no} 章跳过: {e}")
            print(f"第 {no} 章跳过: {e}")
    print(f"条目: {total} 条入库; 配对 {pair_items(conn, doc_id)} 处; "
          f"题号质检新增 {check_label_continuity(conn, doc_id)} 条; "
          f"接地检查新增 {run_grounding(conn, doc_id)} 条")
    rec.decision("structure", f"条目: {total} 条入库")
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    print(f"落盘: {export_page_mds(conn, cfg, doc_id)} 页 md, "
          f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
    rec.end("structure", f"拆条完成，{len(chapters)} 章 {total} 条")
    return {"mode": "toc", "chapters": len(chapters), "items": total}
```

- [ ] **Step 4: 修改 `pipeline/kb/toc.py`**

`extract_toc` 签名（toc.py:90）加 `recorder=None`；计量行（toc.py:112）替换为：

```python
            record_llm_call(conn, doc_id, "toc", model, usage,
                            recorder=recorder, stage="structure",
                            prompt=TOC_PROMPT, output=text)
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_traj_structure.py -v`
Expected: 1 passed；再跑 `uv run pytest tests/ -v` 确认无回归

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/structure.py pipeline/kb/toc.py pipeline/tests/test_traj_structure.py
git commit -m "feat(pipeline): structure 链路 trajectory 埋点（模式判定/目录/拆条/完成）"
```

---

### Task 7: approve / embed 埋点

**Files:**
- Modify: `pipeline/kb/embed.py`（approve_items 建 Recorder；embed_approved_items/embed_chapters 加 recorder 参数记 decision）
- Modify: `pipeline/kb/flat.py`（approve_flat_pages 建 Recorder）
- Test: `pipeline/tests/test_traj_approve.py`

- [ ] **Step 1: 写失败测试**

```python
# pipeline/tests/test_traj_approve.py
"""approve：approve 条数 + 向量化条数进 trajectory。"""
import uuid

from kb.config import Config
from kb.embed import approve_items


class FakeEmbedClient:
    class embeddings:
        @staticmethod
        def create(**kw):
            return type("R", (), {"data": [type("D", (), {"embedding": [0.1] * 1024})()]})()


def _cfg(tmp_path, level="simple"):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


def test_approve_items_records_events(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
            (doc_id, "approve 测试", f"/tmp/{doc_id}.pdf"),
        )
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md)
               VALUES (%s,%s,'exercise','1','1+1=?')""",
            (str(uuid.uuid4()), doc_id),
        )
    out = approve_items(conn, _cfg(tmp_path), doc_id, client=FakeEmbedClient())
    assert out["approved"] == 1
    with conn.cursor() as cur:
        cur.execute(
            """SELECT stage, event_type FROM pipeline_events
               WHERE document_id=%s ORDER BY id""",
            (doc_id,),
        )
        rows = cur.fetchall()
    stages = {(r[0], r[1]) for r in rows}
    assert ("approve", "stage_start") in stages
    assert ("approve", "decision") in stages      # approve 条数
    assert ("embed", "decision") in stages        # 向量化条数
    assert ("approve", "stage_end") in stages
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && uv run pytest tests/test_traj_approve.py -v`
Expected: FAIL（pipeline_events 无行）

- [ ] **Step 3: 修改 `pipeline/kb/embed.py`**

`embed_approved_items` 签名（embed.py:29）加 `recorder=None`，`return len(rows)` 前加：

```python
    if recorder is not None:
        recorder.decision("embed", f"条目向量化新增 {len(rows)} 条 chunk")
    return len(rows)
```

`embed_chapters` 签名（embed.py:83）加 `recorder=None`，`return len(payloads)` 前加：

```python
    if recorder is not None:
        recorder.decision("embed", f"章节向量化新增 {len(payloads)} 条 chunk")
    return len(payloads)
```

`approve_items`（embed.py:122-155）——开头建 Recorder、关键节点埋点、embed 调用透传：

```python
def approve_items(conn, cfg: Config, doc_id: str, chapter_no: int | None = None,
                  client=None) -> dict:
    """批量通过一个文档(可限章)的条目:非 approved/rejected 一律 approved,
    关闭其 pending 复核行,并立即向量化(条目 + 章节)。88 页练习册不该逐条点 approve。"""
    from kb.traj import Recorder

    rec = Recorder(conn, cfg, doc_id)
    rec.start("approve", f"批量通过（chapter_no={chapter_no}）",
              payload={"chapter_no": chapter_no})
    label = None
    # …（label 解析与 UPDATE 段保持原样不动）…
    rec.decision("approve", f"通过 {len(ids)} 条", payload={"approved": len(ids)})
    n = embed_approved_items(conn, cfg, doc_id, client=client, recorder=rec)
    n += embed_chapters(conn, cfg, doc_id, client=client, recorder=rec)
    rec.end("approve", f"通过 {len(ids)} 条，新增向量 {n} 条")
    return {"approved": len(ids), "embedded": n}
```

（即：在原函数体 `label = None` 前插入 Recorder 创建与 `rec.start`；在 `n = embed_approved_items(...)` 前插入 `rec.decision`；两个 embed 调用加 `recorder=rec`；return 前加 `rec.end`。）

- [ ] **Step 4: 修改 `pipeline/kb/flat.py`**

`approve_flat_pages`（flat.py:158-189）——开头（`with conn.transaction():` 前）加：

```python
    from kb.traj import Recorder

    rec = Recorder(conn, cfg, doc_id)
    rec.start("approve", "flat 整卷通过")
```

`return {"pages": n_pages, "chunks": chunks, "resolved": resolved}` 前加：

```python
    rec.decision("approve", f"关闭 {resolved} 条复核行")
    rec.decision("embed", f"页级向量化新增 {chunks} 条 chunk")
    rec.end("approve", f"通过 {n_pages} 页，新增向量 {chunks} 条")
```

- [ ] **Step 5: internal API 手动触发入口补 recorder**

`pipeline/kb/internal_api.py` 的 `/internal/page-vlm` 端点（`:158-176`）：`transcribe_page` 调用处建 Recorder 并透传，手动整页 VLM 也进 trajectory：

```python
            md = transcribe_page(conn, cfg, body.page_id, client=vlm_client)
```

改为：

```python
            from kb.traj import Recorder
            with conn.cursor() as cur:
                cur.execute("SELECT document_id FROM pages WHERE id=%s", (body.page_id,))
                doc_id = str(cur.fetchone()[0])
            rec = Recorder(conn, cfg, doc_id)
            rec.start("page_vlm", "手动整页 VLM 重跑", page_id=body.page_id)
            md = transcribe_page(conn, cfg, body.page_id, client=vlm_client,
                                 recorder=rec)
            rec.end("page_vlm", "手动整页 VLM 完成", page_id=body.page_id)
```

（`/internal/approve-item` 走的 `approve_items` 内部已自建 Recorder，无需改动。）

- [ ] **Step 6: 跑测试确认通过**

Run: `cd pipeline && uv run pytest tests/test_traj_approve.py -v && uv run pytest tests/ -v`
Expected: 新测试 passed，全套无回归

- [ ] **Step 7: Commit**

```bash
git add pipeline/kb/embed.py pipeline/kb/flat.py pipeline/kb/internal_api.py pipeline/tests/test_traj_approve.py
git commit -m "feat(pipeline): approve/embed trajectory 埋点（通过条数 + 向量化条数）；手动 page-vlm 入 trajectory"
```

---

### Task 8: backend `trajectory.ts` 查询路由

**Files:**
- Create: `backend/src/routes/trajectory.ts`
- Modify: `backend/src/index.ts`（注册路由，`:66` 附近）
- Test: `backend/src/routes/trajectory.test.ts`

API 形态（spec）：run 列表 / run 事件流（可按 page 过滤）/ by 页事件 / 单事件 payload 详情。列表响应不含 payload。run 列表 LIMIT 100、事件流 LIMIT 500（量级足够，不做游标分页——YAGNI）。

- [ ] **Step 1: 写失败测试**

```ts
// backend/src/routes/trajectory.test.ts
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDbForTest } from "../db";
import { trajectoryRoutes } from "./trajectory";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("trajectory API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let docId: string;
  let pageId: string;
  let runId: string;
  let eventId: number;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api", trajectoryRoutes(pool));
    docId = crypto.randomUUID();
    pageId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO documents (id, title, source_path) VALUES ($1,$2,$3)",
      [docId, "traj 测试", `/tmp/${docId}.pdf`]);
    await pool.query(
      "INSERT INTO pages (id, document_id, page_no, image_path) VALUES ($1,$2,$3,$4)",
      [pageId, docId, 1, "/tmp/p1.png"]);
    const { rows: [ev] } = await pool.query(
      `INSERT INTO pipeline_events
         (run_id, document_id, page_id, stage, event_type, summary, payload, status)
       VALUES ($1,$2,$3,'parse','llm_call','transcribe qwen3:4b','{"prompt":"p"}','ok')
       RETURNING id`,
      [runId, docId, pageId]);
    eventId = ev.id;
    await pool.query(
      `INSERT INTO pipeline_events (run_id, document_id, stage, event_type, summary, status)
       VALUES ($1,$2,'parse','error','块转录失败','error')`,
      [runId, docId]);
  });

  afterAll(async () => { await pool.end(); });

  it("GET /api/documents/:id/trajectory 返回 run 列表", async () => {
    const resp = await app.request(`/api/documents/${docId}/trajectory`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].run_id).toBe(runId);
    expect(data.runs[0].event_count).toBe(2);
    expect(data.runs[0].error_count).toBe(1);
    expect(data.runs[0].first_stage).toBe("parse");
  });

  it("GET /api/documents/:id/trajectory?level=event&run_id=X 返回事件流（不含 payload）", async () => {
    const resp = await app.request(
      `/api/documents/${docId}/trajectory?level=event&run_id=${runId}`);
    const data = await resp.json();
    expect(data.events).toHaveLength(2);
    expect(data.events[0].summary).toBe("transcribe qwen3:4b");
    expect(data.events[0]).not.toHaveProperty("payload");
  });

  it("事件流支持 page_id 过滤", async () => {
    const resp = await app.request(
      `/api/documents/${docId}/trajectory?level=event&run_id=${runId}&page_id=${pageId}`);
    const data = await resp.json();
    expect(data.events).toHaveLength(1);
    expect(data.events[0].page_id).toBe(pageId);
  });

  it("GET /api/pages/:id/trajectory 返回该页事件", async () => {
    const resp = await app.request(`/api/pages/${pageId}/trajectory`);
    const data = await resp.json();
    expect(data.events).toHaveLength(1);
    expect(data.events[0].stage).toBe("parse");
  });

  it("GET /api/trajectory/events/:id 返回 payload 详情", async () => {
    const resp = await app.request(`/api/trajectory/events/${eventId}`);
    const data = await resp.json();
    expect(data.payload).toEqual({ prompt: "p" });
  });

  it("非法 UUID 返回 422", async () => {
    const resp = await app.request("/api/documents/not-a-uuid/trajectory");
    expect(resp.status).toBe(422);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/routes/trajectory.test.ts`
Expected: FAIL，`Cannot find module './trajectory'`

- [ ] **Step 3: 实现 `backend/src/routes/trajectory.ts`**

```ts
// backend/src/routes/trajectory.ts
// trajectory 处理日志查询：直读 pipeline_events（事实来源），不走 pipeline。
import type { Context } from "hono";
import { Hono } from "hono";
import type pg from "pg";

function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422) : null;
}

const EVENT_COLS = `id, run_id::text, document_id::text, page_id::text, item_id::text,
  stage, event_type, summary, model, prompt_tokens, completion_tokens,
  duration_ms, status, actor, created_at`;

export function trajectoryRoutes(pool: pg.Pool): Hono {
  const app = new Hono();

  // by 文档：默认 run 列表；level=event 展开某 run 的事件流（可按 page_id 过滤）
  app.get("/documents/:id/trajectory", async (c) => {
    const docId = c.req.param("id");
    const q = c.req.query();
    try {
      if (q.level === "event") {
        const conds = ["document_id=$1"];
        const params: unknown[] = [docId];
        if (q.run_id) { params.push(q.run_id); conds.push(`run_id=$${params.length}`); }
        if (q.page_id) { params.push(q.page_id); conds.push(`page_id=$${params.length}`); }
        const { rows } = await pool.query(
          `SELECT ${EVENT_COLS} FROM pipeline_events
           WHERE ${conds.join(" AND ")} ORDER BY id LIMIT 500`, params);
        return c.json({ events: rows });
      }
      const { rows } = await pool.query(
        `SELECT run_id::text,
                min(created_at) AS started_at, max(created_at) AS ended_at,
                count(*)::int AS event_count,
                count(*) FILTER (WHERE status='error')::int AS error_count,
                (array_agg(stage ORDER BY id))[1] AS first_stage,
                (array_agg(actor ORDER BY id))[1] AS actor,
                (array_agg(summary ORDER BY id))[1] AS first_summary
         FROM pipeline_events WHERE document_id=$1
         GROUP BY run_id ORDER BY started_at DESC LIMIT 100`, [docId]);
      return c.json({ runs: rows });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  // by 页：复核页「本页日志」面板
  app.get("/pages/:id/trajectory", async (c) => {
    try {
      const { rows } = await pool.query(
        `SELECT ${EVENT_COLS} FROM pipeline_events
         WHERE page_id=$1 ORDER BY id LIMIT 500`, [c.req.param("id")]);
      return c.json({ events: rows });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  // 单事件 payload 详情（前端展开时按需加载）
  app.get("/trajectory/events/:id", async (c) => {
    const { rows: [ev] } = await pool.query(
      `SELECT ${EVENT_COLS}, payload FROM pipeline_events WHERE id=$1`,
      [c.req.param("id")]);
    if (!ev) return c.json({ error: "事件不存在" }, 404);
    return c.json(ev);
  });

  return app;
}
```

- [ ] **Step 4: 注册路由**

`backend/src/index.ts`：import 加 `import { trajectoryRoutes } from "./routes/trajectory";`，在 `app.route("/api/review", ...)`（`:63-65`）后加一行：

```ts
app.route("/api", trajectoryRoutes(pool));
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && npx vitest run src/routes/trajectory.test.ts`
Expected: 6 passed；再跑 `npm test` 确认无回归

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/trajectory.ts backend/src/routes/trajectory.test.ts backend/src/index.ts
git commit -m "feat(backend): trajectory 查询 API（by 文档 run 列表/事件流、by 页、payload 详情）"
```

---

### Task 9: backend 用户编辑写 `user_edit` 事件

**Files:**
- Modify: `backend/src/routes/review.ts`（`PATCH /items/:id` `:334-349`、`PATCH /blocks/:id` `:246-269`、`PATCH /pages/:id` `:271-290`）
- Test: `backend/src/routes/review.test.ts`（追加用例）

约定（spec）：每次编辑自成一 run（`gen_random_uuid()`）；`stage='user_edit'`、`event_type='edit'`、`actor='user'`；payload 存 `{field, old, new}` diff；不受 `KB_TRAJECTORY_LEVEL` 影响，永远记录；只写 DB 不写 JSONL。

- [ ] **Step 1: 追加失败测试**（种子数据沿用该文件现有 beforeAll 的 documents/pages/blocks/items——参考其 `:12-43` 与现有 PATCH 用例的写法）

```ts
// 追加到 backend/src/routes/review.test.ts 的真库 describe 内
it("PATCH /items/:id 记录 user_edit 事件（含 diff）", async () => {
  // 用现有种子 item；old 值为种子的 content_md
  const { rows: [item] } = await pool.query(
    "SELECT id::text, document_id::text, content_md FROM items LIMIT 1");
  const resp = await app.request(`/api/review/items/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content_md: "人工修正后的内容" }),
  });
  expect(resp.status).toBe(200);
  const { rows: events } = await pool.query(
    `SELECT stage, event_type, actor, item_id::text, payload
     FROM pipeline_events WHERE document_id=$1 AND stage='user_edit'`,
    [item.document_id]);
  expect(events).toHaveLength(1);
  expect(events[0].event_type).toBe("edit");
  expect(events[0].actor).toBe("user");
  expect(events[0].item_id).toBe(item.id);
  expect(events[0].payload).toEqual({
    field: "content_md", old: item.content_md, new: "人工修正后的内容",
  });
});

it("PATCH /pages/:id 记录 user_edit 事件（带 page_id）", async () => {
  const { rows: [page] } = await pool.query(
    "SELECT id::text, document_id::text, page_md FROM pages LIMIT 1");
  const resp = await app.request(`/api/review/pages/${page.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_md: "人工修正的整页稿" }),
  });
  expect(resp.status).toBe(200);
  const { rows: events } = await pool.query(
    `SELECT page_id::text, payload FROM pipeline_events
     WHERE document_id=$1 AND stage='user_edit' AND page_id=$2`,
    [page.document_id, page.id]);
  expect(events).toHaveLength(1);
  expect(events[0].payload).toEqual({
    field: "page_md", old: page.page_md, new: "人工修正的整页稿",
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/routes/review.test.ts`
Expected: FAIL——新用例查不到 `pipeline_events` 行

- [ ] **Step 3: 修改 `PATCH /items/:id`（review.ts:334-349）**

UPDATE 前先取旧值，成功后插事件：

```ts
app.patch("/items/:id", async (c) => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
  const id = c.req.param("id");
  try {
    const { rows: [before] } = await pool.query(
      "SELECT content_md, document_id::text FROM items WHERE id=$1", [id]);
    if (!before) return c.json({ error: "item 不存在" }, 404);
    const { rows: [item] } = await pool.query(
      "UPDATE items SET content_md=$2, updated_at=now() WHERE id=$1 RETURNING id::text, content_md",
      [id, body.content_md]);
    await pool.query("DELETE FROM chunks WHERE item_id=$1", [id]);
    await pool.query(
      `INSERT INTO pipeline_events
         (run_id, document_id, item_id, stage, event_type, summary, payload, actor)
       VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'edit', $3, $4, 'user')`,
      [before.document_id, id, "编辑条目内容",
       JSON.stringify({ field: "content_md", old: before.content_md, new: body.content_md })]);
    return c.json(item);
  } catch (err) {
    return invalidId(c, err) ?? (() => { throw err; })();
  }
});
```

- [ ] **Step 4: 修改 `PATCH /pages/:id`（review.ts:271-290）**

```ts
app.patch("/pages/:id", async (c) => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (typeof body.page_md !== "string") return c.json({ error: "page_md 必填" }, 422);
  try {
    const { rows: [before] } = await pool.query(
      "SELECT page_md FROM pages WHERE id=$1", [c.req.param("id")]);
    if (!before) return c.json({ error: "page 不存在" }, 404);
    const { rows: [page] } = await pool.query(
      `UPDATE pages SET page_md=$2, index_status='stale', index_error=NULL
       WHERE id=$1 RETURNING id::text, page_no, document_id::text, page_md, index_status`,
      [c.req.param("id"), body.page_md]);
    await pool.query(
      `DELETE FROM chunks WHERE document_id=$1 AND (
         page_no=$2 OR source_block_ids && ARRAY(
           SELECT id FROM blocks WHERE page_id=$3))`,
      [page.document_id, page.page_no, page.id]);
    await pool.query(
      `INSERT INTO pipeline_events
         (run_id, document_id, page_id, stage, event_type, summary, payload, actor)
       VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'edit', $3, $4, 'user')`,
      [page.document_id, page.id, "编辑整页稿",
       JSON.stringify({ field: "page_md", old: before.page_md, new: body.page_md })]);
    return c.json(page);
  } catch (err) {
    return invalidId(c, err) ?? (() => { throw err; })();
  }
});
```

- [ ] **Step 5: 修改 `PATCH /blocks/:id`（review.ts:246-269）**

```ts
app.patch("/blocks/:id", async (c) => {
  const body = await readJson(c);
  if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
  if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
  try {
    const { rows: [before] } = await pool.query(
      "SELECT content_md FROM blocks WHERE id=$1", [c.req.param("id")]);
    if (!before) return c.json({ error: "block 不存在" }, 404);
    const { rows: [b] } = await pool.query(
      "UPDATE blocks SET content_md=$2 WHERE id=$1 RETURNING id::text, content_md",
      [c.req.param("id"), body.content_md]);
    const { rows: [page] } = await pool.query(
      `SELECT p.id::text, p.document_id::text, p.page_no
       FROM pages p WHERE p.id=(SELECT page_id FROM blocks WHERE id=$1)`, [c.req.param("id")]);
    if (page) {
      await pool.query("UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [page.id]);
      await pool.query(
        `DELETE FROM chunks WHERE document_id=$1 AND (
           source_block_ids && ARRAY[$2::uuid] OR page_no=$3)`,
        [page.document_id, c.req.param("id"), page.page_no]);
      await pool.query(
        `INSERT INTO pipeline_events
           (run_id, document_id, page_id, stage, event_type, summary, payload, actor)
         VALUES (gen_random_uuid(), $1, $2, 'user_edit', 'edit', $3, $4, 'user')`,
        [page.document_id, page.id, "编辑块内容",
         JSON.stringify({ field: "content_md", old: before.content_md, new: body.content_md })]);
    }
    return c.json(b);
  } catch (err) {
    return invalidId(c, err) ?? (() => { throw err; })();
  }
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd backend && npx vitest run src/routes/review.test.ts && npm test`
Expected: 全部 passed

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 用户编辑（item/page/block）记录 user_edit trajectory 事件（含 diff）"
```

---

### Task 10: 前端 trajectory 展示（api client + 处理日志 tab + 本页日志面板）

**Files:**
- Create: `frontend/src/api/trajectory.ts`
- Create: `frontend/src/components/TrajectoryPanel.tsx`
- Modify: `frontend/src/views/MaterialsView.tsx`（`:10-14` BLOCKS 加「处理日志」，`:149` 附近加渲染分支）
- Modify: `frontend/src/components/PageDetail.tsx`（pd-toolbar 加「本页日志」toggle + 面板）
- Test: `frontend/src/components/TrajectoryPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// frontend/src/components/TrajectoryPanel.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DocTrajectory, PageTrajectory } from "./TrajectoryPanel";

const RUN = {
  run_id: "r1", started_at: "2026-09-07T01:00:00Z", ended_at: "2026-09-07T01:01:00Z",
  event_count: 2, error_count: 1, first_stage: "parse", actor: "pipeline",
  first_summary: "区块转录",
};
const EVENTS = [
  { id: 1, run_id: "r1", document_id: "d1", page_id: "p1", item_id: null,
    stage: "parse", event_type: "llm_call", summary: "transcribe qwen3:4b",
    model: "qwen3:4b", prompt_tokens: 10, completion_tokens: 5,
    duration_ms: 120, status: "ok", actor: "pipeline", created_at: "2026-09-07T01:00:01Z" },
  { id: 2, run_id: "r1", document_id: "d1", page_id: null, item_id: null,
    stage: "parse", event_type: "error", summary: "块转录失败",
    model: null, prompt_tokens: null, completion_tokens: null,
    duration_ms: null, status: "error", actor: "pipeline", created_at: "2026-09-07T01:00:02Z" },
];

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [k, v] of Object.entries(routes)) {
      if (url.includes(k)) {
        return { ok: true, json: async () => v } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as Response;
  }) as typeof fetch;
}

describe("DocTrajectory", () => {
  it("展示 run 列表，点击展开事件流，错误事件高亮", async () => {
    const f = fakeFetch({
      [`/api/documents/d1/trajectory?level=event&run_id=r1`]: { events: EVENTS },
      [`/api/documents/d1/trajectory`]: { runs: [RUN] },
    });
    render(<DocTrajectory docId="d1" fetchImpl={f} />);
    await waitFor(() => screen.getByText(/parse/));
    expect(screen.getByText(/2 事件/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /parse/ }));
    await waitFor(() => screen.getByText("transcribe qwen3:4b"));
    expect(screen.getByText("块转录失败").closest(".traj-event")?.className).toContain("error");
  });

  it("无日志时显示空态", async () => {
    const f = fakeFetch({ [`/api/documents/d1/trajectory`]: { runs: [] } });
    render(<DocTrajectory docId="d1" fetchImpl={f} />);
    await waitFor(() => screen.getByText("暂无处理日志"));
  });
});

describe("PageTrajectory", () => {
  it("展示本页事件", async () => {
    const f = fakeFetch({ [`/api/pages/p1/trajectory`]: { events: EVENTS.slice(0, 1) } });
    render(<PageTrajectory pageId="p1" fetchImpl={f} />);
    await waitFor(() => screen.getByText("transcribe qwen3:4b"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/TrajectoryPanel.test.tsx`
Expected: FAIL，`Cannot find module './TrajectoryPanel'`

- [ ] **Step 3: 实现 `frontend/src/api/trajectory.ts`**

```ts
// frontend/src/api/trajectory.ts
// trajectory 处理日志 API（backend /api 直读 pipeline_events）。
type FetchLike = typeof fetch;

export interface TrajectoryRun {
  run_id: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  error_count: number;
  first_stage: string;
  actor: string;
  first_summary: string;
}

export interface TrajectoryEvent {
  id: number;
  run_id: string;
  document_id: string;
  page_id: string | null;
  item_id: string | null;
  stage: string;
  event_type: string;
  summary: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  status: "ok" | "error" | "skipped";
  actor: string;
  created_at: string;
  payload?: Record<string, unknown> | null;
}

async function req<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`;
    try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

export function fetchDocRuns(docId: string, fetchImpl: FetchLike = fetch) {
  return req<{ runs: TrajectoryRun[] }>(
    `/api/documents/${encodeURIComponent(docId)}/trajectory`, fetchImpl);
}

export function fetchDocEvents(docId: string, runId: string, fetchImpl: FetchLike = fetch) {
  return req<{ events: TrajectoryEvent[] }>(
    `/api/documents/${encodeURIComponent(docId)}/trajectory?level=event&run_id=${encodeURIComponent(runId)}`,
    fetchImpl);
}

export function fetchPageEvents(pageId: string, fetchImpl: FetchLike = fetch) {
  return req<{ events: TrajectoryEvent[] }>(
    `/api/pages/${encodeURIComponent(pageId)}/trajectory`, fetchImpl);
}

export function fetchEventDetail(id: number, fetchImpl: FetchLike = fetch) {
  return req<TrajectoryEvent>(`/api/trajectory/events/${id}`, fetchImpl);
}
```

- [ ] **Step 4: 实现 `frontend/src/components/TrajectoryPanel.tsx`**

```tsx
// frontend/src/components/TrajectoryPanel.tsx
// trajectory 处理日志面板：DocTrajectory（文档级 run 时间线 + 事件流）、
// PageTrajectory（页级事件流）。payload 用原生 <details> 按需加载。
import { useEffect, useState } from "react";
import {
  fetchDocEvents, fetchDocRuns, fetchEventDetail, fetchPageEvents,
  type TrajectoryEvent, type TrajectoryRun,
} from "../api/trajectory";

type FetchLike = typeof fetch;

function EventRow({ ev, fetchImpl }: { ev: TrajectoryEvent; fetchImpl: FetchLike }) {
  return (
    <li className={`traj-event ${ev.status}`}>
      <span className="traj-stage">{ev.stage}</span>
      <span className="traj-type">{ev.event_type}</span>
      <span className="traj-summary">{ev.summary}</span>
      {ev.duration_ms != null && <span className="traj-meta">{ev.duration_ms}ms</span>}
      {ev.model && <span className="traj-meta">{ev.model}</span>}
      <details className="traj-payload" onToggle={async (e) => {
        const el = e.currentTarget;
        if (el.open && !el.dataset.loaded) {
          el.dataset.loaded = "1";
          const detail = await fetchEventDetail(ev.id, fetchImpl);
          const pre = el.querySelector("pre");
          if (pre) pre.textContent = detail.payload ? JSON.stringify(detail.payload, null, 2) : "（无详细记录，simple 级别只记摘要）";
        }
      }}>
        <summary>详情</summary>
        <pre>加载中…</pre>
      </details>
    </li>
  );
}

export function EventList({ events, fetchImpl }: { events: TrajectoryEvent[]; fetchImpl: FetchLike }) {
  if (events.length === 0) return <div className="chat-empty">暂无处理日志</div>;
  return (
    <ul className="traj-events">
      {events.map((ev) => <EventRow key={ev.id} ev={ev} fetchImpl={fetchImpl} />)}
    </ul>
  );
}

/** 文档级：run 时间线，点击 run 展开事件流。 */
export function DocTrajectory({ docId, fetchImpl = fetch }: { docId: string; fetchImpl?: FetchLike }) {
  const [runs, setRuns] = useState<TrajectoryRun[] | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setRuns(null); setEvents(null); setActiveRun(null);
    fetchDocRuns(docId, fetchImpl).then((r) => setRuns(r.runs))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [docId, fetchImpl]);

  const openRun = async (runId: string) => {
    setActiveRun(runId);
    try { setEvents((await fetchDocEvents(docId, runId, fetchImpl)).events); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!runs) return <div className="chat-empty">加载中…</div>;
  if (runs.length === 0) return <div className="chat-empty">暂无处理日志</div>;
  return (
    <div className="traj-doc">
      <ul className="traj-runs">
        {runs.map((r) => (
          <li key={r.run_id}>
            <button className={activeRun === r.run_id ? "active" : ""}
                    onClick={() => void openRun(r.run_id)}>
              {r.first_stage} · {r.actor} · {r.event_count} 事件
              {r.error_count > 0 && <span className="badge error">{r.error_count} 错误</span>}
              <span className="traj-meta">{new Date(r.started_at).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
      {events && <EventList events={events} fetchImpl={fetchImpl} />}
    </div>
  );
}

/** 页级：本页事件流。 */
export function PageTrajectory({ pageId, fetchImpl = fetch }: { pageId: string; fetchImpl?: FetchLike }) {
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchPageEvents(pageId, fetchImpl).then((r) => setEvents(r.events))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [pageId, fetchImpl]);
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!events) return <div className="chat-empty">加载中…</div>;
  return <EventList events={events} fetchImpl={fetchImpl} />;
}
```

`frontend/src/theme.css` 追加样式（沿用 CSS 变量与现有 `.chat-empty`/`.badge`/`.form-error` 模式）：

```css
/* trajectory 处理日志 */
.traj-runs, .traj-events { list-style: none; padding: 0; margin: 0; }
.traj-runs > li > button {
  display: flex; gap: 8px; align-items: center; width: 100%;
  padding: 6px 10px; border: 1px solid var(--border); background: none;
  border-radius: 6px; margin-bottom: 4px; cursor: pointer; text-align: left;
}
.traj-runs > li > button.active { border-color: var(--accent); }
.traj-event {
  display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
  padding: 4px 10px; border-left: 3px solid var(--border); margin-bottom: 2px;
}
.traj-event.error { border-left-color: var(--danger, #c0392b); }
.traj-stage { font-weight: 600; }
.traj-type, .traj-meta { color: var(--muted); font-size: 12px; }
.traj-payload pre {
  width: 100%; max-height: 300px; overflow: auto;
  font-family: monospace; font-size: 12px; white-space: pre-wrap;
  background: var(--bg-soft, rgba(0,0,0,.04)); padding: 8px; border-radius: 6px;
}
.badge.error { color: var(--danger, #c0392b); }
```

（CSS 变量名以 theme.css 实际定义为准——若 `--border`/`--accent` 不存在，用 theme.css 里等价变量。）

- [ ] **Step 5: 接入 MaterialsView「处理日志」块**

`frontend/src/views/MaterialsView.tsx`：

- `:10` 类型改 `type Block = "pending" | "approved" | "chapters" | "items" | "search" | "logs";`
- `:12-14` BLOCKS 数组末尾加 `["logs", "处理日志"]`。
- import 加 `import { DocTrajectory } from "../components/TrajectoryPanel";`
- `:149` 的 `block === "search"` 分支后加：

```tsx
      {!pageId && !item && block === "logs" && (
        docId
          ? <DocTrajectory docId={docId} fetchImpl={fetchImpl} />
          : <div className="chat-empty">请先在上方选择文档</div>
      )}
```

- [ ] **Step 6: 接入 PageDetail「本页日志」**

`frontend/src/components/PageDetail.tsx`：

- import 加 `import { PageTrajectory } from "./TrajectoryPanel";`
- state 加 `const [showLog, setShowLog] = useState(false);`
- pd-toolbar（`:77-84`）末尾「预览切分」按钮后加：

```tsx
        <button className={showLog ? "btn-primary" : "btn-ghost"} onClick={() => setShowLog(!showLog)}>本页日志</button>
```

- pd-toolbar 的 `</div>` 之后加：

```tsx
      {showLog && <div className="pd-traj"><PageTrajectory pageId={pageId} fetchImpl={fetchImpl} /></div>}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/TrajectoryPanel.test.tsx && npm test && npm run build`
Expected: 全部 passed，build 无类型错误

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/trajectory.ts frontend/src/components/TrajectoryPanel.tsx frontend/src/components/TrajectoryPanel.test.tsx frontend/src/views/MaterialsView.tsx frontend/src/components/PageDetail.tsx frontend/src/theme.css
git commit -m "feat(frontend): trajectory 处理日志 tab（文档级 run 时间线）+ 页复核本页日志面板"
```

---

### Task 11: e2e spec（全链路验证）

**Files:**
- Create: `e2e/specs/trajectory.spec.ts`

按项目 E2E 纪律：真实三服务 + PostgreSQL，断言到 UI、API、JSONL、DB 字段。模式参照 `e2e/specs/materials-review.spec.ts`（pg.Pool 直插种子、`test.describe.configure({ mode: "serial" })`、afterAll 清文档 + storage 目录、`KEEP_DB` 保留开关）。

范围说明：完整 ingest 需真 VLM 且慢，e2e 主断言放在**用户编辑 → user_edit 事件 → UI 展示**这条端到端链路；pipeline 侧事件用 SQL 种子 + 直接调 `Recorder`（`uv run python` 一次性脚本）产生真实 JSONL 镜像来验证 by 文档/by 页展示与镜像文件存在。

- [ ] **Step 1: 写 spec**

```ts
// e2e/specs/trajectory.spec.ts
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { expect, test } from "@playwright/test";

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(__dirname, "../../pipeline");
const STORAGE_ROOT = path.join(PIPELINE_DIR, "storage");
const pool = new pg.Pool({ connectionString: DB_URL });

let docId: string;
let pageId: string;
let itemId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  docId = crypto.randomUUID();
  pageId = crypto.randomUUID();
  itemId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO documents (id, title, subject, source_path) VALUES ($1,$2,$3,$4)",
    [docId, `traj-${RUN}`, "数学", `/tmp/traj-${RUN}.pdf`]);
  await pool.query(
    "INSERT INTO pages (id, document_id, page_no, image_path) VALUES ($1,$2,$3,$4)",
    [pageId, docId, 1, `${STORAGE_ROOT}/${docId}/pages/p0001.png`]);
  await pool.query(
    "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES ($1,$2,'exercise','1','1+1=?')",
    [itemId, docId]);
  // 真实 Recorder 产生 pipeline 侧事件 + JSONL 镜像（verbose 级别）
  execFileSync("uv", ["run", "python", "-c", `
import os
from kb.config import load_config
from kb.db import connect
from kb.traj import Recorder
os.environ["KB_TRAJECTORY_LEVEL"] = "verbose"
cfg = load_config()
conn = connect(cfg.database_url)
rec = Recorder(conn, cfg, "${docId}")
t = rec.start("parse", "区块转录", page_id="${pageId}")
rec.llm_call("parse", "transcribe qwen3:4b", page_id="${pageId}",
             model="qwen3:4b", usage=(10, 5), prompt="e2e prompt", output="e2e output")
rec.end("parse", "区块转录完成", started=t, page_id="${pageId}")
print(rec.run_id)
`], { cwd: PIPELINE_DIR, env: { ...process.env, KB_TRAJECTORY_LEVEL: "verbose" } });
});

test.afterAll(async () => {
  if (process.env.KEEP_DB) return;
  await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  rmSync(path.join(STORAGE_ROOT, docId), { recursive: true, force: true });
  await pool.end();
});

test("t1 文档级：处理日志 tab 展示 run 时间线与事件流", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByLabel("选择文档").selectOption({ label: `traj-${RUN}` });
  await page.getByRole("button", { name: "处理日志" }).click();
  // run 时间线（Recorder 产生 1 个 run，3 个事件）
  const runBtn = page.getByRole("button", { name: /parse · pipeline · 3 事件/ });
  await expect(runBtn).toBeVisible();
  await runBtn.click();
  await expect(page.getByText("transcribe qwen3:4b")).toBeVisible();
  // API 层断言：事件字段齐全
  const apiResp = await page.request.get(
    `http://127.0.0.1:8787/api/documents/${docId}/trajectory?level=event`);
  const { events } = await apiResp.json();
  expect(events).toHaveLength(3);
  expect(events[1]).toMatchObject({
    stage: "parse", event_type: "llm_call", model: "qwen3:4b",
    prompt_tokens: 10, completion_tokens: 5, page_id: pageId,
  });
});

test("t2 JSONL 镜像存在且行数与 DB 一致", async () => {
  const { rows } = await pool.query(
    "SELECT run_id::text, count(*) FROM pipeline_events WHERE document_id=$1 GROUP BY run_id",
    [docId]);
  const runId = rows[0].run_id;
  const mirror = path.join(STORAGE_ROOT, docId, "trajectory", `${runId}.jsonl`);
  expect(existsSync(mirror)).toBe(true);
});

test("t3 用户编辑条目产生 user_edit 事件并在 UI 可见", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByLabel("选择文档").selectOption({ label: `traj-${RUN}` });
  await page.getByRole("button", { name: "条目" }).click();
  await page.getByRole("button", { name: /1\+1=\?/ }).click();
  // 条目详情里编辑内容（沿用 ItemDetail 的编辑交互）
  await page.getByRole("button", { name: /编辑/ }).click();
  const editor = page.locator("textarea").first();
  await editor.fill("1+1=2（人工修正）");
  await page.getByRole("button", { name: /保存/ }).click();
  // DB 断言
  const { rows } = await pool.query(
    `SELECT actor, payload FROM pipeline_events
     WHERE document_id=$1 AND stage='user_edit' AND item_id=$2`,
    [docId, itemId]);
  expect(rows).toHaveLength(1);
  expect(rows[0].actor).toBe("user");
  expect(rows[0].payload).toMatchObject({
    field: "content_md", old: "1+1=?", new: "1+1=2（人工修正）",
  });
  // UI 断言：回到处理日志 tab 能看到 user_edit run
  await page.getByRole("button", { name: "处理日志" }).click();
  await expect(page.getByRole("button", { name: /user_edit · user/ })).toBeVisible();
});

test("t4 by 页：页复核的本页日志面板", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核", exact: true }).click();
  await page.getByLabel("选择文档").selectOption({ label: `traj-${RUN}` });
  // 待复核页列表进入页详情（种子页默认 pending）
  await page.locator(".page-card").first().click();
  await page.getByRole("button", { name: "本页日志" }).click();
  await expect(page.getByText("transcribe qwen3:4b")).toBeVisible();
  // API 断言：by 页过滤正确
  const apiResp = await page.request.get(
    `http://127.0.0.1:8787/api/pages/${pageId}/trajectory`);
  const { events } = await apiResp.json();
  expect(events.length).toBeGreaterThanOrEqual(3);
  for (const ev of events) expect(ev.page_id).toBe(pageId);
});
```

- [ ] **Step 2: 跑 e2e 确认通过**

Run: `cd e2e && npx playwright test specs/trajectory.spec.ts`
Expected: 4 passed（Playwright 自动拉起缺失服务）
注意：t3 的 ItemDetail 编辑交互按其实际按钮文案微调（读 `frontend/src/components/ItemDetail.tsx` 确认「编辑/保存」按钮名）；页图种子可参照 materials-review.spec.ts 落一张占位 PNG。

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/trajectory.spec.ts
git commit -m "test(e2e): trajectory 全链路用例（UI/API/JSONL/DB 字段断言）"
```

---

### Task 12: 收尾——文档与全量回归

**Files:**
- Modify: `AGENTS.md`（资料入库工作流/开发启动附近补一句 trajectory 日志说明）
- Modify: `pipeline/.env.example` 已在 Task 2 更新，此处仅核对

- [ ] **Step 1: 更新 AGENTS.md**

在 `AGENTS.md` 的「资料入库工作流」末尾加一行：

```markdown
6. 处理日志：每次 ingest/structure/approve/编辑/向量化都会写 `pipeline_events`（级别由 `KB_TRAJECTORY_LEVEL=verbose|simple|off` 控制，默认 simple）；
   复核页「处理日志」tab 按文档查 run 时间线，页详情「本页日志」按页查；JSONL 镜像在 `pipeline/storage/<doc_id>/trajectory/<run_id>.jsonl`。
```

（现有第 6 条「落盘镜像」编号顺延为 7。）

- [ ] **Step 2: 全量回归**

```bash
cd pipeline && uv run pytest tests/
cd ../backend && npm test
cd ../frontend && npm test && npm run build
cd ../e2e && npm test
```

Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 补 trajectory 处理日志说明"
```

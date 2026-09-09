# 版面模型可配置（PP-DocLayoutV2/V3，默认 V3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 版面检测模型改为可配置（`KB_LAYOUT_MODEL`，V2/V3，默认 PP-DocLayoutV3），版面切块从 opt-in 变为默认启用，blocks 阅读顺序改用模型输出顺序（显式 `ordinal` 列）。

**Architecture:** 配置层 `kb/core/config.py` 新增 `layout_model` 并改 `layout_engine` 默认值；`kb/ocr/layout.py` 的 `PaddleOCRLayout` 接受 `model_name`、删除 y/x 自排序改为采用模型返回顺序；新增 migration 给 `blocks` 加 `ordinal` 列；读取侧 7 处 `ORDER BY created_at(, id)` 切换到 `ordinal`。

**Tech Stack:** Python 3.13 / pytest / psycopg(PostgreSQL) / paddlepaddle + paddleocr（pyproject 已声明）/ pymupdf。

**Spec:** `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §3.1、§12 用例 15–20。

**前置条件（用户已确认）：** 工作区未提交的 kb 包结构重构先由其 owner 提交落地，本计划在干净树上执行；所有路径按新结构（`kb/ocr/`、`kb/core/`、`kb/rag/`）。

**与 spec 的两处偏差（已确认口径）：**

1. spec §4 把 `ordinal` 放在 `0018_exam_ingest.sql`；本计划先行落地，`ordinal` 拆为独立 migration `0018_block_ordinal.sql`，后续 exam-ingest 计划的 migration 顺延为 `0019` 并去掉 ordinal 段。
2. spec §3.1「模型输出为空时退回 y/x 兜底」：空输出做 y/x 排序仍是空，行为等价——实现直接采用模型返回顺序，空输出返回空列表（不产生块，与现状一致），不保留死代码。

---

### Task 1: 环境前置——安装 paddle 依赖并记录黄金集基线

**Files:**
- Modify: `pipeline/uv.lock`（uv sync 自动更新）

- [ ] **Step 1: 安装依赖**

```bash
cd pipeline && uv sync
```

预期：`paddlepaddle`、`paddleocr` 进入 venv（pyproject 早已声明，本次实际安装，磁盘约 1–2GB）。

- [ ] **Step 2: 验证可导入**

```bash
cd pipeline && uv run python -c "from paddleocr import LayoutDetection; import paddle; print(paddle.__version__)"
```

预期：打印 paddle 版本号，无 ImportError。模型文件本机已缓存（`~/.paddlex/official_models/PP-DocLayoutV2`、`PP-DocLayoutV3`），若缺失首次运行会自动下载（V3 约 125MB）。

- [ ] **Step 3: 记录黄金集基线（供 Task 7 对比）**

```bash
cd pipeline && uv run python -m kb.cli golden-check 8d1d4ed4-d8e1-4006-8ffe-10f9f841f568
```

预期：输出当前引擎下的 CER 与块匹配（IoU）指标；把数字记到 commit message 或临时笔记里，Task 7 对比用。需要本地 PostgreSQL（黄金文档已在库中）与 ollama 就绪；若环境不齐则跳过并在 Task 7 一并说明。

- [ ] **Step 4: Commit**

```bash
cd pipeline && git add uv.lock && git commit -m "chore(pipeline): uv sync 落地 paddle 依赖（paddlepaddle/paddleocr，版面切块前置）"
```

---

### Task 2: `Config.layout_model` 新增与非法值校验

**Files:**
- Modify: `pipeline/kb/core/config.py`
- Modify: `pipeline/.env.example`
- Test: `pipeline/tests/test_config.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_config.py` 末尾追加：

```python
def test_load_config_layout_model(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_LAYOUT_MODEL", raising=False)
    assert load_config(tmp_path / "不存在.env").layout_model == "PP-DocLayoutV3"
    monkeypatch.setenv("KB_LAYOUT_MODEL", "PP-DocLayoutV2")
    assert load_config(tmp_path / "不存在.env").layout_model == "PP-DocLayoutV2"


def test_load_config_layout_model_invalid(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.setenv("KB_LAYOUT_MODEL", "PP-DocLayoutV9")
    with pytest.raises(SystemExit) as exc:
        load_config(tmp_path / "不存在.env")
    assert "PP-DocLayoutV2" in str(exc.value)
    assert "PP-DocLayoutV3" in str(exc.value)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_config.py -k layout_model -v
```

预期：FAIL，`AttributeError: 'Config' object has no attribute 'layout_model'`。

- [ ] **Step 3: 实现**

`pipeline/kb/core/config.py` 三处改动：

模块级常量（放在 import 之后）：

```python
LAYOUT_MODELS = ("PP-DocLayoutV2", "PP-DocLayoutV3")
```

`Config` dataclass 在 `layout_engine` 字段后加一行：

```python
    layout_model: str = "PP-DocLayoutV3"
```

`load_config` 里 `layout_engine=...` 一行之后加校验与赋值：

```python
        layout_model=_layout_model(),
```

并在 `load_config` 前新增函数：

```python
def _layout_model() -> str:
    v = os.environ.get("KB_LAYOUT_MODEL", "PP-DocLayoutV3")
    if v not in LAYOUT_MODELS:
        raise SystemExit(f"非法 KB_LAYOUT_MODEL: {v}（合法值: {' | '.join(LAYOUT_MODELS)}）")
    return v
```

`pipeline/.env.example` 在 `KB_LAYOUT_ENGINE` 一行后加：

```
KB_LAYOUT_MODEL=PP-DocLayoutV3  # PP-DocLayoutV2|PP-DocLayoutV3
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_config.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/core/config.py pipeline/.env.example pipeline/tests/test_config.py
git commit -m "feat(pipeline): KB_LAYOUT_MODEL 配置项（V2|V3，默认 PP-DocLayoutV3，非法值启动报错）"
```

---

### Task 3: `KB_LAYOUT_ENGINE` 默认值改为 paddleocr

**Files:**
- Modify: `pipeline/kb/core/config.py`
- Modify: `pipeline/.env.example`
- Test: `pipeline/tests/test_config.py`

- [ ] **Step 1: 改测试为期望新默认（先红）**

`pipeline/tests/test_config.py` 的 `test_load_config_layout_engine` 改为：

```python
def test_load_config_layout_engine(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_LAYOUT_ENGINE", raising=False)
    assert load_config(tmp_path / "不存在.env").layout_engine == "paddleocr"
    monkeypatch.setenv("KB_LAYOUT_ENGINE", "whole_page")
    assert load_config(tmp_path / "不存在.env").layout_engine == "whole_page"
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_config.py::test_load_config_layout_engine -v
```

预期：FAIL，实际值仍是 `whole_page`。

- [ ] **Step 3: 改默认值**

`pipeline/kb/core/config.py` 两处：

- dataclass 字段：`layout_engine: str = "whole_page"` → `layout_engine: str = "paddleocr"`
- `load_config`：`os.environ.get("KB_LAYOUT_ENGINE", "whole_page")` → `os.environ.get("KB_LAYOUT_ENGINE", "paddleocr")`

`pipeline/.env.example` 对应行改为：

```
KB_LAYOUT_ENGINE=paddleocr  # paddleocr|whole_page（whole_page 为整页占位回退）
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_config.py tests/test_layout.py -v
```

预期：全 PASS（`run_layout` 不传 analyzer 时仍走 `WholePageLayout()` 默认参数，不受影响）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/core/config.py pipeline/.env.example pipeline/tests/test_config.py
git commit -m "feat(pipeline): KB_LAYOUT_ENGINE 默认改 paddleocr——版面切块默认启用，whole_page 仅显式回退"
```

---

### Task 4: `PaddleOCRLayout` 支持 model_name + 缺依赖报错指引

**Files:**
- Modify: `pipeline/kb/ocr/layout.py`
- Test: `pipeline/tests/test_layout_paddleocr.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_layout_paddleocr.py` 末尾追加：

```python
def test_paddleocr_layout_loads_configured_model(tmp_path, monkeypatch):
    """model_name 透传给 LayoutDetection（验收 15/16）。"""
    import sys
    import types

    calls = {}

    class FakeLayoutDetection:
        def __init__(self, model_name):
            calls["model_name"] = model_name

    monkeypatch.setitem(sys.modules, "paddleocr",
                        types.SimpleNamespace(LayoutDetection=FakeLayoutDetection))
    from kb.ocr.layout import PaddleOCRLayout

    PaddleOCRLayout(blocks_dir=tmp_path, model_name="PP-DocLayoutV2")._get_pipeline()
    assert calls["model_name"] == "PP-DocLayoutV2"


def test_paddleocr_layout_default_model_is_v3(tmp_path, monkeypatch):
    """不显式指定时默认 PP-DocLayoutV3（验收 15）。"""
    import sys
    import types

    calls = {}

    class FakeLayoutDetection:
        def __init__(self, model_name):
            calls["model_name"] = model_name

    monkeypatch.setitem(sys.modules, "paddleocr",
                        types.SimpleNamespace(LayoutDetection=FakeLayoutDetection))
    from kb.ocr.layout import PaddleOCRLayout

    PaddleOCRLayout(blocks_dir=tmp_path)._get_pipeline()
    assert calls["model_name"] == "PP-DocLayoutV3"


def test_make_layout_analyzer_passes_model(tmp_path):
    """make_layout_analyzer 把 cfg.layout_model 透传给分析器。"""
    from kb.core.config import Config
    from kb.ocr.layout import PaddleOCRLayout, make_layout_analyzer

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path,
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        layout_engine="paddleocr",
        layout_model="PP-DocLayoutV2",
    )
    analyzer = make_layout_analyzer(cfg)
    assert isinstance(analyzer, PaddleOCRLayout)
    assert analyzer._model_name == "PP-DocLayoutV2"


def test_paddleocr_missing_dependency_message(tmp_path, monkeypatch):
    """缺 paddle 依赖时报错带安装指引，不静默降级（验收：无静默 whole_page 降级）。"""
    import sys

    monkeypatch.setitem(sys.modules, "paddleocr", None)
    from kb.ocr.layout import PaddleOCRLayout

    with pytest.raises(SystemExit) as exc:
        PaddleOCRLayout(blocks_dir=tmp_path)._get_pipeline()
    assert "uv sync" in str(exc.value)
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_layout_paddleocr.py -k "loads_configured_model or default_model_is_v3 or passes_model or missing_dependency" -v
```

预期：FAIL（`TypeError: __init__() got an unexpected keyword argument 'model_name'` 等）。

- [ ] **Step 3: 实现**

`pipeline/kb/ocr/layout.py` 中 `PaddleOCRLayout` 类改为：

```python
class PaddleOCRLayout:
    """PP-DocLayout 版面检测（只切块+分类，不识别内容；识别走③分级解析）。

    模型版本由 KB_LAYOUT_MODEL 配置（PP-DocLayoutV2 | PP-DocLayoutV3，默认 V3）。
    V2/V3 都带指针网络，返回 boxes 的顺序即阅读顺序。模型懒加载。
    选型记录：完整 PaddleOCR-VL 实测 353s/页（CPU）；版面专用模型 V2 实测 ~5s/页，
    V3 按官方 1.6× 推算约 7~8s/页，与本架构分工吻合。
    """

    def __init__(self, blocks_dir: Path, model_name: str = "PP-DocLayoutV3", pipeline=None):
        self._blocks_dir = Path(blocks_dir)
        self._model_name = model_name
        self._pipeline = pipeline  # 测试可注入假模型

    def _get_pipeline(self):
        if self._pipeline is None:
            try:
                from paddleocr import LayoutDetection
            except ImportError as e:
                raise SystemExit(
                    "缺少 paddle 依赖：请在 pipeline/ 下执行 `uv sync` 安装 "
                    "paddlepaddle/paddleocr（pyproject 已声明）；"
                    "或显式设 KB_LAYOUT_ENGINE=whole_page 回退整页模式"
                ) from e
            self._pipeline = LayoutDetection(model_name=self._model_name)
        return self._pipeline
```

`make_layout_analyzer` 改为：

```python
def make_layout_analyzer(cfg) -> LayoutAnalyzer:
    """按配置选版面引擎。"""
    if cfg.layout_engine == "paddleocr":
        return PaddleOCRLayout(blocks_dir=cfg.storage_dir / "blocks",
                               model_name=cfg.layout_model)
    return WholePageLayout()
```

文件顶部 docstring 中「PaddleOCR-VL 实现（精度期）」改为「PP-DocLayout 实现（精度期，模型版本可配）」。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_layout_paddleocr.py tests/test_layout.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/layout.py pipeline/tests/test_layout_paddleocr.py
git commit -m "feat(pipeline): PaddleOCRLayout 模型版本可配（默认 V3），缺依赖报错带安装指引"
```

---

### Task 5: blocks.ordinal 列 + analyze 采用模型输出顺序

**Files:**
- Create: `pipeline/kb/migrations/0018_block_ordinal.sql`
- Modify: `pipeline/kb/ocr/layout.py`
- Test: `pipeline/tests/test_layout_paddleocr.py`
- Test: `pipeline/tests/test_layout.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_layout_paddleocr.py` 末尾追加：

```python
def _write_test_page(path):
    import pymupdf as fitz

    d = fitz.open()
    pg = d.new_page(width=200, height=300)
    pg.insert_text((10, 20), "内容")
    d.save(path)


def test_analyze_keeps_model_reading_order(tmp_path):
    """boxes 坐标乱序返回时，drafts 保持模型返回顺序，ordinal=1..N（验收 18）。"""
    from types import SimpleNamespace

    from kb.ocr.layout import PaddleOCRLayout

    class _FakeOutput:
        json = {"res": {"boxes": [
            {"label": "text", "coordinate": [0, 500, 100, 550]},
            {"label": "paragraph_title", "coordinate": [0, 0, 100, 50]},
            {"label": "footer", "coordinate": [0, 900, 100, 950]},
        ]}}

    class FakePipeline:
        def predict(self, _path):
            return [_FakeOutput()]

    src = tmp_path / "page.png"
    _write_test_page(src)
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks", pipeline=FakePipeline())
    drafts = layout.analyze("p1", str(src))
    # y/x 排序会把 title 排最前；模型顺序保持 text 在最前
    assert [d.block_type for d in drafts] == ["text", "title", "footer"]
    assert [d.ordinal for d in drafts] == [1, 2, 3]


def test_analyze_empty_boxes_returns_no_drafts(tmp_path):
    """模型输出为空时不产生块（与 y/x 兜底行为等价，验收 18 后半）。"""
    from kb.ocr.layout import PaddleOCRLayout

    class _FakeOutput:
        json = {"res": {"boxes": []}}

    class FakePipeline:
        def predict(self, _path):
            return [_FakeOutput()]

    src = tmp_path / "page.png"
    _write_test_page(src)
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks", pipeline=FakePipeline())
    assert layout.analyze("p1", str(src)) == []
```

在 `pipeline/tests/test_layout.py` 末尾追加：

```python
def test_run_layout_writes_ordinal(doc_id, conn):
    """run_layout 落库 ordinal：analyzer 给了用 analyzer 的，没给按返回顺序 1..N。"""
    from kb.ocr.layout import BlockDraft

    _id, _cfg = doc_id

    class FakeTwoBlock:
        def analyze(self, page_id, image_path):
            return [
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1), crop_path="a.png"),
                BlockDraft(page_id=page_id, block_type="figure", bbox=(0, 1, 1, 2), crop_path="b.png"),
            ]

    assert run_layout(conn, _id, analyzer=FakeTwoBlock()) == 2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.ordinal, b.block_type FROM blocks b
               JOIN pages p ON p.id=b.page_id ORDER BY p.page_no, b.ordinal"""
        )
        rows = cur.fetchall()
    assert rows == [(1, "text"), (2, "figure"), (1, "text"), (2, "figure")]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_layout_paddleocr.py::test_analyze_keeps_model_reading_order tests/test_layout.py::test_run_layout_writes_ordinal -v
```

预期：FAIL（`BlockDraft` 无 `ordinal` 字段 / `blocks` 表无 `ordinal` 列）。

- [ ] **Step 3: 实现**

新建 `pipeline/kb/migrations/0018_block_ordinal.sql`：

```sql
ALTER TABLE blocks ADD COLUMN ordinal INTEGER;
UPDATE blocks SET ordinal = sub.rn FROM (
  SELECT id, row_number() OVER (PARTITION BY page_id
         ORDER BY created_at, id) AS rn FROM blocks) sub
  WHERE blocks.id = sub.id;
ALTER TABLE blocks ALTER COLUMN ordinal SET NOT NULL;
```

`pipeline/kb/ocr/layout.py` 改动：

`BlockDraft` 加字段（保持 `bbox` 默认值在最后，把 `ordinal` 放最后）：

```python
@dataclass
class BlockDraft:
    page_id: str
    block_type: str
    crop_path: str
    bbox: tuple[float, float, float, float] | None = None
    ordinal: int | None = None
```

`WholePageLayout.analyze` 改为：

```python
    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        return [BlockDraft(page_id=page_id, block_type="page", bbox=None,
                           crop_path=image_path, ordinal=1)]
```

`PaddleOCRLayout.analyze` 删除 y/x 排序、按模型返回顺序写 ordinal：

```python
    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        output = self._get_pipeline().predict(str(image_path))
        data = output[0].json if hasattr(output[0], "json") else {}
        boxes = (data.get("res") or data).get("boxes", [])
        # PP-DocLayoutV2/V3 自带指针网络，boxes 返回顺序即阅读顺序，直接采用
        out_dir = self._blocks_dir / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        drafts = []
        for i, b in enumerate(boxes, start=1):
            bbox = tuple(b.get("coordinate") or (0, 0, 0, 0))
            crop = out_dir / f"b{i - 1:03d}.png"
            crop_image(image_path, bbox, crop)
            drafts.append(BlockDraft(
                page_id=page_id,
                block_type=map_block_label(b.get("label")),
                bbox=tuple(float(v) for v in bbox),
                crop_path=str(crop),
                ordinal=i,
            ))
        return drafts
```

`run_layout` 的插入循环改为：

```python
        for page_id, image_path in rows:
            for i, draft in enumerate(analyzer.analyze(str(page_id), image_path), start=1):
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, ordinal)
                       VALUES (%s,%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), page_id, draft.block_type,
                     Jsonb(list(draft.bbox)) if draft.bbox is not None else None,
                     draft.crop_path, draft.ordinal or i),
                )
                n += 1
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_layout.py tests/test_layout_paddleocr.py -v
```

预期：全 PASS（conftest 的 `conn` fixture 会跑全部 migration，含 0018）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/migrations/0018_block_ordinal.sql pipeline/kb/ocr/layout.py pipeline/tests/test_layout.py pipeline/tests/test_layout_paddleocr.py
git commit -m "feat(pipeline): blocks.ordinal 显式阅读顺序——采用模型输出顺序，废弃 y/x 自排序"
```

---

### Task 6: 读取侧 ORDER BY 切到 ordinal

**Files:**
- Modify: `pipeline/kb/rag/flat.py`（2 处）
- Modify: `pipeline/kb/rag/assemble.py`
- Modify: `pipeline/kb/rag/export_md.py`
- Modify: `pipeline/kb/rag/structure.py`
- Modify: `pipeline/kb/ocr/golden.py`（2 处）
- Test: `pipeline/tests/test_layout.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_layout.py` 末尾追加：

```python
def test_page_contents_follow_ordinal_not_created_at(doc_id, conn):
    """created_at 与 ordinal 顺序相反时，采用内容按 ordinal 排（验收 14 口径）。"""
    from kb.ocr.layout import BlockDraft
    from kb.rag.flat import page_contents

    _id, _cfg = doc_id

    class FakeTwo:
        def analyze(self, page_id, image_path):
            return [
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1),
                           crop_path="a.png", ordinal=1),
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 1, 1, 2),
                           crop_path="b.png", ordinal=2),
            ]

    assert run_layout(conn, _id, analyzer=FakeTwo()) > 0
    with conn.cursor() as cur:
        # created_at 故意调反：按 created_at 排会是 乙 在前
        cur.execute("UPDATE blocks SET content_md='甲', created_at='2020-01-02' WHERE ordinal=1")
        cur.execute("UPDATE blocks SET content_md='乙', created_at='2020-01-01' WHERE ordinal=2")
        contents = page_contents(cur, _id)
    assert contents[0] == (1, "甲\n乙")
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_layout.py::test_page_contents_follow_ordinal_not_created_at -v
```

预期：FAIL，实际得到 `(1, "乙\n甲")`。

- [ ] **Step 3: 切换 7 处 ORDER BY**

- `pipeline/kb/rag/flat.py:34`：`ORDER BY created_at, id` → `ORDER BY ordinal`
- `pipeline/kb/rag/flat.py:50`：`ORDER BY p.page_no, b.created_at, b.id` → `ORDER BY p.page_no, b.ordinal`
- `pipeline/kb/rag/assemble.py:39`：`ORDER BY created_at, id` → `ORDER BY ordinal`
- `pipeline/kb/rag/export_md.py:23`：`ORDER BY created_at, id` → `ORDER BY ordinal`
- `pipeline/kb/rag/structure.py:51`：`ORDER BY b.created_at` → `ORDER BY b.ordinal`
- `pipeline/kb/ocr/golden.py:107`：`ORDER BY p.page_no, b.created_at` → `ORDER BY p.page_no, b.ordinal`
- `pipeline/kb/ocr/golden.py:135`：`ORDER BY b.created_at` → `ORDER BY b.ordinal`

- [ ] **Step 4: 跑全量 pipeline 测试**

```bash
cd pipeline && uv run pytest tests/ -v
```

预期：全 PASS。若有因"顺序假设"失败的既有用例（插库顺序与期望顺序耦合），按 ordinal 语义修正测试数据，不改回 created_at。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/rag/flat.py pipeline/kb/rag/assemble.py pipeline/kb/rag/export_md.py pipeline/kb/rag/structure.py pipeline/kb/ocr/golden.py pipeline/tests/test_layout.py
git commit -m "feat(pipeline): 阅读顺序读取侧切到 blocks.ordinal（7 处 ORDER BY）"
```

---

### Task 7: V3 真机验证（标签覆盖 + 黄金集回归）

**Files:**
- Test: `pipeline/tests/test_layout_paddleocr.py`

- [ ] **Step 1: 扩写慢测试**

在 `pipeline/tests/test_layout_paddleocr.py` 末尾追加：

```python
@pytest.mark.skipif(os.environ.get("KB_RUN_SLOW") != "1", reason="需要真实模型，KB_RUN_SLOW=1 才跑")
def test_doclayoutv3_labels_covered_on_real_page(tmp_path):
    """真图跑 V3：输出 label 全部有映射（验收 19），ordinal 单调（验收 18）。"""
    from kb.ocr.layout import _LABEL_MAP, PaddleOCRLayout

    page = "../resources/2025秋7星学霸题中题数学4年级第7辑-第6页.png"
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks")
    drafts = layout.analyze("p0006", page)
    assert len(drafts) >= 5
    assert [d.ordinal for d in drafts] == list(range(1, len(drafts) + 1))
    for d in drafts:
        assert os.path.exists(d.crop_path)

    raw = layout._get_pipeline().predict(page)
    data = raw[0].json if hasattr(raw[0], "json") else {}
    labels = {b.get("label") for b in (data.get("res") or data).get("boxes", [])}
    unknown = {l for l in labels if (l or "").lower() not in _LABEL_MAP}
    assert not unknown, f"V3 出现未映射标签（会静默归 text）: {unknown}"
```

注意：现有 `test_paddleocr_layout_on_real_page` 慢测试现在默认跑 V3（Task 4 改了默认模型），其断言（含 text、≥5 块、crop 存在）对 V3 应继续成立；若不成立，先确认是 V3 行为差异还是断言过严，再决定是否调整断言并记录原因。

- [ ] **Step 2: 跑慢测试（真实 V3 模型）**

```bash
cd pipeline && KB_RUN_SLOW=1 uv run pytest tests/test_layout_paddleocr.py -v
```

预期：全 PASS。同时用 `time` 或观察耗时记录 V3 单页耗时——若超过 15s/页，按 spec §13 风险表回报后再继续。

- [ ] **Step 3: 黄金集回归对比（验收 20）**

```bash
cd pipeline && uv run python -m kb.cli golden-check 8d1d4ed4-d8e1-4006-8ffe-10f9f841f568
```

预期：CER 与块匹配指标不劣于 Task 1 Step 3 记录的基线。若劣化，记录两组数字并回报，不强行通过。（Task 1 环境不齐跳过的话，此处只需能跑通并记录 V3 下的指标。）

- [ ] **Step 4: Commit**

```bash
git add pipeline/tests/test_layout_paddleocr.py
git commit -m "test(pipeline): V3 真机验证——标签映射覆盖 + ordinal 单调（KB_RUN_SLOW=1）"
```

---

## 完成判定

- `uv run pytest tests/` 全绿（含 KB_RUN_SLOW=1 的 V3 慢测试）
- 默认配置 ingest 走 PP-DocLayoutV3 切块；`KB_LAYOUT_MODEL=PP-DocLayoutV2` 可切回；非法值启动报错
- `blocks.ordinal` 存在且反映模型阅读顺序；读取侧全部按 ordinal 排序
- 黄金集指标不劣于基线

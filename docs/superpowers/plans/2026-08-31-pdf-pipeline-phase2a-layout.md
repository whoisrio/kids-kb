# PDF 解析流水线 · 精度期 2a 实施计划（版面分析升级 + 分级解析）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 PaddleOCR-VL 替换整页占位版面分析，产出带类型+坐标的真实区块；解析按区块类型分级路由（文本走 rapidocr，公式/图/表走视觉模型）；黄金集升级为区块级回归。

**Architecture:** 不动流水线骨架。`LayoutAnalyzer` 协议新增 `PaddleOCRLayout` 实现（懒加载模型，纯函数可测）；`run_parse` 增加按 `block_type` 的路由；质检加 L2（KaTeX 公式校验，可自动关闭）与 L3（双模型比对，只进不出）。黄金集 `golden-check` 增加 `--level block`（区块数/类型/IoU/CER）。

**Tech Stack:** paddleocr>=3.3（PaddleOCR-VL，可选依赖）/ rapidocr-onnxruntime（已有）/ node + 仓库已 vendor 的 KaTeX（L2 校验）/ pytest。

**范围说明:** 精度期拆分三个计划：2a=本计划（版面+分级解析+质检 L2/L3）；2b=结构化拆分（TOC 词表、章节窗口、跨页合并）；2c=黄金集全面验收与放量。2b 依赖 2a 的区块产出。

**规格来源:** `docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md` §3②③⑤、§7。

---

### Task 1: PaddleOCR-VL 可行性 spike（决策门）

**Files:**
- Modify: `pyproject.toml`
- Create: `backend/scripts/spike_paddleocr.py`

**背景风险:** paddlepaddle 对 macOS arm64 + Python 3.13 的 wheel 支持不确定（`.python-version` 是 3.13）。本任务是决策门：跑不通就走备选（transformers 引擎或远端 VLM 版面分析），不要硬闯。

- [ ] **Step 1: 安装依赖**

`pyproject.toml` 的 `[project.optional-dependencies]` 追加：

```toml
# 版面分析（精度期）；paddlepaddle 平台支持有限，装不上见 spike 任务备选
layout = [
    "paddlepaddle>=3.0",
    "paddleocr>=3.3",
]
```

Run: `uv sync --extra layout`
Expected: 安装成功。**若 paddlepaddle 无 cp313 macOS wheel** → 试 `uv sync --extra layout --python 3.12`；仍失败则记录结论，转备选路线（跳到 Step 4）。

- [ ] **Step 2: spike 脚本**

`backend/scripts/spike_paddleocr.py`：

```python
"""PaddleOCR-VL 可行性 spike：对一页真实扫描页跑版面+识别，打印区块与耗时。

用法: uv run --extra layout python backend/scripts/spike_paddleocr.py [image]
"""
import json
import sys
import time


def main() -> None:
    image = sys.argv[1] if len(sys.argv) > 1 else "page6.png"
    from paddleocr import PaddleOCRVL

    t0 = time.time()
    pipeline = PaddleOCRVL()  # 首次会下载模型（~2GB）
    output = pipeline.predict(image)
    dt = time.time() - t0
    res = output[0]
    data = res.json if hasattr(res, "json") else json.loads(json.dumps(res, default=str))
    blocks = (data.get("res") or data).get("parsing_res_list", [])
    print(f"耗时 {dt:.1f}s，区块数 {len(blocks)}")
    for b in blocks:
        label = b.get("block_label") or b.get("label")
        bbox = b.get("block_bbox") or b.get("bbox")
        content = (b.get("block_content") or b.get("content") or "")[:60].replace("\n", " ")
        print(f"  [{label}] {bbox} {content}")


if __name__ == "__main__":
    main()
```

注：PaddleOCR-VL 输出 JSON 的字段名以实际打印为准（`parsing_res_list`/`block_label`/`block_bbox` 是 3.x 文档字段；若不同，用 `res.save_to_json` 落盘后看结构再调整，并把真实字段名记进 Task 2）。

- [ ] **Step 3: 跑 spike 并记录结果**

Run: `uv run --extra layout python backend/scripts/spike_paddleocr.py resources/2025秋7星学霸题中题数学4年级第7辑-第6页.png`
决策标准（记录到本任务完成说明里）：
- 安装成功且单页耗时 < 5min（CPU）→ 采用，进 Task 2
- 区块能区分 标题/正文/公式/图 且正文识别基本正确 → 采用
- 安装失败或输出不可用 → 备选：`PaddleOCRVL(engine="transformers")`（torch 路线）再试一次；仍不行则改用"远端视觉模型带坐标版面分析"（实现 `RemoteVisionLayout`，prompt 要求输出 JSON 区块列表，接口同为 `LayoutAnalyzer`），后续任务不变

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml uv.lock backend/scripts/spike_paddleocr.py
git commit -m "chore: PaddleOCR-VL 版面分析 spike（决策门）"
```

---

### Task 2: PaddleOCRLayout 实现（layout.py）

**Files:**
- Modify: `backend/kb/layout.py`
- Create: `backend/tests/test_layout_paddleocr.py`

- [ ] **Step 1: 写失败测试（纯函数部分，不依赖模型）**

`backend/tests/test_layout_paddleocr.py`：

```python
import pymupdf as fitz

from kb.layout import crop_image, map_block_label


def test_map_block_label():
    assert map_block_label("text") == "text"
    assert map_block_label("paragraph_title") == "title"
    assert map_block_label("doc_title") == "title"
    assert map_block_label("display_formula") == "formula"
    assert map_block_label("formula") == "formula"
    assert map_block_label("figure") == "figure"
    assert map_block_label("chart") == "figure"
    assert map_block_label("table") == "table"
    assert map_block_label("header") == "header"
    assert map_block_label("footer") == "footer"
    assert map_block_label("seal") == "figure"
    assert map_block_label("没见过的类型") == "text"  # 未知一律当正文，不丢内容


def test_crop_image(tmp_path):
    src = tmp_path / "page.png"
    d = fitz.open()
    pg = d.new_page(width=200, height=100)
    pg.insert_text((10, 20), "上部区域")
    pg.insert_text((10, 80), "下部区域")
    pg.get_pixmap(dpi=144).save(src)  # 200x100pt -> 400x200px

    out = tmp_path / "crop.png"
    crop_image(src, (0, 100, 400, 200), out)  # 只裁下半（像素坐标）
    pix = fitz.Pixmap(str(out))
    assert (pix.width, pix.height) == (400, 100)
    doc = fitz.open(str(out))
    assert "下部区域" in doc[0].get_text()
    assert "上部区域" not in doc[0].get_text()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && uv run pytest tests/test_layout_paddleocr.py -v`
Expected: FAIL，`cannot import name 'crop_image'`

- [ ] **Step 3: 实现**

`backend/kb/layout.py` 追加：

```python
"""阶段②版面分析：可插拔协议 + 整页占位实现（骨架期）+ PaddleOCR-VL 实现（精度期）。"""
# ……保留原有 BlockDraft / LayoutAnalyzer / WholePageLayout / run_layout 不动……

import os
from pathlib import Path

import pymupdf as fitz

_LABEL_MAP = {
    "doc_title": "title",
    "paragraph_title": "title",
    "title": "title",
    "display_formula": "formula",
    "formula": "formula",
    "inline_formula": "formula",
    "figure": "figure",
    "figure_title": "figure",
    "chart": "figure",
    "seal": "figure",
    "table": "table",
    "header": "header",
    "header_image": "header",
    "footer": "footer",
    "footnote": "footer",
}


def map_block_label(label: str) -> str:
    """PaddleOCR-VL 区块标签 -> 我们的 block_type；未知一律 text（不丢内容）。"""
    return _LABEL_MAP.get((label or "").lower(), "text")


def crop_image(src_path, bbox, out_path) -> None:
    """把页面图按 bbox=(x0,y0,x1,y1)（像素）裁出区块图。"""
    doc = fitz.open(str(src_path))
    rect = fitz.Rect(*bbox) & doc[0].rect  # 防止越界
    doc[0].get_pixmap(clip=rect).save(str(out_path))


class PaddleOCRLayout:
    """PaddleOCR-VL 版面分析。模型懒加载（首次实例化 predict 时才起）。"""

    def __init__(self, blocks_dir: Path, pipeline=None):
        self._blocks_dir = Path(blocks_dir)
        self._pipeline = pipeline  # 测试可注入假 pipeline


    def _get_pipeline(self):
        if self._pipeline is None:
            from paddleocr import PaddleOCRVL
            self._pipeline = PaddleOCRVL()
        return self._pipeline

    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        output = self._get_pipeline().predict(str(image_path))
        data = output[0].json if hasattr(output[0], "json") else {}
        raw_blocks = (data.get("res") or data).get("parsing_res_list", [])
        out_dir = self._blocks_dir / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        drafts = []
        for i, b in enumerate(raw_blocks):
            bbox = tuple(b.get("block_bbox") or b.get("bbox") or (0, 0, 0, 0))
            crop = out_dir / f"b{i:03d}.png"
            crop_image(image_path, bbox, crop)
            drafts.append(BlockDraft(
                page_id=page_id,
                block_type=map_block_label(b.get("block_label") or b.get("label")),
                bbox=tuple(float(v) for v in bbox),
                crop_path=str(crop),
            ))
        return drafts
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_layout_paddleocr.py -v`
Expected: 2 passed

- [ ] **Step 5: 模型集成测试（慢，需 KB_RUN_SLOW=1）**

同一文件追加：

```python
import os

import pytest


@pytest.mark.skipif(os.environ.get("KB_RUN_SLOW") != "1", reason="需要下载模型，KB_RUN_SLOW=1 才跑")
def test_paddleocr_layout_on_real_page(tmp_path):
    from kb.layout import PaddleOCRLayout

    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks")
    drafts = layout.analyze("p0006", "../resources/2025秋7星学霸题中题数学4年级第7辑-第6页.png")  # 测试从 backend/ 目录跑
    types = {d.block_type for d in drafts}
    assert "text" in types  # 专题引导正文
    assert len(drafts) >= 5  # 标题/正文/例题/思维导图等
    for d in drafts:
        assert os.path.exists(d.crop_path)
```

Run: `KB_RUN_SLOW=1 uv run --extra layout pytest tests/test_layout_paddleocr.py -v`
Expected:闪现 3 passed

- [ ] **Step 6: Commit**

```bash
git add backend/kb/layout.py backend/tests/test_layout_paddleocr.py
git commit -m "feat: PaddleOCRLayout 版面分析实现（标签映射+区块裁图）"
```

---

### Task 3: 版面引擎配置化接入 run_layout

**Files:**
- Modify: `backend/kb/config.py`
- Modify: `backend/kb/layout.py`（run_layout 加 force 参数）
- Modify: `backend/tests/test_config.py`
- Modify: `backend/tests/test_layout.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_config.py` 追加：

```python
def test_load_config_layout_engine(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_LAYOUT_ENGINE", raising=False)
    assert load_config(tmp_path / "不存在.env").layout_engine == "whole_page"
    monkeypatch.setenv("KB_LAYOUT_ENGINE", "paddleocr")
    assert load_config(tmp_path / "不存在.env").layout_engine == "paddleocr"
```

`backend/tests/test_layout.py` 追加：

```python
def test_run_layout_force_relayouts(conn, tmp_path):
    """force=True 时清掉无复核引用的旧 blocks 重新切版。"""
    import fitz
    from kb.config import Config
    from kb.layout import WholePageLayout, run_layout
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

    class FakeTwoBlock:
        def analyze(self, page_id, image_path):
            from kb.layout import BlockDraft
            return [
                BlockDraft(page_id=page_id, block_type="text", bbox=(0, 0, 1, 1), crop_path="a.png"),
                BlockDraft(page_id=page_id, block_type="figure", bbox=(0, 1, 1, 2), crop_path="b.png"),
            ]

    assert run_layout(conn, doc_id) == 1                      # 整页占位 1 块
    assert run_layout(conn, doc_id, analyzer=FakeTwoBlock()) == 0      # 已有块，跳过
    assert run_layout(conn, doc_id, analyzer=FakeTwoBlock(), force=True) == 2  # 重切
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_config.py tests/test_layout.py -v`
Expected: FAIL（`layout_engine` 属性不存在；`force` 参数不存在）

- [ ] **Step 3: 实现**

`backend/kb/config.py`：`Config`熟练 dataclass 加字段 `layout_engine: str = "whole_page"`，`load_config` 里加 `layout_engine=os.environ.get("KB_LAYOUT_ENGINE", "whole_page"),`。`.env.example` 加一行 `KB_LAYOUT_ENGINE=whole_page  # whole_page|paddleocr`。

`backend/kb/layout.py` 的 `run_layout` 改为：

```python
def run_layout(conn, doc_id: str, analyzer: LayoutAnalyzer | None = None,
               force: bool = False) -> int:
    analyzer = analyzer or WholePageLayout()
    with conn.cursor() as cur:
        if force:
            # 只清没有复核引用的块；有复核记录的页保持原样（人工痕迹不丢）
            cur.execute(
                """DELETE FROM blocks b USING pages p
                   WHERE b.page_id = p.id AND p.document_id=%s
                   AND NOT EXISTS (SELECT 1 FROM review_queue r WHERE r.block_id=b.id)""",
                (doc_id,),
            )
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


def make_layout_analyzer(cfg) -> LayoutAnalyzer:
    """按配置选版面引擎。"""
    if cfg.layout_engine == "paddleocr":
        return PaddleOCRLayout(blocks_dir=cfg.storage_dir / "blocks")
    return WholePageLayout()
```

`backend/kb/pipeline.py` 的 `ingest` 里 `run_layout(conn, doc_id)` 改为 `run_layout(conn, doc_id, analyzer=make_layout_analyzer(cfg))`。

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_config.py tests/test_layout.py tests/test_pipeline.py -v`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add backend/kb/config.py backend/kb/layout.py backend/kb/pipeline.py backend/tests/ .env.example
git commit -m "feat: 版面引擎配置化（KB_LAYOUT_ENGINE）与 force 重切版"
```

---

### Task 4: 分级解析路由（parse.py）

**Files:**
- Modify: `backend/kb/parse.py`
- Modify: `backend/tests/test_parse.py`

**设计:** `text/title/header/footer` → rapidocr（本地免费）；`formula/figure/table/page` → 视觉模型（现 transcribe_image）。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_parse.py` 追加：

```python
def test_ocr_text_blocks_with_rapidocr(tmp_path):
    """rapidocr 真能认出渲染出来的文字（本地 ONNX，无需模型服务）。"""
    import fitz
    from kb.parse import ocr_image

    img = tmp_path / "t.png"
    d = fitz.open()
    pg = d.new_page()
    pg.insert_text((36, 72), "乘除法竖式谜", fontsize=24)
    pg.get_pixmap(dpi=150).save(img)
    text = ocr_image(img)
    assert "乘除法竖式谜" in text.replace(" ", "")


def test_run_parse_routes_by_block_type(conn, parsed_doc):
    """text 块走 ocr（不调视觉模型），formula 块走视觉模型。"""
    import kb.parse as parse_mod

    doc_id, cfg = parsed_doc
    calls = []

    class SpyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                calls.append(model)
                class M: content = "视觉结果"
                class C: message = M()
                class R: choices = [C()]
                return R()

    class SpyClient:
        chat = SpyChat()

    with conn.cursor() as cur:  # 把第 1 块改成 text，第 2 块改成 formula
        cur.execute("SELECT id FROM blocks ORDER BY created_at LIMIT 2")
        b1, b2 = [r[0] for r in cur.fetchall()]
        cur.execute("UPDATE blocks SET block_type='text' WHERE id=%s", (b1,))
        cur.execute("UPDATE blocks SET block_type='formula' WHERE id=%s", (b2,))

    def fake_ocr(image_path):
        calls.append("ocr")
        return "OCR结果"

    n = parse_mod.run_parse(conn, cfg, doc_id, client=SpyClient(), ocr=fake_ocr)
    assert n == 2
    assert calls.count("ocr") == 1      # text 块走 ocr
    assert calls.count(cfg.vision_model) == 1  # formula 块走视觉模型
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_parse.py -v`
Expected: FAIL（`ocr_image` 不存在 / `run_parse` 无 `ocr` 参数）

- [ ] **Step 3: 实现**

`backend/kb/parse.py` 追加与修改：

```python
# 走本地 rapidocr 的区块类型；其余（formula/figure/table/page）走视觉模型
_OCRABLE_TYPES = {"text", "title", "header", "footer"}

_ocr_engine = None


def _get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def ocr_image(image_path) -> str:
    """rapidocr 识别区块图像，按阅读顺序（y 后 x）拼接文本行。"""
    result, _ = _get_ocr_engine()(str(image_path))
    if not result:
        return ""
    lines = sorted(result, key=lambda r: (round(r[0][0][1] / 10), r[0][0][0]))
    return "\n".join(r[1] for r in lines)
```

`run_parse` 签名与循环改为：

```python
def run_parse(conn, cfg: Config, doc_id: str, client=None, ocr=None) -> int:
    """按区块类型分级解析；单块失败不中断。返回成功解析的 block 数。"""
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    ocr = ocr or ocr_image
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.crop_path, b.page_id, b.block_type FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND b.content_md IS NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for block_id, crop_path, page_id, block_type in rows:
            try:
                if block_type in _OCRABLE_TYPES:
                    text = ocr(crop_path)
                else:
                    text = transcribe_image(client, cfg.vision_model, crop_path)
            except Exception as e:  # noqa: BLE001 - 单块失败不中断
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
Expected: 全部通过（含新增 2 个）

- [ ] **Step 5: Commit**

```bash
git add backend/kb/parse.py backend/tests/test_parse.py
git commit -m "feat: 解析按区块类型分级路由（rapidocr/视觉模型）"
```

---

### Task 5: 质检 L2——LaTeX 可编译校验（bad_latex）

**Files:**
- Create: `backend/scripts/katex_check.cjs`
- Modify: `backend/kb/qc.py`
- Modify: `backend/tests/test_qc.py`

- [ ] **Step 1: 写失败测试**

`backend/tests/test_qc.py` 追加：

```python
def test_check_content_flags_bad_latex():
    from kb.qc import check_content
    assert "bad_latex" in check_content("公式坏了：$\\frac{1$ 缺括号")
    assert check_content("公式正常：$\\frac{1}{2}$ 和 $$x^2$$") == []


def test_bad_latex_auto_resolves_after_fix(conn, tmp_path):
    """bad_latex 属可机器复判原因：修复后 resolve_block_reviews 自动关闭。"""
    from kb.config import Config
    from kb.layout import run_layout
    from kb.qc import resolve_block_reviews
    from kb.render import render_document
    import fitz

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
        cur.execute("UPDATE blocks SET content_md='坏公式 $\\frac{1$'")
        cur.execute("SELECT id FROM blocks")
        block_id = str(cur.fetchone()[0])
        cur.execute("INSERT INTO review_queue (block_id, reason) VALUES (%s,'bad_latex')", (block_id,))
        cur.execute("UPDATE blocks SET content_md='修好了 $\\frac{1}{2}$'")
    assert resolve_block_reviews(conn, block_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='bad_latex'")
        assert cur.fetchone()[0] == "approved"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_qc.py -v`
Expected: FAIL（bad_latex 未检出 / 未自动关闭）

- [ ] **Step 3: 实现**

`backend/scripts/katex_check.cjs`（复用仓库已 vendor 的 KaTeX，批量校验，stdin 收 JSON 数组，stdout 出布尔数组）：

```js
// 批量校验 LaTeX 可渲染性。stdin: ["x^2", "\\frac{1"] -> stdout: [true, false]
const katex = require("../kb/static/vendor/katex/katex.min.js");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const formulas = JSON.parse(input);
  const out = formulas.map((tex) => {
    try {
      katex.renderToString(tex, { throwOnError: true, strict: false });
      return true;
    } catch (e) {
      return false;
    }
  });
  process.stdout.write(JSON.stringify(out));
});
```

`backend/kb/qc.py` 修改：

```python捣
import json
import re
import subprocess
from pathlib import Path

_TRUNCATION_ENDINGS = ("…", "...", "，", "、", "；", "：")
_KATEX_CHECK = Path(__file__).parent.parent / "scripts" / "katex_check.cjs"
_MATH_RE = re.compile(r"\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$")

# 机器可检测的原因：只有这些允许自动关闭；人工插入的自定义原因必须人显式 通过/打回
CHECKABLE_REASONS = frozenset({"empty", "maybe_truncated", "bad_latex"})


def check_latex(content: str) -> bool:
    """所有公式能被 KaTeX 渲染才返回 True；node 不可用则跳过（不误报）。"""
    formulas = [m.group(1) or m.group(2) for m in _MATH_RE.finditer(content)]
    if not formulas or not _KATEX_CHECK.exists():
        return True
    try:
        proc = subprocess.run(
            ["node", str(_KATEX_CHECK)], input=json.dumps(formulas),
            capture_output=True, text=True, timeout=30,
        )
        results = json.loads(proc.stdout)
    except Exception:
        return True
    return all(results)


def check_content(content: str | None) -> list[str]:
    if not content or not content.strip():
        return ["empty"]
    reasons = []
    if content.rstrip().endswith(_TRUNCATION_ENDINGS):
        reasons.append("maybe_truncated")
    if not check_latex(content):
        reasons.append("bad_latex")
    return reasons
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_qc.py -v`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/katex_check.cjs backend/kb/qc.py backend/tests/test_qc.py
git commit -m "feat: 质检 L-----------2，LaTeX 可编译校验（bad_latex，可自动关闭）"
```

---

### Task 6: 质检 L3——双模型比对（llm_disagree）

**Files:**
- Modify: `backend/kb/config.py`
- Create: `backend/kb/crosscheck.py`
- Modify: `backend/kb/pipeline.py`
- Create: `backend/tests/test_crosscheck.py`

**设计:** 全部 formula/figure/table 块 + 文本块按 block_id 哈希稳定抽 5%；用比对渠道（`KB_VISION_COMPARE_*`，未配置则跳过）重转录；与首次结果算 CER，>0.2 建 `llm_disagree` 复核行。**llm_disagree 不进 CHECKABLE_REASONS**（复判要再花模型调用，留人工）。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_crosscheck.py`：

```python
import fitz
import pytest


def _mk_cfg(tmp_path, compare_model="compare-model"):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="primary-model",
        vision_compare_model=compare_model,
    )


@pytest.fixture()
def doc_with_blocks(conn, tmp_path):
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _mk_cfg(tmp_path)
    p = tmp_path / "s.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET block_type='formula', content_md='正确内容 $1+1=2$'")
    return doc_id, cfg


def _client(text):
    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M: content = text
                class C: message = M()
                class R: choices = [C()]
                return R()
    class Client:
        chat = Chat()
    return Client()


def test_crosscheck_flags_divergent_formula_block(conn, doc_with_blocks):
    from kb.crosscheck import run_llm_crosscheck

    doc_id, cfg = doc_with_blocks
    n = run_llm_crosscheck(conn, cfg, doc_id, compare_client=_client("完全不同的内容"))
    assert n == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason, status FROM review_queue")
        assert cur.fetchone() == ("llm_disagree", "pending")


def test_crosscheck_quiet_when_consistent(conn, doc_with_blocks):
    from kb.crosscheck import run_llm_crosscheck

    doc_id, cfg = doc_with_blocks
    n = run_llm_crosscheck(conn, cfg, doc_id, compare_client=_client("正确内容 $1+1=2$"))
    assert n == 0


def test_llm_disagree_not_auto_closed(conn, doc_with_blocks):
    """llm_disagree 不在 CHECKABLE_REASONS：内容再编辑也不自动关闭。"""
    from kb.qc import resolve_block_reviews

    doc_id, cfg = doc_with_blocks
    with conn.cursor() as cur:
        cur.execute("INSERT INTO review_queue (block_id, reason) SELECT id, 'llm_disagree' FROM blocks")
        cur.execute("SELECT id FROM blocks")
        block_id = str(cur.fetchone()[0])
    assert resolve_block_reviews(conn, block_id) ==  0
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='llm_disagree'")
        assert cur.fetchone()[0] == "pending"


def test_crosscheck_skipped_without_compare_config(conn, tmp_path, monkeypatch):
    from kb.crosscheck import run_llm_crosscheck

    cfg = _mk_cfg(tmp_path, compare_model=None)
    assert run_llm_crosscheck(conn, cfg, "任意doc") == 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_crosscheck.py -v`
Expected: FAIL（`kb.crosscheck` 不存在 / `Config` 无 `vision_compare_model`）

- [ ] **Step 3: 实现**

`backend/kb/config.py`：`Config` 加字段 `vision_compare_model: str | None = None`；`load_config` 加 `vision_compare_model=os.environ.get("KB_VISION_COMPARE_MODEL") or None,`。`.env.example` 加 `KB_VISION_COMPARE_MODEL=  # 双模型比对的第二渠道，留空则跳过 L3`。

`backend/kb/crosscheck.py`：

```python
"""质检 L3：双模型比对。

全部 formula/figure/table 块必查；text 块按 block_id 哈希稳定抽 5%。
用第二渠道（KB_VISION_COMPARE_*）重转录，与首次结果 CER>0.2 建 llm_disagree 复核行。
llm_disagree 属人工裁决类，不进 CHECKABLE_REASONS，不会随内容编辑自动关闭。
"""
from __future__ import annotations

import uuid

from openai import OpenAI

from kb.config import Config
from kb.golden import char_error_rate
from kb.parse import transcribe_image

_ALWAYS_TYPES = {"formula", "figure", "table"}
_SAMPLE_MOD = 20  # text 块抽 1/20 = 5%
_CER_THRESHOLD = 0.2


def _sampled(block_id: str, block_type: str) -> bool:
    if block_type in _ALWAYS_TYPES:
        return True
    return uuid.UUID(block_id).int % _SAMPLE_MOD == 0


def run_llm_crosscheck(conn, cfg: Config, doc_id: str, compare_client=None,
                       threshold: float = _CER_THRESHOLD) -> int:
    """返回新增 llm_disagree 复核行数。"""
    if not cfg.vision_compare_model:
        return 0
    client = compare_client or OpenAI(base_url=cfg.vision_base_url,
                                      api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.crop_path, b.content_md, b.block_type FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND p.status='parsed' AND b.content_md IS NOT NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        n = 0
        for block_id, crop_path, content, block_type in cur.fetchall():
            if not _sampled(str(block_id), block_type):
                continue
            cur.execute(
                "SELECT 1 FROM review_queue WHERE block_id=%s AND reason='llm_disagree'",
                (block_id,),
            )
            if cur.fetchone():
                continue  # 幂等：已有记录不重复比对
            second = transcribe_image(client, cfg.vision_compare_model, crop_path)
            if char_error_rate(content, second) <= threshold:
                continue
            cur.execute(
                "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,'llm_disagree')",
                (str(uuid.uuid4()), block_id),
            )
            n += 1
    return n
```

`backend/kb/pipeline.py`：`ingest` 末尾 `run_qc(conn, doc_id)` 后加：

```python
    from kb.crosscheck import run_llm_crosscheck
    run_llm_crosscheck(conn, cfg, doc_id)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_crosscheck.py tests/test_qc.py -v`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add backend/kb/crosscheck.py backend/kb/config.py backend/kb/pipeline.py backend/tests/test_crosscheck.py .env.example
git commit -m "feat: 质检 L3 双模型比对（llm_disagree，人工裁决不自动关闭）"
```

---

### Task 7: 黄金集区块级回归（golden.py --level block）

**Files:**
- Modify: `backend/kb/golden.py`
- Modify: `backend/kb/cli.py`
- Modify: `backend/tests/test_golden.py`

**设计:** 黄金集标注升级为区块级 JSON：`golden/<doc_id>/p0006.blocks.json`，每条 `{block_type, bbox, content_md}`。`golden-annotate` 导出当前预测供人工修正；`golden-check --level block` 对比：区块数一致率、类型准确率、bbox IoU≥0.5 匹配率、内容 CER。

- [ ] **Step 1: 写失败测试**

`backend/tests/test_golden.py` 追加：

```python
def test_iou():
    from kb.golden import iou
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert 0.3 < iou((0, 0, 10, 10), (5, 0, 15, 10)) < 0.4  # 交集5x10/并集15x10=1/3


def test_match_blocks_greedy():
    from kb.golden import match_blocks
    golden = [
        {"block_type": "title", "bbox": [0, 0, 10, 5]},
        {"block_type": "text", "bbox": [0, 6, 10, 20]},
    ]
    pred = [
        {"block_type": "title", "bbox": [0, 0, 10, 5]},
        {"block_type": "text", "bbox": [0, 7, 10, 20]},   # 稍微偏一点
        {"block_type": "figure", "bbox": [50, 50, 60, 60]},  # 多出的块
    ]
    matched, missing, extra = match_blocks(golden, pred, iou_threshold=0.5)
    assert len(matched) == 2 and len(missing) == 0 and len(extra) == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_golden.py -v`
Expected: FAIL（`iou`/`match_blocks` 不存在）

- [ ] **Step 3: 实现**

`backend/kb/golden.py` 追加：

```python
def iou(a, b) -> float:
    """两个 (x0,y0,x1,y1) 框的交并比。"""
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area = lambda r: (r[2] - r[0]) * (r[3] - r[1])
    union = area(a) + area(b) - inter
    return inter / union if union > 0 else 0.0


def match_blocks(golden: list[dict], pred: list[dict], iou_threshold: float = 0.5):
    """贪心匹配：按 IoU 降序配对。返回 (matched对列表, missing, extra)。"""
    pairs = []
    for gi, g in enumerate(golden):
        for pi, p in enumerate(pred):
            if g.get("bbox") and p.get("bbox"):
                pairs.append((iou(g["bbox"], p["bbox"]), gi, pi))
    pairs.sort(reverse=True)
    used_g, used_p, matched = set(), set(), []
    for score, gi, pi in pairs:
        if score < iou_threshold or gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        matched.append((gi, pi))
    missing = [gi for gi in range(len(golden)) if gi not in used_g]
    extra = [pi for pi in range(len(pred)) if pi not in used_p]
    return matched, missing, extra


def check_blocks(conn, doc_id: str, golden_dir: Path) -> dict:
    """区块级回归：类型准确率 / IoU 匹配率 / 内容 CER。打印并返回指标。"""
    golden_dir = golden_dir / doc_id
    all_matched = all_missing = all_extra = 0
    type_ok = 0
    cers = []
    with conn.cursor() as cur:
        for gf in sorted(golden_dir.glob("p*.blocks.json")):
            page_no = int(gf.stem.split(".")[0][1:])
            cur.execute(
                """SELECT b.block_type, b.bbox, b.content_md FROM blocks b
                   JOIN pages p ON p.id=b.page_id
                   WHERE p.document_id=%s AND p.page_no=%s ORDER BY b.created_at""",
                (doc_id, page_no),
            )
            pred = [{"block_type": t, "bbox": bb, "content_md": c} for t, bb, c in cur.fetchall()]
            golden = json.loads(gf.read_text(encoding="utf-8"))
            matched, missing, extra = match_blocks(golden, pred)
            all_matched += len(matched)
            all_missing += len(missing)
            all_extra += len(extra)
            for gi, pi in matched:
                if golden[gi]["block_type"] == pred[pi]["block_type"]:
                    type_ok += 1
                cers.append(char_error_rate(golden[gi].get("content_md", ""),
                                            pred[pi].get("content_md") or ""))
            print(f"page {page_no}: 匹配 {len(matched)} 漏 {len(missing)} 多 {len(extra)}")
    total = all_matched + all_missing
    metrics = {
        "match_rate": all_matched / total if total else 1.0,
        "type_accuracy": type_ok / all_matched if all_matched else 1.0,
        "content_cer": sum(cers) / len(cers) if cers else 1.0,
    }
    print(f"区块匹配率={metrics['match_rate']:.3f} 类型准确率={metrics['type_accuracy']:.3f} 内容CER={metrics['content_cer']:.3f}")
    return metrics
```

文件头部 import 处补 `import json`。

`backend/kb/golden.py` 再加导出函数：

```python
def annotate(conn, doc_id: str, golden_dir: Path) -> list[Path]:
    """导出当前区块预测为人工标注底稿 pNNNN.blocks.json。"""
    golden_dir = golden_dir / doc_id
    golden_dir.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.page_no, b.block_type, b.bbox, b.content_md FROM blocks b
               JOIN pages p ON p.id=b.page_id
               WHERE p.document_id=%s ORDER BY p.page_no, b.created_at""",
            (doc_id,),
        )
        pages: dict[int, list] = {}
        for page_no, btype, bbox, content in cur.fetchall():
            pages.setdefault(page_no, []).append(
                {"block_type": btype, "bbox": bbox, "content_md": content})
        out = []
        for page_no, blocks in pages.items():
            path = golden_dir / f"p{page_no:04d}.blocks.json"
            path.write_text(json.dumps(blocks, ensure_ascii=False, indent=2),
                            encoding="utf-8")
            out.append(path)
    return out
```

`backend/kb/cli.py` 加子命令：

```python
    p_anno = sub.add_parser("golden-annotate")
    p_anno.add_argument("doc_id")
    p_anno.add_argument("--dir", default="golden")
```

分发处加：

```python
    elif args.cmd == "golden-annotate":
        from kb.golden import annotate
        out = annotate(conn, args.doc_id, Path(args.dir))
        print(f"导出 {len(out)} 页区块标注底稿，请人工校对: {args.dir}/{args.doc_id}/")
```

并给 `golden-check` 加 `--level` 参数（默认 `page`，`block`&.golden 走新区块比对）：

```python
    p_check.add_argument("--level", default="page", choices=["page", "block"])
```

分发处 `golden-check` 分支改为：

```python
    elif args.cmd == "golden-check":
        from kb.golden import check, check_blocks
        if args.level == "block":
            check_blocks(conn, args.doc_id, Path(args.dir))
        else:
            check(conn, cfg, args.doc_id, Path(args.dir))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_golden.py -v`
Expected: 全部通过

- [ ] **Step 5: 黄金集区块标注（人工步骤）**

```bash
# 对黄金集所在书重切版并重解析后：
uv run python -m kb.cli golden-annotate <doc_id>
# 人工校对 golden/<doc_id>/pNNNN.blocks.json（对照 storage 里的裁图）
uv run python -m kb.cli golden-check <doc_id> --level block
```

Expected: 打印匹配率/类型准确率/内容 CER，作为精度期验收基线（目标：匹配率≥95%，见设计文档 §7）。

- [ ] **Step 6: Commit**

```bash
git add backend/kb/golden.py backend/kb/cli.py backend/tests/test_golden.py
git commit -m "feat: 黄金集区块级回归（iou 匹配/类型准确率/内容 CER）"
```

---

### Task 8: 全量回归与真实数据验证

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest -q`
Expected: 全绿

- [ ] **Step 2: 真实书小范围端到端（paddleocr 引擎）**

```bash
# .env 里 KB_LAYOUT_ENGINE=paddleocr
uv run python -m kb.cli ingest "resources/2025秋7星学霸题中题数学4年级第7辑.pdf" \
  --title "7星学霸题中题数学4年级第7辑" --subject 数学 --grade 四年级 --start 6 --end 10
```

Expected: pages 6-10 出真实区块；`SELECT block_type, count(*) FROM blocks GROUP BY 1` 有多种类型；review_queue 里 bad_latex/llm_disagree（若配置了比对渠道）符合预期。

- [ ] **Step 3: README 更新**

`## 流水线` 一节补充：版面引擎开关 `KB_LAYOUT_ENGINE=paddleocr`（需 `uv sync --extra layout`）、比对渠道 `KB_VISION_COMPARE_MODEL`、黄金集区块级用法（golden-annotate / golden-check --level block）。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: 精度期 2a 用法（版面引擎/双模型比对/区块级黄金集）"
```

---

## Self-Review 记录

- **规格覆盖**：§3② 版面分析（Task 1-3）✓；§3③ 分级解析（Task 4）✓；§7 L2 bad_latex（Task 5）✓、L3 llm_disagree（Task 6）✓；黄金集区块指标（Task 7，对应设计 §7 验收）✓。结构化拆分/TOC/跨页合并明确属 2b 计划，非缺口。
- **占位符扫描**：无 TBD/TODO；spike 任务的 PaddleOCR-VL 输出字段名标注了"以实际打印为准"的调整指引（模型输出 schema 只能实跑确认，这是任务本身的目的）。
- **类型一致性**：`BlockDraft(page_id, block_type, bbox, crop_path)`、`run_layout(conn, doc_id, analyzer=None, force=False)`、`run_parse(conn, cfg, doc_id, client=None, ocr=None)`、`run_llm_crosscheck(conn, cfg, doc_id, compare_client=None, threshold=0.2)`、`check_blocks(conn, doc_id, golden_dir)`、`annotate(conn, doc_id, golden_dir)`、`Config(..., layout_engine, vision_compare_model)` 在定义处与调用处一致。

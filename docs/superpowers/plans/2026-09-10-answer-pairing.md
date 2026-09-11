# 试卷答案字段化 + 卷末答案关联 + 答案关联 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exam 拆题不再让 LLM 给答案：LLM 只拆题，卷末答案由确定性代码做「版面定位 → 连排切分 → 子题再切 → 题号对齐」，答案写进 `items.answer_md/answer_conf/answer_state`（不建独立 answer item、不进向量），复核 UI 加「答案关联」屏（对齐表 + 采纳/手工指定/标记无答案）。

**Architecture:** migration `0021_answer_fields.sql` 给 items 加答案三字段；pipeline 新增纯确定性模块 `kb/rag/answer_align.py`（四步链，无 LLM 调用），`structure_exam.py` 去掉 prompt 的 answer_md 要求、不再产 answer item、收尾改调 answer_align；`embed_approved_items` 补 content_type 过滤堵现状 bug；backend 透出答案字段并加对齐表查询 + 三个操作端点（纯 DB，全部写 pipeline_events，不动 chunks）；frontend 在 MaterialsView 加「答案关联」tab，三栏照 `scr-answers`。

**Tech Stack:** pipeline: Python 3.13 / pytest / psycopg；backend: TS / Hono / vitest（真库）；frontend: React / vitest + @testing-library（jsdom）；e2e: Playwright。

**Spec:** `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §4（items.answer_* 部分）、§8、§11.4、§12 用例 1–2 和 8、§14（编号约定）。
视觉/交互细节以 `docs/design/review-workbench.html` 屏 4（`#scr-answers`，约 :882-1057）为唯一事实源。

**前置（已核实，可直接采信）：** 子系统 1–3 已完成（`blocks.ordinal`、`crop_pad`、块编辑四操作；migration 最新为 `0020_block_editing.sql`，本计划用 **0021**）。
可复用零件：`run_exam_structure`（`pipeline/kb/rag/structure_exam.py:156`）逐 section 调 `extract_section`（:80），`EXAM_PROMPT`（:20-31）现要求 LLM 输出 `answer_md`，落库 :133-146 每题产 exercise + answer 两条独立 item，收尾调 `pair_items`（:192）并把 `documents.struct_mode` 写成 `'toc'`；`pair_items`（`pipeline/kb/rag/structure.py:144-164`）纯 label 精确相等双向回写，仅 workbook 路径保留；`page_contents`（`pipeline/kb/rag/flat.py:18`，页序拼接、跳 header/footer）；`_parse_json_array`（`pipeline/kb/rag/toc.py`）；`embed_approved_items`（`pipeline/kb/rag/embed.py:29-62`，SQL 无 content_type 过滤——spec §8.1 点名的现状 bug）；`Recorder.decision` 支持 `item_id`（`pipeline/kb/telemetry/traj.py:58`）；`review_queue` 支持 item_id/block_id/reason 锚定且同锚同因 pending 去重有先例（`pipeline/kb/ocr/qc.py:117`）；`item_blocks.role ∈ ('stem','figure','solution')`，PK(item_id, block_id, role)。
backend：`GET /items`（`backend/src/routes/review.ts:181`，仅支持 status=pending）、`GET /items/:id`（:207）、`PATCH /items/:id`（:555，改 content_md 后 DELETE chunks——答案操作**不照抄**这条）、`forwardInternal`（:634）、`invalidId`（:17）、`readJson`（:240）、页图 `/api/review/pages/:id/image`（:131）、块裁图 `/api/review/blocks/:id/crop`（:147）。
frontend：`MaterialsView.tsx` 现有 6 个 tab（:11-15，Block 类型 + TABS 表）、api 客户端 `req/json` 模式（`frontend/src/api/review.ts:76-87`）、类型 `ReviewItemSummary`/`ReviewItemDetail`（:51/:62）无答案字段；组件测试 fetch 桩用 `frontend/src/test/support.ts` 的 `fetchRouter`。

**锁定决策（执行者不要改动，有异议先回报）：**

1. **答案关联从 LLM 手里收归确定性代码**：`EXAM_PROMPT` 不再要求 `answer_md`（LLM 只拆题），卷末答案由新模块 `pipeline/kb/rag/answer_align.py` 走 spec §8.2 四步：①版面定位（块文本匹配 `^(参考答案|答案|参考答案及解析)$` 标题块，锁定该页到卷末为答案区）②连排切分（题号正则 `(\d+)[.、．]` 切 N 段）③子题再切（`（n）` 二级，产出 `15(1)/15(2)`）④题号对齐（与 `items.label` 匹配）。
   跨页答案按页序拼接后再切（§8.3），不按页分别切。
2. **置信度确定性规则**：题号精确唯一匹配且答案段非空 → 0.95（`paired`）；匹配但答案段疑似残缺（去空白 <2 字符或纯标点）→ 0.7（`suggested`）；题号在答案区找不到 → `pending`（answer 留空，conf 记 NULL）；一对多歧义（同题号切出多段）→ 0.5（`suggested`）。
   状态由规则直接给出，**不是由 conf 反推**：spec §8.2 的阈值档（≥0.85 paired / 0.60–0.85 suggested / <0.60 pending）是 UI 展示参考与 conf 写入语义，歧义档 conf=0.5 落 `suggested` 是本计划对阈值表的显式例外（低置信但仍有候选，应进待确认队列而不是丢成未配对），此处记录即生效。
3. **不再为卷末答案建独立 item**：exam 路径只产 exercise item，答案写 `items.answer_md/answer_conf/answer_state`；存量 `content_type='answer'` item 不迁移、不再向量化（`embed_approved_items` 加 `content_type <> 'answer'` 过滤，§8.1）；workbook 路径的 `pair_items` 保留不动。
4. **答案来源块复用 `item_blocks role='solution'`** 记录（自动对齐有来源块时即写；手工指定答案块即写此关联），不建新表。
5. **改答案不触发 chunk 重建**（§8.1：答案不进向量，当 payload）——答案操作端点不标 stale、不动 chunks（revision 机制归子系统 5）。
6. **未配对不阻塞入库**（`answer_state='pending'` 照常 approve/向量化，§8.2）。
7. migration 用 `0021_answer_fields.sql`：`items ADD answer_md TEXT / answer_conf REAL / answer_state TEXT NOT NULL DEFAULT 'none'`（枚举注释 none|suggested|paired|confirmed|pending|rejected）。

---

### Task 1: migration 0021——items 答案三字段

**Files:**
- Create: `pipeline/kb/migrations/0021_answer_fields.sql`
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md`（§14 状态表 + 编号约定行）
- Test: `pipeline/tests/test_migration_0021.py`

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_migration_0021.py`：

```python
"""0021：items 答案字段（spec §4 answer_* 部分，子系统 4）。"""


def test_0021_answer_columns_exist_with_defaults(conn):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/a.pdf') RETURNING id::text"
        )
        doc_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO items (document_id, content_type, label, content_md)"
            " VALUES (%s, 'exercise', '9', '题') RETURNING id::text",
            (doc_id,),
        )
        item_id = cur.fetchone()[0]
        cur.execute(
            "SELECT answer_md, answer_conf, answer_state FROM items WHERE id=%s",
            (item_id,),
        )
        assert cur.fetchone() == (None, None, "none")  # 存量默认：无答案
        # 三字段可写
        cur.execute(
            "UPDATE items SET answer_md='160', answer_conf=0.95, answer_state='paired' WHERE id=%s",
            (item_id,),
        )
        cur.execute(
            "SELECT answer_md, answer_conf, answer_state FROM items WHERE id=%s",
            (item_id,),
        )
        row = cur.fetchone()
        assert row[0] == "160" and abs(row[1] - 0.95) < 1e-6 and row[2] == "paired"
        # revision 归子系统 5，本 migration 不加
        cur.execute(
            "SELECT 1 FROM pg_attribute WHERE attrelid='items'::regclass AND attname='revision'"
        )
        assert cur.fetchone() is None
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_migration_0021.py -v
```

预期：FAIL，`column "answer_md" does not exist`。

- [ ] **Step 3: 写 migration**

新建 `pipeline/kb/migrations/0021_answer_fields.sql`：

```sql
-- 0021：题目级答案字段（spec §4/§8.1）——答案只作题目 chunk 的 payload 字段，不单独拥有向量
ALTER TABLE items ADD COLUMN answer_md TEXT;
ALTER TABLE items ADD COLUMN answer_conf REAL;
ALTER TABLE items ADD COLUMN answer_state TEXT NOT NULL DEFAULT 'none';
  -- none 无答案 | suggested 机器配对待确认（含歧义档） | paired 高置信自动配对（≥0.85）
  -- | confirmed 人工确认/手工指定 | pending 未配对待补 | rejected 人工标记无答案
```

- [ ] **Step 4: 更新 spec §14**

§14 状态表子系统 4 行状态改为「**已出计划**：`docs/superpowers/plans/2026-09-10-answer-pairing.md`，未执行」。
§14 末尾「migration 编号约定」一段末尾追加：「`items.answer_*` 由子系统 4 的 `0021_answer_fields.sql` 落地；`items.revision` / `chunks.item_revision` 留子系统 5。」

- [ ] **Step 5: 跑测试 + 应用 dev 库**

```bash
cd pipeline && uv run pytest tests/test_migration_0021.py tests/test_db.py -v
cd pipeline && uv run python -c "from kb.core.config import load_config; from kb.core.db import connect, migrate; cfg = load_config(); print(migrate(connect(cfg.database_url)))"
```

预期：测试全 PASS；migrate 输出含 `0021_answer_fields.sql`。

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/migrations/0021_answer_fields.sql pipeline/tests/test_migration_0021.py docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "feat(pipeline): migration 0021——items 答案三字段（answer_md/answer_conf/answer_state）"
```

---

### Task 2: `answer_align.py` 纯函数四步链 + 单测

**Files:**
- Create: `pipeline/kb/rag/answer_align.py`
- Test: `pipeline/tests/test_answer_align.py`

本 Task 只写**纯函数**（不碰 DB）：`normalize_label` / `find_answer_zone` / `split_answer_segments` / `grade_match` / `align_answers`。
DB 编排 `apply_answer_alignment` 归 Task 3（和 structure_exam 集成一起测）。

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_answer_align.py`（纯函数不碰库，不需要 conn fixture）：

```python
"""卷末答案四步链（spec §8.2/§8.3，验收用例 1/2 的算法侧）。"""
from kb.rag.answer_align import (
    align_answers,
    find_answer_zone,
    grade_match,
    normalize_label,
    split_answer_segments,
)


def _page(page_no, texts):
    """texts: [(block_id, content_md)]，ordinal 按序。"""
    return {
        "page_no": page_no,
        "blocks": [
            {"id": bid, "ordinal": i + 1, "content_md": content}
            for i, (bid, content) in enumerate(texts)
        ],
    }


def test_normalize_label():
    assert normalize_label("15（2）") == "15(2)"
    assert normalize_label(" 9、") == "9"
    assert normalize_label("9.") == "9"


def test_find_answer_zone_by_heading_block():
    pages = [
        _page(1, [("b1", "一、选择题"), ("b2", "1. 题一")]),
        _page(2, [("b3", "参考答案"), ("b4", "1. B　2. A")]),
        _page(3, [("b5", "3. C")]),
    ]
    zone = find_answer_zone(pages)
    assert zone is not None
    # 答案区 = 标题块之后（含同页后续块）到卷末；标题块自身内容不进答案文本
    assert [part["block_id"] for part in zone] == ["b4", "b5"]
    assert find_answer_zone([_page(1, [("b1", "只有题目")])]) is None


def test_find_answer_zone_page_md_fallback():
    """无块的页（adopted=page_md）：对整页文本逐行匹配标题。"""
    pages = [{"page_no": 1, "blocks": [], "text": "一、题\n\n1. 题一"},
             {"page_no": 2, "blocks": [], "text": "参考答案\n\n1. B"}]
    zone = find_answer_zone(pages)
    assert zone is not None
    assert zone[0]["page_no"] == 2 and zone[0]["block_id"] is None
    assert zone[0]["text"] == "1. B"  # 标题行剥掉


def test_split_run_on_answers_case1():
    """验收用例 1：连排「9. 160　10. 0.75，75%　11. 40」切 3 段。"""
    segs = split_answer_segments(
        [{"page_no": 6, "block_id": "b2", "text": "一、1. 8.4　2. 9\n二、9. 160　10. 0.75，75%　11. 40"}])
    by_label = {s.label: s for s in segs}
    assert by_label["9"].text == "160"
    assert by_label["10"].text == "0.75，75%"
    assert by_label["11"].text == "40"
    assert by_label["9"].block_id == "b2"


def test_split_nested_subitems_case2():
    """验收用例 2：「15.（1）6 cm（2）432 cm³」子题再切，且保留大题整段。"""
    segs = split_answer_segments(
        [{"page_no": 6, "block_id": "b3", "text": "三、15.（1）6 cm　（2）432 cm³"}])
    labels = {s.label for s in segs}
    assert {"15", "15(1)", "15(2)"} <= labels
    by_label = {s.label: s for s in segs}
    assert by_label["15(1)"].text == "6 cm"
    assert by_label["15(2)"].text == "432 cm³"
    assert "6 cm" in by_label["15"].text and "432 cm³" in by_label["15"].text


def test_split_cross_page_concat():
    """§8.3：跨页答案按页序拼接后再切，题号不被页边界劈开。"""
    segs = split_answer_segments([
        {"page_no": 6, "block_id": "b1", "text": "9. 长方体体积为"},
        {"page_no": 7, "block_id": "b2", "text": "160 cm³　10. 0.75"},
    ])
    by_label = {s.label: s for s in segs}
    assert by_label["9"].text == "长方体体积为 160 cm³"
    assert by_label["9"].block_id == "b1"  # 跨界段来源取段首所在块
    assert by_label["10"].text == "0.75"


def test_grade_match_bands():
    """锁定决策 2 的四档。"""
    seg = type("S", (), {"text": "160"})()
    assert grade_match(seg, ambiguous=False) == (0.95, "paired")
    assert grade_match(None, ambiguous=False) == (None, "pending")
    assert grade_match(seg, ambiguous=True) == (0.5, "suggested")
    frag = type("S", (), {"text": "。"})()
    assert grade_match(frag, ambiguous=False) == (0.7, "suggested")


def test_align_answers_matches_item_labels():
    segs = split_answer_segments(
        [{"page_no": 6, "block_id": "b2", "text": "9. 160　10. 0.75　11. 40"}])
    out = align_answers(segs, ["9", "10", "11", "12"])
    assert out["9"][1:] == (0.95, "paired")
    assert out["12"][0] is None and out["12"][2] == "pending"  # 答案区没找到 12


def test_align_answers_subitem_labels():
    """item label 是子题号时优先对子题段；只有大题 label 时对整段。"""
    segs = split_answer_segments(
        [{"page_no": 6, "block_id": "b3", "text": "15.（1）6 cm　（2）432 cm³"}])
    out = align_answers(segs, ["15(1)", "15(2)"])
    assert out["15(1)"][0].text == "6 cm"
    out2 = align_answers(segs, ["15"])
    assert "432 cm³" in out2["15"][0].text
```

注意：`_QNUM_RE` 得挡住小数点误切——`0.75` 里的 `.` 前是数字，题号锚点要求数字前不是数字/小数点（`(?<![\d.,，])`），测试里 `10. 0.75，75%` 不能被切成 `10.` + `75` 段，`test_split_run_on_answers_case1` 已隐含覆盖，不许把该断言写松。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_answer_align.py -v
```

预期：FAIL，`ModuleNotFoundError: kb.rag.answer_align`。

- [ ] **Step 3: 实现 `answer_align.py`（纯函数部分）**

新建 `pipeline/kb/rag/answer_align.py`：

```python
"""卷末答案关联：版面定位 → 连排切分 → 子题再切 → 题号对齐（spec §8.2）。

全确定性规则，不走 LLM：LLM 只负责拆题，答案关联收归本模块（锁定决策 1）。
置信度规则见 grade_match（锁定决策 2）：状态由规则直接给出，不由 conf 反推。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

ANSWER_HEADING_RE = re.compile(r"^\s*(?:#{1,6}\s*)?(参考答案及解析|参考答案|答案)\s*$", re.M)
_QNUM_RE = re.compile(r"(?<![\d.,，])(\d{1,3})[.、．]\s*")
_SUBQ_RE = re.compile(r"[（(]\s*(\d{1,2})\s*[）)]")
_PUNCT_ONLY_RE = re.compile(r"^[\s\W_]+$")


@dataclass
class AnswerSegment:
    """切分出的一段答案。label 为对齐键：'9' 或 '15(1)'；block_id/page_no 记来源。"""

    label: str
    text: str
    block_id: str | None = None
    page_no: int | None = None


def normalize_label(label: str) -> str:
    """题号归一化：全角括号转半角、去空白与尾部题号标点。'15（2）' -> '15(2)'。"""
    s = (label or "").strip().replace("（", "(").replace("）", ")")
    return s.rstrip(".、．")


def find_answer_zone(pages: list[dict]) -> list[dict] | None:
    """①版面定位：pages 按页序，每页 {page_no, blocks: [{id, ordinal, content_md}], text?}。
    块文本命中 ANSWER_HEADING_RE 的块为标题块，答案区 = 该块之后（不含标题块）到卷末；
    无块页（page_md 路径）回退对整页 text 逐行匹配，命中行之后的内容进答案区。
    返回 [{page_no, block_id, text}]（block_id 可能为 None）；未命中返回 None。"""


def split_answer_segments(zone_parts: list[dict]) -> list[AnswerSegment]:
    """②连排切分 + ③子题再切。跨页先按页序拼成单一文本流再切（§8.3）：
    内部维护 字符偏移 -> (block_id, page_no) 的映射，段跨界时来源取段首所在块。
    先按 _QNUM_RE 切大题段；段内含 ≥2 个 _SUBQ_RE 命中时按子题再切出 '15(1)/15(2)'，
    且保留大题整段（label '15'）供只有大题 label 的 item 对齐。"""


def grade_match(seg: AnswerSegment | None, ambiguous: bool) -> tuple[float | None, str]:
    """④对齐置信（锁定决策 2）。找不到题号 -> (None, 'pending')；
    一对多歧义 -> (0.5, 'suggested')（阈值表的显式例外，见计划锁定决策 2）；
    唯一匹配但段疑似残缺（去空白 <2 字符或纯标点）-> (0.7, 'suggested')；
    唯一匹配且非空 -> (0.95, 'paired')。"""
    if seg is None:
        return None, "pending"
    if ambiguous:
        return 0.5, "suggested"
    text = (seg.text or "").strip()
    if len(text) < 2 or _PUNCT_ONLY_RE.match(text):
        return 0.7, "suggested"
    return 0.95, "paired"


def align_answers(
    segments: list[AnswerSegment], labels: list[str]
) -> dict[str, tuple[AnswerSegment | None, float | None, str]]:
    """按归一化 label 对齐：item label 是子题号（含括号）优先匹配子题段，
    大题 label 匹配大题整段；同 label 多段按歧义处理。
    返回 {原 label: (segment|None, conf|None, state)}。"""
```

实现要点：`find_answer_zone` 同一页内标题块之后的块才进答案区（按 ordinal）；`split_answer_segments` 拼接时块间以 `\n` 连接，`_SUBQ_RE` 命中 <2 个时不再切（单个子题引用不等于子题连排，如「15. 见（1）的图」）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_answer_align.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/rag/answer_align.py pipeline/tests/test_answer_align.py
git commit -m "feat(pipeline): answer_align 纯函数四步链——答案区定位/连排切分/子题再切/题号对齐"
```

---

### Task 3: structure_exam 集成 + embed content_type 过滤 + 既有测试改造

**Files:**
- Modify: `pipeline/kb/rag/answer_align.py`（加 `apply_answer_alignment`）
- Modify: `pipeline/kb/rag/structure_exam.py`（prompt 去 answer_md、只产 exercise item、收尾调对齐）
- Modify: `pipeline/kb/rag/embed.py`（`embed_approved_items` 加 content_type 过滤）
- Test: `pipeline/tests/test_answer_align.py`、`pipeline/tests/test_structure_exam.py`、（embed 过滤断言可进）`pipeline/tests/test_embed.py`（若不存在则在 test_structure_exam.py 内覆盖）

行为：

- `EXAM_PROMPT`（structure_exam.py:20-31）删掉 `answer_md` 一行与「答案区的答案按题号对应到题目」规则，输出字段只剩 `{label, stem_md, page_start, page_end}`。
- `extract_section`（:133-146）落库循环只插 `("exercise", stem)`，删掉 answer 分支；`count` 语义变为题目数。
- `run_exam_structure`（:192）不再调 `pair_items`，改调 `apply_answer_alignment(conn, doc_id, recorder=recorder)`；打印行改为「答案配对 X 题，待确认 Y，未配对 Z」。
- `apply_answer_alignment`（answer_align.py 新增，DB 编排）：
  1. 读 pages 的块（`content_md IS NOT NULL`，按 page_no, ordinal；缺块页回退 `page_md`；文档无 pages 时回退 `chapters.content_md` 按 chapter_no 拼成单页伪 part，`block_id=None`）。
  2. 跑四步链；无答案区 → 全部 exercise item 置 `answer_state='pending'`（仍按锁定决策 6 不阻塞）。
  3. 逐 exercise item（`content_type='exercise'` 且 `answer_state NOT IN ('confirmed','rejected')`——人工结论优先，重跑不覆盖）按归一化 label 对齐，UPDATE `answer_md/answer_conf/answer_state`。
  4. 段有 `block_id` 的写 `item_blocks (item_id, block_id, 'solution') ON CONFLICT DO NOTHING`（锁定决策 4）。
  5. `suggested`/`pending` 的 item 建 review_queue 行：`reason='answer_suggested'` / `'answer_pending'`，同 item 同 reason 且 status='pending' 已存在则跳过（与 `qc.py:117` 同口径去重）。
  6. `recorder.decision("structure", ...)` 汇总分档计数；逐条低置信可用 `recorder.decision(..., item_id=...)`（traj.py:58 支持）。
- `embed_approved_items`（embed.py:34-41）SQL 加 `AND i.content_type <> 'answer'`（§8.1 堵现状 bug）。

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_answer_align.py` 追加（DB 侧，fixture 风格照 `test_structure_exam.py` 的 `pdf_exam`：documents + pages(page_md) 直插）：

```python
def test_apply_answer_alignment_end_to_end(conn):
    """DB 编排：连排 3 题挂 3 题（用例 1）+ 未配对 pending + review_queue 行。"""
    import uuid

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'卷','exam','/tmp/x.pdf','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO pages (id, document_id, page_no, image_path, parse_status,"
            " adopted_source, page_md)"
            " VALUES (%s,%s,1,'p1.png','parsed','page_md','一、题'),"
            "        (%s,%s,2,'p2.png','parsed','page_md','参考答案\n\n9. 160　10. 0.75，75%　11. 40')",
            (str(uuid.uuid4()), doc_id, str(uuid.uuid4()), doc_id),
        )
        for label in ("9", "10", "11", "12"):
            cur.execute(
                "INSERT INTO items (id, document_id, content_type, label, content_md)"
                " VALUES (%s,%s,'exercise',%s,'题干')",
                (str(uuid.uuid4()), doc_id, label),
            )
    from kb.rag.answer_align import apply_answer_alignment

    out = apply_answer_alignment(conn, doc_id)
    assert out == {"paired": 3, "suggested": 0, "pending": 1}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT label, answer_md, answer_state FROM items WHERE document_id=%s ORDER BY label",
            (doc_id,),
        )
        rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
        assert rows["9"] == ("160", "paired")
        assert rows["10"] == ("0.75，75%", "paired")
        assert rows["11"] == ("40", "paired")
        assert rows["12"] == (None, "pending")
        cur.execute(
            "SELECT count(*) FROM review_queue r JOIN items i ON i.id=r.item_id"
            " WHERE i.document_id=%s AND r.reason='answer_pending' AND r.status='pending'",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1
    # 幂等：重跑不重复建行、不覆盖 confirmed
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE items SET answer_state='confirmed' WHERE document_id=%s AND label='12'",
            (doc_id,),
        )
    apply_answer_alignment(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT answer_state FROM items WHERE document_id=%s AND label='12'", (doc_id,))
        assert cur.fetchone()[0] == "confirmed"
        cur.execute(
            "SELECT count(*) FROM review_queue r JOIN items i ON i.id=r.item_id"
            " WHERE i.document_id=%s AND r.status='pending'",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1


def test_apply_answer_alignment_records_solution_block(conn):
    """有块路径：对齐成功写 item_blocks role='solution'（锁定决策 4）。"""
    # fixture：page2 用块（标题块 + 答案块 b_ans），跑对齐后
    # 断言 item_blocks 存在 (item_9, b_ans, 'solution') 且 answer_md='160'
```

`pipeline/tests/test_structure_exam.py` 改造（先改断言再改实现，TDD 红）：

- `EXAM_JSON` 去掉 `answer_md` 字段。
- `test_run_exam_structure_pdf`：`out["items"] == 1`；items 只剩 1 条 exercise；新增断言——`answer_md='B'`、`answer_state='paired'`、`answer_conf=0.95`（fixture 第 2 页「参考答案\n\n1. B」走 page_md 回退定位）；`paired_item_id` 断言删掉（exam 路径不再写它）；`struct_mode='toc'` 保留。
- `test_run_exam_structure_docx` / `rerun_heals` / 路由用例：`items` 计数同步改（2→1、4→2）。
- `test_structure.py` 的 `pair_items` 用例**不动**（workbook 路径保留）。

embed 过滤测试（放 `test_structure_exam.py` 或新建 `test_embed.py`，看该文件现状再定）：

```python
def test_embed_skips_answer_items(conn, cfg):
    """§8.1 现状 bug 修复：content_type='answer' 的 approved item 不再向量化。"""
    # 直插 approved 的 exercise + answer 各一条，假 client 记录 embed 输入
    # embed_approved_items(conn, cfg, doc_id, client=fake)
    # 断言：只产生 1 条 chunk（exercise 的）；fake 收到的文本不含 answer 内容
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_answer_align.py tests/test_structure_exam.py -v
```

预期：FAIL（`apply_answer_alignment` 不存在；旧断言撞到新行为）。

- [ ] **Step 3: 实现**

`answer_align.py` 追加 `apply_answer_alignment`：

```python
def apply_answer_alignment(conn, doc_id: str, recorder=None) -> dict:
    """DB 编排（spec §8.2）：读块/页稿/章节 -> 四步链 -> 写 items 答案字段。

    - 数据源优先级：blocks（page_no, ordinal 序） > 缺块页回退 page_md > 无页文档回退
      chapters.content_md（chapter_no 序，block_id=None）。
    - answer_state IN ('confirmed','rejected') 的 item 跳过（人工结论优先，重跑幂等）。
    - 对齐成功且段有来源块：item_blocks (item_id, block_id, 'solution') ON CONFLICT DO NOTHING。
    - suggested/pending 建 review_queue（reason=answer_suggested/answer_pending，
      同 item 同 reason pending 去重，与 kb/ocr/qc.py:117 同口径）。
    - 无答案区：全部 exercise item 置 pending（锁定决策 6：不阻塞入库）。
    返回 {"paired": n, "suggested": n, "pending": n}。
    """
```

`structure_exam.py`：按上面行为改 `EXAM_PROMPT`、`extract_section` 落库循环、`run_exam_structure` 收尾（删 `from kb.rag.structure import pair_items` 的 exam 侧调用，`pair_items` 本体不动）。
`embed.py`：`embed_approved_items` 的 WHERE 加 `AND i.content_type <> 'answer'`。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_answer_align.py tests/test_structure_exam.py tests/test_structure.py -v
```

预期：全 PASS（含 pair_items 既有用例无回归）。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/rag/answer_align.py pipeline/kb/rag/structure_exam.py pipeline/kb/rag/embed.py pipeline/tests/test_answer_align.py pipeline/tests/test_structure_exam.py
git commit -m "feat(pipeline): exam 答案关联收归确定性代码——拆题只产 exercise，答案写字段，embed 过滤 answer item"
```

---

### Task 4: backend——答案字段透出 + 对齐表查询 + 三个操作端点

**Files:**
- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/review.test.ts`

行为（全部只动 `items`/`item_blocks`/`review_queue`/`pipeline_events`，**不碰 chunks**——锁定决策 5）：

- `GET /items`（:181）SELECT 加 `i.answer_state`；`GET /items/:id`（:207）SELECT 加 `i.answer_md, i.answer_conf, i.answer_state`。
- `GET /docs/:id/answer-alignment`（新）：返回对齐表 + 答案区页数据，供屏 4 三栏：

```ts
// 响应形状
{
  items: [
    { item_id, label, chapter, content_md, answer_md, answer_conf, answer_state,
      source: { block_id, page_id, page_no, ordinal } | null },  // 来自 item_blocks role='solution'
  ],                          // 该文档全部 exercise item，按 chapter, label 数值序
  answer_pages: [             // 左栏页图数据：答案区页（含答案区标题块的页到卷末）
    { page_id, page_no, image_url, blocks: [{ id, bbox, ordinal, content_md, crop_url }] },
  ],
  stats: { paired: 0, suggested: 0, pending: 0, confirmed: 0, rejected: 0 },
}
```

  `answer_pages` 的定位 SQL 与 pipeline 侧同口径：块文本命中 `^(参考答案|答案|参考答案及解析)$` 的最前页起到卷末；都没有时回退 page_md 行匹配；仍无则空数组（前端显示「未找到答案区」）。
- `POST /items/:id/answer-adopt`（采纳配对）：`answer_state IN ('suggested','paired')` 才受理（否则 409）→ `answer_state='confirmed'`（answer_md/answer_conf 不动）→ 关闭该 item `reason IN ('answer_suggested','answer_pending')` 的 pending review_queue 行（status='approved'）→ 事件。
- `POST /items/:id/answer-block`（手工指定答案块）：body `{block_id}`，校验块存在且与该 item 同文档（否则 404/422）→ `answer_md = 块 content_md`、`answer_conf=NULL`、`answer_state='confirmed'` → `INSERT item_blocks (item_id, block_id, 'solution') ON CONFLICT DO NOTHING` → 关 pending 复核行 → 事件。
- `POST /items/:id/answer-reject`（标记无答案）：`answer_md=NULL, answer_conf=NULL, answer_state='rejected'` → 关 pending 复核行 → 事件。
- 事件全部照 `PATCH /items/:id`（:555-578）的 INSERT 模式：`stage='user_edit'`、`actor='user'`，event_type 分别 `answer_adopt` / `answer_assign` / `answer_reject`，payload 带 old/new。

- [ ] **Step 1: 写失败测试**

`backend/src/routes/review.test.ts` 追加（fixture 模式照抄现有 beforeAll 裸 INSERT）：

```ts
  it("GET /items/:id 透出答案三字段；GET /items 带 answer_state", async () => {
    const item = (await pool.query(
      `INSERT INTO items (document_id, content_type, label, content_md,
                          answer_md, answer_conf, answer_state)
       VALUES ($1,'exercise','9','题干','160',0.95,'paired') RETURNING id::text`,
      [docId])).rows[0].id as string;
    const detail = await (await app.request(`/api/review/items/${item}`)).json();
    expect(detail.answer_md).toBe("160");
    expect(detail.answer_conf).toBeCloseTo(0.95);
    expect(detail.answer_state).toBe("paired");
    const list = await (await app.request(`/api/review/items?doc_id=${docId}`)).json();
    expect(list.items.find((i: { id: string }) => i.id === item).answer_state).toBe("paired");
  });

  it("GET /docs/:id/answer-alignment：对齐表 + 答案区页 + 分档统计", async () => {
    // fixture：page 末页插标题块「参考答案」+ 答案块；items 9(paired)/13(suggested)/14(pending)，
    // item 9 挂 item_blocks role='solution'
    const resp = await app.request(`/api/review/docs/${docId}/answer-alignment`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    const row9 = body.items.find((r: { label: string }) => r.label === "9");
    expect(row9.answer_md).toBe("160");
    expect(row9.source.ordinal).toBe(2);
    expect(body.answer_pages.length).toBe(1);
    expect(body.answer_pages[0].blocks.some(
      (b: { content_md: string }) => b.content_md === "参考答案")).toBe(true);
    expect(body.stats).toMatchObject({ paired: 1, suggested: 1, pending: 1 });
  });

  it("POST /items/:id/answer-adopt：suggested→confirmed，关复核行，写事件", async () => {
    // fixture：suggested item + answer_suggested pending review_queue 行
    const resp = await app.request(`/api/review/items/${item13}/answer-adopt`, { method: "POST" });
    expect(resp.status).toBe(200);
    expect((await pool.query("SELECT answer_state FROM items WHERE id=$1", [item13]))
      .rows[0].answer_state).toBe("confirmed");
    expect((await pool.query(
      "SELECT count(*) FROM review_queue WHERE item_id=$1 AND status='pending'",
      [item13])).rows[0].count).toBe("0");
    expect((await pool.query(
      "SELECT 1 FROM pipeline_events WHERE stage='user_edit' AND event_type='answer_adopt'"))
      .rowCount).toBeGreaterThan(0);
    // chunks 不动（锁定决策 5）：该 item 先插一条 chunk，操作后仍在
    // 重复 adopt（已 confirmed）→ 409
    expect((await app.request(`/api/review/items/${item13}/answer-adopt`, { method: "POST" }))
      .status).toBe(409);
  });

  it("POST /items/:id/answer-block：写 answer_md + item_blocks solution + confirmed", async () => {
    const resp = await app.request(`/api/review/items/${item14}/answer-block`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_id: answerBlockId }),
    });
    expect(resp.status).toBe(200);
    const row = (await pool.query(
      "SELECT answer_md, answer_conf, answer_state FROM items WHERE id=$1", [item14])).rows[0];
    expect(row.answer_md).toBe("9. 160　10. 0.75");
    expect(row.answer_conf).toBeNull();
    expect(row.answer_state).toBe("confirmed");
    expect((await pool.query(
      "SELECT 1 FROM item_blocks WHERE item_id=$1 AND block_id=$2 AND role='solution'",
      [item14, answerBlockId])).rowCount).toBe(1);
    // 跨文档块 → 422
  });

  it("POST /items/:id/answer-reject：清空答案字段并置 rejected", async () => {
    const resp = await app.request(`/api/review/items/${item9}/answer-reject`, { method: "POST" });
    expect(resp.status).toBe(200);
    const row = (await pool.query(
      "SELECT answer_md, answer_conf, answer_state FROM items WHERE id=$1", [item9])).rows[0];
    expect(row).toMatchObject({ answer_md: null, answer_conf: null, answer_state: "rejected" });
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- review.test
```

预期：FAIL（字段 undefined / 404）。

- [ ] **Step 3: 实现**

`review.ts` 按上面行为改/加。错误处理用 `invalidId`（:17）兜底 22P02；body 解析用 `readJson`（:240）；uuid 非法、item/块不存在、状态机非法分别 422/404/409。
`answer_pages` 的标题匹配正则与 pipeline 保持一致：`^\s*(参考答案及解析|参考答案|答案)\s*$`（对 `trim` 后的块 content_md 整串匹配）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- review.test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 答案字段透出 + 对齐表查询 + 采纳/手工指定/标记无答案三端点"
```

---

### Task 5: frontend——「答案关联」屏（MaterialsView 新 tab）

**Files:**
- Create: `frontend/src/components/AnswerAlignment.tsx`
- Modify: `frontend/src/views/MaterialsView.tsx`（Block 类型 + TABS + 路由分支）
- Modify: `frontend/src/api/review.ts`（类型 + 四个函数）
- Test: `frontend/src/components/AnswerAlignment.test.tsx`

视觉/交互照 `review-workbench.html` `#scr-answers`（:882-1057）三栏：

- **左栏**：答案区页图（`image_url` 整页图 + bbox 覆层，定位命中的块高亮主色蓝框；标题块灰虚线角标「标题」）+ 页下方四步说明卡（①版面定位 ②连排切分 ③子题再切 ④题号对齐，文案照 HTML :917-922）。
- **中栏**：题号对齐表（列：题号 / 题目 item / 答案文本 / 来源块 `P{page_no}/B{ordinal}` / 置信 / 状态）。
  状态分色与文案映射：paired/confirmed=「已配对」ok chip、suggested=「待确认」bad chip + danger-row、pending=「未配对」bad chip + danger-row、rejected=「无答案」灰 chip。
  顶部统计 chip（已配对 N / 待确认 N / 未配对 N）+ 底部四操作：✓ 采纳选中配对 / ✎ 手工指定答案块 / 在卷末页图中定位 / 标记无答案。
  「在卷末页图中定位」：选中行有 source 时左栏滚动到该页并把该块框高亮。
  「手工指定答案块」：进入选块模式（左栏点击块选中，确认后调 `assignAnswerBlock`）。
  「采纳选中配对」只对 suggested 行可用；操作成功后重新拉对齐数据。
  底部注明「未配对的题不阻塞入库：题目照常向量化，答案字段留空待补」（照 HTML :993-995）。
- **右栏**：当前选中行的检索命中预览卡（题干 + 折叠答案条：默认收起、标签「默认隐藏」、点开显示 answer_md；无答案显示「暂无答案」）+ 三条硬规则卡（答案不参与 embedding / 卷末答案整页不单独入索引 / 图进向量的是图注文本，文案照 HTML :1041-1047）。
- MaterialsView：Block 类型加 `"answers"`，TABS 加 `["answers", "答案关联"]`（放「条目」之后），选中文档后渲染 `<AnswerAlignment docId={...} />`；`doc_type !== 'exam'` 时组件内显示空态说明。

api 客户端（`frontend/src/api/review.ts`，照 `req/json` 模式 :76-87）：

```ts
export interface AnswerAlignmentRow {
  item_id: string; label: string | null; chapter: string | null;
  content_md: string | null; answer_md: string | null;
  answer_conf: number | null; answer_state: string;
  source: { block_id: string; page_id: string; page_no: number; ordinal: number } | null;
}

export interface AnswerAlignment {
  items: AnswerAlignmentRow[];
  answer_pages: { page_id: string; page_no: number; image_url: string;
    blocks: { id: string; bbox: number[] | null; ordinal: number; content_md: string | null; crop_url: string }[] }[];
  stats: { paired: number; suggested: number; pending: number; confirmed: number; rejected: number };
}

export function fetchAnswerAlignment(docId: string, fetchImpl: FetchLike = fetch): Promise<AnswerAlignment> {
  return req(`/api/review/docs/${docId}/answer-alignment`, fetchImpl);
}
export function adoptAnswer(itemId: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${itemId}/answer-adopt`, fetchImpl, json("POST", {}));
}
export function assignAnswerBlock(itemId: string, blockId: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${itemId}/answer-block`, fetchImpl, json("POST", { block_id: blockId }));
}
export function rejectAnswer(itemId: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${itemId}/answer-reject`, fetchImpl, json("POST", {}));
}
```

`ReviewItemSummary` / `ReviewItemDetail` 分别加 `answer_state` / `answer_md, answer_conf, answer_state` 字段。

- [ ] **Step 1: 写失败测试**

`frontend/src/components/AnswerAlignment.test.tsx`（fetch 桩用 `src/test/support.ts` 的 `fetchRouter`）：

```tsx
it("对齐表三档分色渲染：已配对/待确认/未配对", async () => {
  // 桩 GET answer-alignment 返回 paired/suggested/pending 各一行
  // 断言三个状态 chip 文案与 danger-row 行类名
});

it("采纳选中配对：调 answer-adopt 并刷新表格", async () => {
  // 选中 suggested 行 → 点「采纳选中配对」
  // 断言收到 POST /api/review/items/:id/answer-adopt，随后重新 GET 对齐数据
});

it("手工指定答案块：选块模式点左栏块 → assign 请求体含 block_id", async () => {
  // 选中 pending 行 → 点「手工指定答案块」→ 点左栏某块 → 确认
  // 断言 POST /items/:id/answer-block 的 body { block_id }
});

it("在卷末页图中定位：选中行后左栏对应块高亮", async () => {
  // 选中带 source 的行 → 点定位 → 断言左栏该块元素带高亮类
});

it("右栏预览：答案条默认折叠，点开展示 answer_md", async () => {
  // 选中 paired 行 → 断言答案条收起且带「默认隐藏」标签
  // 点击展开 → answer_md 可见
});

it("标记无答案：调 answer-reject 并刷新", async () => { /* 同上模式 */ });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd frontend && npx vitest run src/components/AnswerAlignment.test.tsx
```

预期：FAIL（组件不存在）。

- [ ] **Step 3: 实现**

按上述语义写 `AnswerAlignment.tsx` + MaterialsView 接 tab + api 客户端。
样式沿用 theme.css 现有 chip/btn 类与 DESIGN.md 令牌，页图覆层参照 `PageDetail.tsx` 的 bbox 定位算法（显示尺寸 → 原图比例换算）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd frontend && npx vitest run src/components/AnswerAlignment.test.tsx && npx tsc --noEmit
```

预期：全 PASS，无类型错误。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AnswerAlignment.tsx frontend/src/components/AnswerAlignment.test.tsx frontend/src/views/MaterialsView.tsx frontend/src/api/review.ts
git commit -m "feat(frontend): 复核页新增答案关联屏——三栏对齐表/答案区页图定位/折叠答案预览"
```

---

### Task 6: e2e + 三栈全量回归 + spec 收尾

**Files:**
- Create: `e2e/specs/answer-pairing.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §14

种子模式照 `e2e/specs/exam-structure.spec.ts`（serial、裸 INSERT documents/pages、`execSync uv run python -m kb.cli structure <doc_id>` 在 PIPELINE_DIR 下跑、PNG_1PX 页图落 STORAGE_ROOT）。
答案区 fixture 用**真文本**（page_md 路径，不依赖版面模型）：第 1 页题目「二、填空题 9/10/11 + 三、解答 15（1）（2）」，第 2 页 `参考答案\n\n9. 160　10. 0.75，75%　11. 40\n15.（1）6 cm　（2）432 cm³`；另加第 14 题（答案区没有 14）覆盖 pending。
LLM 是真调（e2e 有 ollama），题号 label 以 LLM 实际输出为准——断言用「label 归一化后含 9/10/11 的 item」而不是硬编码 item id；若 LLM 把 15 拆成大题一条而非子题两条，子题断言对大题 label 做（`15` 对整段），两条路线都写进用例注释，但**不许**为用例通过而放宽 paired 状态断言。

- [ ] **Step 1: 写 e2e 用例**

`e2e/specs/answer-pairing.spec.ts`：

1. **连排配对（验收 1）**：structure 跑完后 DB 断言 label 9/10/11 的 item `answer_md` 分别为 `160` / `0.75，75%` / `40`、`answer_state='paired'`、`answer_conf=0.95`；items 表无 `content_type='answer'` 行。
2. **子题嵌套（验收 2）**：label `15(1)`/`15(2)`（或大题 `15`）的 item 拿到对应答案段，`answer_state='paired'`。
3. **pending 不阻塞（验收 8）**：label 14 的 item `answer_state='pending'`、`answer_md IS NULL`；调 `POST /api/review/items/:id/approve`（或 pipeline approve）后照常通过且产生 chunk（DB 断言 chunks 行存在），review_queue 有 `answer_pending` 行不消失（approve 只关 item 级 pending？——注意：approve 现逻辑会关该 item 全部 pending 复核行，embed.ts:164-166；若 e2e 撞到这个行为，以「approve 后复核行关闭但 answer_state 仍 pending」为准并断言后者）。
4. **UI 对齐表**：打开 `/` → 资料 tab → 选该文档 → 「答案关联」→ 断言表格出现 9/10/11 行且状态列「已配对」、14 行「未配对」；右栏选中 9 行后答案条默认折叠、点开可见 `160`；左栏出现答案区页图。
5. **UI 采纳操作**：若种子能造出 suggested 行（在 DB 直接把某行改 `answer_state='suggested'` + 插 review_queue 行）→ UI 采纳 → DB 断言 `confirmed` + pipeline_events 有 `answer_adopt`；「标记无答案」→ `rejected`。

- [ ] **Step 2: 跑 e2e**

```bash
cd e2e && npx playwright test specs/answer-pairing.spec.ts
```

预期：全 PASS。LLM 输出不稳导致题号缺失时，调 fixture 题干使其更像规范试卷，不许 `test.fixme`。

- [ ] **Step 3: 三栈全量回归**

```bash
cd pipeline && uv run pytest tests/ -q
cd backend && npm test
cd frontend && npx vitest run
cd e2e && npm test
```

预期：全绿（重点盯 `exam-structure.spec.ts`：其种子第 2 页就是「参考答案\n\n1. B」，行为变化后该 spec 的 t1 断言要同步更新——答案从「answer item + paired_item_id」变成「exercise item 的 answer_md 字段」）。

- [ ] **Step 4: spec §14 收尾**

子系统 4 行状态改「已完成：`docs/superpowers/plans/2026-09-10-answer-pairing.md`」。

- [ ] **Step 5: Commit**

```bash
git add e2e/specs/answer-pairing.spec.ts e2e/specs/exam-structure.spec.ts docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "test(e2e): 卷末答案关联全链路用例（连排/子题/pending 不阻塞 + 对齐表 UI）"
```

---

## 完成判定

- 三栈单测 + e2e 全绿。
- 验收用例 1：连排「9. 160　10. 0.75，75%　11. 40」切 3 条并挂到 3 道题（`answer_md` + `answer_state='paired'` + conf 0.95），无 answer item 产生。
- 验收用例 2：「15.（1）…（2）…」按子题对齐（`15(1)/15(2)` 或只有大题 label 时对整段）。
- 验收用例 8：`answer_state='pending'` 的题照常 approve + 向量化，不阻塞。
- 现状 bug 修复：`embed_approved_items` 不再向量化 `content_type='answer'`（断言 embed 输入不含答案文本）。
- 跨页答案按页序拼接后切分（§8.3），段来源块写 `item_blocks role='solution'`。
- 后端三操作端点（采纳/手工指定/标记无答案）状态机正确、写 `pipeline_events(stage='user_edit')`、不动 chunks。
- 前端「答案关联」tab 三栏照 `#scr-answers`：对齐表三档分色、左栏页图定位高亮、右栏答案默认折叠带「默认隐藏」标签。
- spec §14 子系统 4 行改「已完成」。

## 范围外（明确不做）

- `items.revision` / `chunks.item_revision` / stale chunk 重建与检索过滤（子系统 5）。
- embedding 输入改「stem + 图注」、图注 caption（子系统 5）。
- 检索/聊天 UI 的答案折叠呈现（§7.3 的 `<!-- answer -->` 模板与命中卡，子系统 5）；本子系统的右栏预览只是复核屏内的静态预览。
- 存量 `content_type='answer'` item 的数据迁移（锁定决策 3：不迁移，只挡向量化）。
- 答案区不在卷末（插页/卷首）或标题 wording 超出三个枚举值的情况——定位不到就整卷 pending 进人工（锁定决策 6），不做模糊匹配。
- workbook 路径的 `pair_items` 行为变更（保留现状）。
- 「重跑对齐」按钮的独立端点（HTML 上有此按钮；本子系统用重跑 `structure` CLI 覆盖，前端不单独接）。

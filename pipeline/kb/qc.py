"""阶段⑤质检（骨架期 lite）：空转录/疑似截断 -> review_queue。
精度期扩展：LaTeX 编译检查、题号连续性、置信分阈值分流、页级版面忠实度（覆盖/重叠）。"""
from __future__ import annotations

import json
import re
import subprocess
import uuid
from pathlib import Path

import pymupdf as fitz

_TRUNCATION_ENDINGS = ("…", "...", "，", "、", "；", "：")
_KATEX_CHECK = Path(__file__).parent.parent / "scripts" / "katex_check.cjs"
_MATH_RE = re.compile(r"\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$")

# 机器可检测的原因：只有这些允许自动关闭；人工插入的自定义原因必须人显式 通过/打回
CHECKABLE_REASONS = frozenset({"empty", "maybe_truncated", "bad_latex",
                               "layout_gap", "layout_overlap"})
_LAYOUT_REASONS = ("layout_gap", "layout_overlap")
_GAP_BAND = 0.3       # 连续无块纵向带超过页高此比例视为漏切
_OVERLAP_RATIO = 0.5  # 相交面积超过较小块此比例视为重叠切错


def check_page_layout(bboxes: list[tuple], page_w: float, page_h: float) -> list[str]:
    """版面忠实度：整带漏切 -> layout_gap；块间大面积重叠 -> layout_overlap。

    无 bbox（骨架期整页块）不检查。漏切判定不用面积覆盖率（紧贴文字的 bbox
    在密集页面也只有 ~20% 覆盖，面积法全是误报），改用最大纵向空白带占比。
    """
    if not bboxes or page_w <= 0 or page_h <= 0:
        return []
    reasons = []
    # 最大纵向空白带：块沿 y 轴排序扫描，超过页高 30% 的连续无块区域视为漏切
    intervals = sorted((max(0.0, y0), min(page_h, y1)) for _x0, y0, _x1, y1 in bboxes)
    cursor, max_gap = 0.0, 0.0
    for y0, y1 in intervals:
        if y0 > cursor:
            max_gap = max(max_gap, y0 - cursor)
        cursor = max(cursor, y1)
    max_gap = max(max_gap, page_h - cursor)
    if max_gap / page_h > _GAP_BAND:
        reasons.append("layout_gap")
    areas = [max(0.0, x1 - x0) * max(0.0, y1 - y0) for x0, y0, x1, y1 in bboxes]
    for i, a in enumerate(bboxes):
        for j in range(i + 1, len(bboxes)):
            b = bboxes[j]
            iw = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
            ih = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
            smaller = min(areas[i], areas[j])
            if smaller > 0 and iw * ih > _OVERLAP_RATIO * smaller:
                reasons.append("layout_overlap")
                return reasons
    return reasons


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


def sync_block_reviews(conn, block_id: str) -> int:
    """块内容变化后同步复核行：新增当前可检测问题，关闭已修复的可检测行。
    run_qc 与 PATCH 编辑接口共用同一语义；自定义原因不动。返回新增条数。"""
    with conn.cursor() as cur:
        cur.execute("SELECT content_md, block_type FROM blocks WHERE id=%s", (block_id,))
        row = cur.fetchone()
        if not row:
            return 0
        content, block_type = row
        reasons = check_content(content)
        # figure 块的内容就是裁图本身（如竖式图），空 content_md 不是缺陷
        if block_type == "figure":
            reasons = [r for r in reasons if r != "empty"]
        cur.execute(
            "SELECT reason FROM review_queue WHERE block_id=%s AND status='pending'",
            (block_id,),
        )
        existing = {r[0] for r in cur.fetchall()}
        n = 0
        for reason in reasons:
            if reason in existing:
                continue
            cur.execute(
                "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,%s)",
                (str(uuid.uuid4()), block_id, reason),
            )
            n += 1
        for reason in existing - set(reasons):
            if reason in CHECKABLE_REASONS:
                cur.execute(
                    "UPDATE review_queue SET status='approved' "
                    "WHERE block_id=%s AND reason=%s AND status='pending'",
                    (block_id, reason),
                )
        return n


def _page_image_size(image_path: str) -> tuple[float, float] | None:
    p = Path(image_path)
    if not p.is_absolute():
        p = Path.cwd() / p
    if not p.exists():
        return None
    pix = fitz.Pixmap(str(p))
    return pix.width, pix.height


def run_qc(conn, doc_id: str, cfg=None, vlm_client=None) -> int:
    """对低质 block/版面问题建复核记录（同源不重复）；修复后自动关闭旧记录。返回新增条数。
    传入 cfg 时，实质问题较多的页自动触发远端整页 VLM 转录（第二解析产物）。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.content_md, b.block_type FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND p.status IN ('parsed', 'failed')""",
            (doc_id,),
        )
        n = 0
        for block_id, _content, _btype in cur.fetchall():
            n += sync_block_reviews(conn, block_id)
        # 页级版面检查：覆盖/重叠可复算，进 CHECKABLE 集合自动关闭
        cur.execute(
            """SELECT id, image_path FROM pages
               WHERE document_id=%s AND status IN ('parsed', 'failed')""",
            (doc_id,),
        )
        for page_id, image_path in cur.fetchall():
            cur.execute(
                "SELECT bbox FROM blocks WHERE page_id=%s AND bbox IS NOT NULL",
                (page_id,),
            )
            bboxes = [tuple(r[0]) for r in cur.fetchall()]
            size = _page_image_size(image_path)
            reasons = check_page_layout(bboxes, *size) if size else []
            cur.execute(
                "SELECT reason FROM review_queue WHERE page_id=%s AND status='pending'",
                (page_id,),
            )
            existing = {r[0] for r in cur.fetchall()}
            for reason in reasons:
                if reason in existing:
                    continue
                cur.execute(
                    "INSERT INTO review_queue (id, page_id, reason) VALUES (%s,%s,%s)",
                    (str(uuid.uuid4()), page_id, reason),
                )
                n += 1
            for reason in existing - set(reasons):
                if reason in _LAYOUT_REASONS:  # 只关可复算的版面原因，人工自定义行不动
                    cur.execute(
                        "UPDATE review_queue SET status='approved' "
                        "WHERE page_id=%s AND reason=%s AND status='pending'",
                        (page_id, reason),
                    )
    if cfg is not None:
        from kb.pagelvl import auto_page_vlm
        auto_page_vlm(conn, cfg, doc_id, client=vlm_client)
    return n


def check_label_continuity(conn, doc_id: str) -> int:
    """每章 exercise 题号应连续，缺号建 missing_item 复核行。返回新增数。

    支持两种题号：纯数字（"3"）按章连续；"3-1" 式（例N-第M题）按 (章, N) 分组对 M 连续。
    """
    grouped = re.compile(r"^(\d+)-(\d+)$")
    with conn.cursor() as cur:
        cur.execute(
            """SELECT chapter, label FROM items
               WHERE document_id=%s AND content_type='exercise' AND chapter IS NOT NULL
               ORDER BY chapter""",
            (doc_id,),
        )
        by_group: dict[tuple, set[int]] = {}
        for chapter, label in cur.fetchall():
            if not label:
                continue
            m = grouped.match(label)
            if m:
                key, num = (chapter, m.group(1)), int(m.group(2))
            elif label.isdigit():
                key, num = (chapter, ""), int(label)
            else:
                continue
            by_group.setdefault(key, set()).add(num)
        n = 0
        for (chapter, prefix), labels in by_group.items():
            missing = sorted(set(range(1, max(labels) + 1)) - labels)
            for num in missing:
                shown = f"{prefix}-{num}" if prefix else str(num)
                reason = f"missing_item:{chapter} 第{shown}题"
                cur.execute("SELECT 1 FROM review_queue WHERE reason=%s", (reason,))
                if cur.fetchone():
                    continue
                cur.execute(
                    "INSERT INTO review_queue (id, reason) VALUES (%s,%s)",
                    (str(uuid.uuid4()), reason),
                )
                n += 1
    return n

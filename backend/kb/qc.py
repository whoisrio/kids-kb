"""阶段⑤质检（骨架期 lite）：空转录/疑似截断 -> review_queue。
精度期扩展：LaTeX 编译检查、题号连续性、置信分阈值分流。"""
from __future__ import annotations

import json
import re
import subprocess
import uuid
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


def resolve_block_reviews(conn, block_id: str) -> int:
    """内容修复后，关闭不再成立的【可检测】复核记录。返回关闭数。"""
    with conn.cursor() as cur:
        cur.execute("SELECT content_md FROM blocks WHERE id=%s", (block_id,))
        row = cur.fetchone()
        if not row:
            return 0
        reasons = set(check_content(row[0]))
        cur.execute(
            "SELECT reason FROM review_queue WHERE block_id=%s AND status='pending'",
            (block_id,),
        )
        stale = [r[0] for r in cur.fetchall()
                 if r[0] in CHECKABLE_REASONS and r[0] not in reasons]
        for reason in stale:
            cur.execute(
                "UPDATE review_queue SET status='approved' "
                "WHERE block_id=%s AND reason=%s AND status='pending'",
                (block_id, reason),
            )
        return len(stale)


def run_qc(conn, doc_id: str) -> int:
    """对低质 block 建复核记录（同一 block 同一原因不重复）；内容修复后自动关闭旧记录。返回新增条数。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.content_md, b.block_type FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND p.status IN ('parsed', 'failed')""",
            (doc_id,),
        )
        n = 0
        for block_id, content, block_type in cur.fetchall():
            reasons = check_content(content)
            # figure 块的内容就是裁图本身（如竖式图），空 content_md 不是缺陷
            if block_type == "figure":
                reasons = [r for r in reasons if r != "empty"]
            cur.execute(
                "SELECT reason, status FROM review_queue WHERE block_id=%s",
                (block_id,),
            )
            existing = {reason for reason, _status in cur.fetchall() if _status == "pending"}
            for reason in reasons:
                if reason in existing:
                    continue
                cur.execute(
                    "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,%s)",
                    (str(uuid.uuid4()), block_id, reason),
                )
                n += 1
            # 内容已修复的旧复核记录自动关闭（与 PATCH 编辑接口同一语义），队列只反映当前问题
            resolve_block_reviews(conn, block_id)
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

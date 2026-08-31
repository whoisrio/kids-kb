"""阶段⑤质检（骨架期 lite）：空转录/疑似截断 -> review_queue。
精度期扩展：LaTeX 编译检查、题号连续性、置信分阈值分流。"""
from __future__ import annotations

import uuid

_TRUNCATION_ENDINGS = ("…", "...", "，", "、", "；", "：")

# 机器可检测的原因：只有这些允许自动关闭；人工插入的自定义原因必须人显式 通过/打回
CHECKABLE_REASONS = frozenset({"empty", "maybe_truncated"})


def check_content(content: str | None) -> list[str]:
    if not content or not content.strip():
        return ["empty"]
    reasons = []
    if content.rstrip().endswith(_TRUNCATION_ENDINGS):
        reasons.append("maybe_truncated")
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
            """SELECT b.id, b.content_md FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND p.status IN ('parsed', 'failed')""",
            (doc_id,),
        )
        n = 0
        for block_id, content in cur.fetchall():
            reasons = check_content(content)
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

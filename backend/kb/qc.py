"""阶段⑤质检（骨架期 lite）：空转录/疑似截断 -> review_queue。
精度期扩展：LaTeX 编译检查、题号连续性、置信分阈值分流。"""
from __future__ import annotations

import uuid

_TRUNCATION_ENDINGS = ("…", "...", "，", "、", "；", "：")


def check_content(content: str | None) -> list[str]:
    if not content or not content.strip():
        return ["empty"]
    reasons = []
    if content.rstrip().endswith(_TRUNCATION_ENDINGS):
        reasons.append("maybe_truncated")
    return reasons


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
            # 内容已修复的旧复核记录自动关闭，保持队列只反映当前问题
            for stale in existing - set(reasons):
                cur.execute(
                    "UPDATE review_queue SET status='approved' WHERE block_id=%s AND reason=%s AND status='pending'",
                    (block_id, stale),
                )
    return n

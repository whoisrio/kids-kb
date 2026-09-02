"""L1 编造筛查（接地质检）：item 文字句 vs 溯源块文本。

判定"源块里压根没有这段内容"（串章/脑补续写），检出建 item 级 ungrounded 复核行。
不判定语义对错：OCR 错字被 LLM 合法修正会误报，由人工在复核行裁决；
对图 fidelity 属 L2（VLM 对裁图）。数学段（$...$/$$...$$）跳过——竖式从
ASCII 图转 LaTeX 是合法变换，字面比对必然误报。
修复后重算自动关闭对应行（机器可复算原因）。
"""
from __future__ import annotations

import re
import uuid
from difflib import SequenceMatcher

_MATH_RE = re.compile(r"\$\$[\s\S]+?\$\$|\$[^$\n]+?\$")
_DISPLAY_RE = re.compile(r"\$\$[\s\S]+?\$\$")
_INLINE_RE = re.compile(r"\$([^$\n]+?)\$")
_SPLIT_RE = re.compile(r"[。；！？\n]")
_KEEP_RE = re.compile(r"[0-9A-Za-z一-鿿]+")
_MIN_SENT_LEN = 6        # 短于此的句子豁免（栏目名等）
_COVER_THRESHOLD = 0.75  # 最长公共子串覆盖率阈值


def _normalize(text: str) -> str:
    return "".join(_KEEP_RE.findall(text)).lower()


def _to_prose(text: str) -> str:
    """两侧一致的数学段处理：独立公式块（$$...$$，竖式等合法变换）整体剔除；
    行内公式解包保留字母数字（$ABC$ -> ABC），否则含变量的正常句必误报。"""
    out = _DISPLAY_RE.sub("\n", text or "")
    out = _INLINE_RE.sub(lambda m: " " + re.sub(r"\\[a-zA-Z]+", " ", m.group(1)) + " ", out)
    return out


def _prose_sentences(content_md: str) -> list[tuple[str, str]]:
    """剥掉数学段与 markdown 记号后切句。返回 (原句, 规范化) 对。"""
    prose = _to_prose(content_md)
    prose = re.sub(r"[*#`\[\]()]", "", prose)
    out = []
    for raw in _SPLIT_RE.split(prose):
        raw = raw.strip()
        norm = _normalize(raw)
        if len(norm) >= _MIN_SENT_LEN:
            out.append((raw, norm))
    return out


def ungrounded_sentences(content_md: str, source_texts: list[str]) -> list[str]:
    """返回在源块文本中找不到出处的句子（原句摘录）。

    源文本逐块做数学段处理再合并——先拼接再剥 $$ 会把跨块的残缺定界符
    误认为一对，吞掉中间的正常文字。
    """
    src = _normalize("".join(_to_prose(t) for t in source_texts))
    bad = []
    for raw, norm in _prose_sentences(content_md):
        if norm in src:
            continue
        m = SequenceMatcher(None, norm, src).find_longest_match()
        if len(norm) and m.size / len(norm) < _COVER_THRESHOLD:
            bad.append(raw[:30])
    return bad


def _item_reasons(content_md: str, label: str, source_texts: list[str]) -> list[str]:
    if not source_texts:
        return [f"no_source:{label}"]
    bad = ungrounded_sentences(content_md, source_texts)
    if not bad:
        return []
    excerpts = " / ".join(f"“{s}”" for s in bad[:3])
    return [f"ungrounded:{label} {excerpts}"]


def sync_item_grounding(conn, item_id: str) -> int:
    """重算单条 item 的接地：新建无出处行，关闭已修复的旧行。返回新增数。"""
    with conn.cursor() as cur:
        cur.execute("SELECT label, content_md FROM items WHERE id=%s", (item_id,))
        row = cur.fetchone()
        if not row:
            return 0
        label, content_md = row
        cur.execute(
            """SELECT b.content_md FROM item_blocks ib
               JOIN blocks b ON b.id = ib.block_id
               WHERE ib.item_id=%s AND b.content_md IS NOT NULL""",
            (item_id,),
        )
        sources = [r[0] for r in cur.fetchall()]
        current = _item_reasons(content_md, label or "?", sources)
        cur.execute(
            """SELECT id, reason FROM review_queue
               WHERE item_id=%s AND status='pending'
                 AND (reason LIKE 'ungrounded:%%' OR reason LIKE 'no_source:%%')""",
            (item_id,),
        )
        pending = cur.fetchall()
        n = 0
        for reason in current:
            if any(r[1] == reason for r in pending):
                continue
            cur.execute(
                "INSERT INTO review_queue (id, item_id, reason) VALUES (%s,%s,%s)",
                (str(uuid.uuid4()), item_id, reason),
            )
            n += 1
        for rid, reason in pending:
            if reason not in current:
                cur.execute(
                    "UPDATE review_queue SET status='approved' WHERE id=%s", (rid,))
    return n


def run_grounding(conn, doc_id: str) -> int:
    """对文档全部 item 跑 L1 接地。返回新增复核行数。"""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM items WHERE document_id=%s", (doc_id,))
        ids = [str(r[0]) for r in cur.fetchall()]
    return sum(sync_item_grounding(conn, iid) for iid in ids)

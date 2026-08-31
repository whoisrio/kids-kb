"""阶段④结构化拆分：章节窗口（跨页合并）-> items + item_blocks。

块按页序编号进 prompt，模型输出每条 item 引用的块号；taxonomy/tags 取该章词表。
幂等：该章已有 items 则跳过。
"""
from __future__ import annotations

import uuid

from openai import OpenAI

from kb.config import Config
from kb.toc import _parse_json_array

_SKIP_TYPES = ("header", "footer")

STRUCTURE_PROMPT = (
    "下面是一本书某一讲的全部内容（已按阅读顺序排列，每块以【块N】编号）。\n"
    "请把它拆成条目，输出 JSON 数组，每项：\n"
    '- content_type: "example"(例题讲解，含解析) / "exercise"(练习题) / "answer"(答案解析)\n'
    "- label: 原书题号（如\"例1\"、\"3\"）\n"
    "- content_md: 该条目的完整内容（题干+例题解析），数学内容用 LaTeX（$...$）\n"
    "- block_ids: 该条目引用的块号数组\n"
    "规则：同一道题跨页/跨块要合并成一条；例题的题干和解析同属一条；只输出 JSON。\n"
    "本讲分类：{taxonomy}；思想方法：{tags}\n\n"
    "{blocks_text}"
)


def _chapter_blocks(cur, doc_id: str, page_start: int, page_end: int) -> list[tuple]:
    cur.execute(
        """SELECT b.id, b.block_type, b.content_md FROM blocks b
           JOIN pages p ON p.id = b.page_id
           WHERE p.document_id=%s AND p.page_no BETWEEN %s AND %s
             AND NOT (b.block_type = ANY(%s)) AND b.content_md IS NOT NULL
           ORDER BY p.page_no, b.created_at""",
        (doc_id, page_start, page_end, list(_SKIP_TYPES)),
    )
    return cur.fetchall()


def structure_chapter(conn, cfg: Config, doc_id: str, chapter_no: int, client=None) -> int:
    """拆分一章。返回新增 item 数。"""
    model = cfg.structure_model or cfg.vision_model
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, chapter_no, title, taxonomy, tags, page_start, page_end
               FROM chapters WHERE document_id=%s AND chapter_no=%s""",
            (doc_id, chapter_no),
        )
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"章节不存在: doc={doc_id} 第 {chapter_no} 章")
        _cid, _no, title, taxonomy, tags, page_start, page_end = row
        if page_start is None:
            return 0  # 页面未入库，跳过（放量重跑时自动补）
        chapter_label = f"第 {chapter_no} 讲 {title}"
        cur.execute(
            "SELECT 1 FROM items WHERE document_id=%s AND chapter=%s LIMIT 1",
            (doc_id, chapter_label),
        )
        if cur.fetchone():
            return 0  # 幂等
        blocks = _chapter_blocks(cur, doc_id, page_start, page_end)
        if not blocks:
            return 0
        blocks_text = "\n\n".join(
            f"【块{i + 1}】{content}" for i, (_bid, _bt, content) in enumerate(blocks)
        )
        prompt = STRUCTURE_PROMPT.format(
            taxonomy=taxonomy or "未知", tags="、".join(tags or []) or "无",
            blocks_text=blocks_text,
        )
        resp = client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": prompt}], max_tokens=8192,
        )
        entries = _parse_json_array(resp.choices[0].message.content)
        n = 0
        for entry in entries:
            item_id = str(uuid.uuid4())
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md,
                                      chapter, taxonomy, tags, page_start, page_end)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (item_id, doc_id, entry["content_type"], entry["label"], entry["content_md"],
                 chapter_label, taxonomy, tags or [], page_start, page_end),
            )
            for idx in entry.get("block_ids", []):
                if not (1 <= idx <= len(blocks)):
                    continue  # 模型引用了不存在的块号，跳过不炸
                bid, btype, _content = blocks[idx - 1]
                if entry["content_type"] == "answer":
                    role = "solution"
                elif btype in ("figure", "table"):
                    role = "figure"
                else:
                    role = "stem"
                cur.execute(
                    "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (item_id, bid, role),
                )
            n += 1
    return n


def pair_items(conn, doc_id: str) -> int:
    """按 label 精确配对 answer <-> exercise/example。返回新增配对数。"""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE items a SET paired_item_id = q.id
               FROM items q
               WHERE a.document_id=%s AND q.document_id=%s
                 AND a.content_type='answer' AND q.content_type <> 'answer'
                 AND a.label = q.label AND a.paired_item_id IS NULL""",
            (doc_id, doc_id),
        )
        n1 = cur.rowcount
        cur.execute(
            """UPDATE items q SET paired_item_id = a.id
               FROM items a
               WHERE a.document_id=%s AND q.document_id=%s
                 AND a.content_type='answer' AND q.content_type <> 'answer'
                 AND a.label = q.label AND q.paired_item_id IS NULL""",
            (doc_id, doc_id),
        )
        return n1  # 配对数按 answer 侧计（双向回写是同一对的两侧）

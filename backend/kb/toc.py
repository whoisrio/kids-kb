"""目录页解析 -> chapters（章节/印刷页码/分类/思想方法标签，词表的唯一事实来源）。

目录页自动探测：前 15 页中块文本含"目录"的页；也可显式传 toc_pages。
幂等：已有章节的文档直接跳过。
"""
from __future__ import annotations

import json
import re
import uuid

from openai import OpenAI

from kb.config import Config
from kb.parse import transcribe_image

TOC_PROMPT = (
    "这是一本书的目录页。请提取所有章节，输出 JSON 数组，每项包含：\n"
    "- chapter_no: 章节序号（整数，如\"第 3 讲\"输出 3）\n"
    "- title: 章节标题（不含\"第 N 讲\"前缀）\n"
    "- print_page: 目录标注的印刷页码（整数）\n"
    "- taxonomy: 右侧分类标签（如\"计算类\"/\"几何类\"，没有则 null）\n"
    "- tags: 右侧思想方法标签数组（如[\"倒推法\",\"枚举法\"]，没有则 []）\n"
    "只输出 JSON，不要任何其他文字。"
)


def _parse_json_array(text: str) -> list[dict]:
    """剥掉 markdown 代码围栏后解析 JSON 数组。"""
    cleaned = re.sub("`" * 3 + "(?:json)?", "", text).strip()
    return json.loads(cleaned)


def _detect_toc_pages(cur, doc_id: str) -> list[int]:
    cur.execute(
        """SELECT DISTINCT p.page_no FROM pages p
           JOIN blocks b ON b.page_id = p.id
           WHERE p.document_id=%s AND p.page_no <= 15 AND b.content_md LIKE %s
           ORDER BY p.page_no""",
        (doc_id, "%目录%"),
    )
    return [r[0] for r in cur.fetchall()]


def extract_toc(conn, cfg: Config, doc_id: str, client=None,
                toc_pages: list[int] | None = None) -> int:
    """解析目录页写入 chapters。返回新增章节数。"""
    model = cfg.structure_model or cfg.vision_model
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM chapters WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            return 0
        pages = toc_pages if toc_pages is not None else _detect_toc_pages(cur, doc_id)
        if not pages:
            raise SystemExit("未找到目录页，请用 --toc-pages 显式指定")
        n = 0
        for page_no in pages:
            cur.execute(
                "SELECT image_path FROM pages WHERE document_id=%s AND page_no=%s",
                (doc_id, page_no),
            )
            row = cur.fetchone()
            if not row:
                continue
            text = transcribe_image(client, model, row[0], prompt=TOC_PROMPT)
            for entry in _parse_json_array(text):
                cur.execute(
                    """INSERT INTO chapters (id, document_id, chapter_no, title,
                                             print_page, taxonomy, tags)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (document_id, chapter_no) DO NOTHING""",
                    (str(uuid.uuid4()), doc_id, entry["chapter_no"], entry["title"],
                     entry.get("print_page"), entry.get("taxonomy"),
                     entry.get("tags") or []),
                )
                n += 1
    return n


def calibrate_pages(conn, doc_id: str) -> int:
    """把印刷页码换算为物理页范围：章节标题在已解析块文本中的首次出现页为首页。
    找不到的章节留 NULL（页面未入库，放量重跑时自动补上）。返回成功定位数。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, title FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = cur.fetchall()
        located = []  # (chapter_id, page_start)
        for cid, title in chapters:
            # 排除目录页：目录页包含所有章节标题，直接搜"首次出现页"会全命中目录
            cur.execute(
                """SELECT p.page_no FROM pages p
                   JOIN blocks b ON b.page_id = p.id
                   WHERE p.document_id=%s AND b.content_md LIKE %s
                     AND NOT EXISTS (SELECT 1 FROM blocks b2
                                     WHERE b2.page_id = p.id
                                       AND b2.content_md LIKE %s)
                   ORDER BY p.page_no LIMIT 1""",
                (doc_id, f"%{title}%", "%目录%"),
            )
            row = cur.fetchone()
            if row:
                located.append((cid, row[0]))
        cur.execute("SELECT max(page_no) FROM pages WHERE document_id=%s", (doc_id,))
        max_page = cur.fetchone()[0] or 0
        for i, (cid, start) in enumerate(located):
            end = (located[i + 1][1] - 1) if i + 1 < len(located) else max_page
            cur.execute(
                "UPDATE chapters SET page_start=%s, page_end=%s WHERE id=%s",
                (start, end, cid),
            )
    return len(located)

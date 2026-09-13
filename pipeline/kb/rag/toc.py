"""目录页解析 -> chapters（章节/印刷页码/分类/思想方法标签，词表的唯一事实来源）。

目录页自动探测：前 15 页中块文本含"目录"的页；也可显式传 toc_pages。
幂等：已有章节的文档直接跳过。
"""
from __future__ import annotations

import json
import re
import uuid

from openai import OpenAI

from kb.core.config import Config
from kb.core.paths import resolve_storage_path
from kb.telemetry.metering import record_llm_call
from kb.ocr.parse import transcribe_image

TOC_PROMPT = (
    "这是一本书的目录页。请提取所有章节，输出 JSON 数组，每项包含：\n"
    "- chapter_no: 章节序号（整数，如\"第 3 讲\"输出 3）\n"
    "- title: 章节标题（不含\"第 N 讲\"前缀）\n"
    "- print_page: 目录标注的印刷页码（整数）\n"
    "- taxonomy: 右侧分类标签（如\"计算类\"/\"几何类\"，没有则 null）\n"
    "- tags: 右侧思想方法标签数组（如[\"倒推法\",\"枚举法\"]，没有则 []）\n"
    "只输出 JSON，不要任何其他文字。"
)


def normalize_toc_entries(raw: list[dict]) -> list[dict]:
    """把模型输出的目录条目规整为可落库形态。

    chapter_no 必须是正整数（DB 列 INTEGER）：数字/数字字符串直取，
    "第一单元" 之类非数字编号按出现顺序重排为 1..N；
    无 title 的脏条目丢弃，编号重排后保证连续不跳号。
    taxonomy/tags 是该书词表的唯一事实来源，必须原样保留（仅规整空白）。
    """
    cleaned: list[dict] = []
    for entry in raw:
        title = (entry.get("title") or "").strip()
        if not title:
            continue
        page = entry.get("print_page")
        page = int(page) if isinstance(page, (int, float)) or (
            isinstance(page, str) and page.strip().isdigit()) else None
        taxonomy = entry.get("taxonomy")
        taxonomy = taxonomy.strip() or None if isinstance(taxonomy, str) else None
        tags = entry.get("tags")
        tags = [t.strip() for t in tags if isinstance(t, str) and t.strip()] \
            if isinstance(tags, list) else []
        no = entry.get("chapter_no")
        if isinstance(no, int):
            no_val = no
        else:
            s = str(no or "").strip()
            m = re.search(r"\d+", s)
            no_val = int(m.group()) if m else 0
        cleaned.append({"chapter_no": no_val, "title": title, "print_page": page,
                        "taxonomy": taxonomy, "tags": tags})
    for i, entry in enumerate(cleaned, start=1):
        entry["chapter_no"] = i
    return cleaned


def _parse_json_array(text: str) -> list[dict]:
    """剥掉 markdown 代码围栏后解析 JSON 数组。

    模型常在字符串里直接写 LaTeX（\\s \\p 这类非法 JSON 转义），
    首轮解析失败时把非法反斜杠转义后重试。
    """
    cleaned = re.sub("`" * 3 + "(?:json)?", "", text).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        fixed = re.sub(r'\\(?![\\"/bfnrtu])', r"\\\\", cleaned)
        return json.loads(fixed)


def detect_toc_pages(cur, doc_id: str) -> list[int]:
    """自动探测目录页：前 15 页里块文本含「目录」的页。
    目录横幅常是艺术字，OCR 会拆成「目\\n录」——剥掉空白后再匹配。"""
    cur.execute(
        """SELECT DISTINCT p.page_no FROM pages p
           JOIN blocks b ON b.page_id = p.id
           WHERE p.document_id=%s AND p.page_no <= 15
             AND regexp_replace(b.content_md, '\\s', '', 'g') LIKE %s
           ORDER BY p.page_no""",
        (doc_id, "%目录%"),
    )
    return [r[0] for r in cur.fetchall()]


def extract_toc(conn, cfg: Config, doc_id: str, client=None,
                toc_pages: list[int] | None = None, recorder=None) -> int:
    """解析目录页写入 chapters。返回新增章节数。"""
    base_url, api_key, model = cfg.doc_ognize_endpoint()
    client = client or OpenAI(base_url=base_url, api_key=api_key)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM chapters WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            return 0
        pages = toc_pages if toc_pages is not None else detect_toc_pages(cur, doc_id)
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
            image_path = str(resolve_storage_path(cfg, row[0]))
            text, usage = transcribe_image(client, model, image_path, prompt=TOC_PROMPT)
            record_llm_call(conn, doc_id, "toc", model, usage,
                            recorder=recorder, stage="structure",
                            prompt=TOC_PROMPT, output=text)
            for entry in normalize_toc_entries(_parse_json_array(text)):
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
    """把印刷页码换算为物理页范围，返回成功定位数。两条路径：

    1. 页脚偏移（优先）：footer 块的纯数字内容是印刷页码，拟合 物理页-印刷页
       偏移众数，print_page+offset 即物理首页。章节横幅是艺术字、OCR 不可靠
       （真实事故：「乘除法竖式谜」被 OCR 成「乘\\n除法竖式识\\n式谜\\n金」），
       而页脚页码是纯数字，稳定得多。
    2. 标题首次出现（兜底）：找不到页脚偏移时按标题文本搜首次出现页。

    目录页识别双判据：剥空白后含「目录」（横幅艺术字被 OCR 拆成「目\\n录」也能中），
    或标题密度（命中 ≥半数且 ≥2 个章节标题，应对横幅是纯图片 OCR 不出的情况）。
    只靠搜「目录」字面量曾导致全书章节都定位到目录页（page_start=5, page_end=4）。
    找不到的章节留 NULL（页面未入库，放量重跑时自动补上）。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, title, print_page FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = cur.fetchall()
        cur.execute("SELECT max(page_no) FROM pages WHERE document_id=%s", (doc_id,))
        max_page = cur.fetchone()[0] or 0
        offset = _print_page_offset(cur, doc_id)
        located = []  # (chapter_id, page_start)
        if offset is not None:
            for cid, _title, print_page in chapters:
                if print_page is None:
                    continue
                start = print_page + offset
                if start <= max_page:  # 物理页未入库的章留 NULL
                    located.append((cid, start))
        else:
            cur.execute(
                """SELECT p.page_no, string_agg(b.content_md, '\\n') FROM pages p
                   JOIN blocks b ON b.page_id = p.id
                   WHERE p.document_id=%s AND b.content_md IS NOT NULL
                   GROUP BY p.page_no""",
                (doc_id,),
            )
            page_text = cur.fetchall()
            n_ch = len(chapters)
            toc_pages = set()
            for page_no, text in page_text:
                text = text or ""
                # 判据一：剥空白后含「目录」（横幅艺术字被 OCR 拆成「目\n录」也能中）
                if "目录" in re.sub(r"\s", "", text):
                    toc_pages.add(page_no)
                    continue
                # 判据二：标题密度——命中 ≥半数且 ≥2 个章节标题
                # （横幅纯图片 OCR 不出「目录」时的兜底；单章目录页靠判据一）
                hits = sum(1 for _, t, _ in chapters if t in text)
                if hits >= 2 and hits * 2 >= n_ch:
                    toc_pages.add(page_no)
            for cid, title, _ in chapters:
                starts = [page_no for page_no, text in page_text
                          if title in (text or "") and page_no not in toc_pages]
                if starts:
                    located.append((cid, min(starts)))
        for i, (cid, start) in enumerate(located):
            end = (located[i + 1][1] - 1) if i + 1 < len(located) else max_page
            cur.execute(
                "UPDATE chapters SET page_start=%s, page_end=%s WHERE id=%s",
                (start, end, cid),
            )
    return len(located)


def _print_page_offset(cur, doc_id: str) -> int | None:
    """从 footer 块拟合 物理页-印刷页 偏移众数；拟合不出返回 None。
    页脚混有 Logo/装饰文字，只认剥掉非数字后的纯数字（'$$ 2 $$' → 2）。"""
    cur.execute(
        """SELECT p.page_no, b.content_md FROM blocks b
           JOIN pages p ON p.id = b.page_id
           WHERE p.document_id=%s AND b.block_type='footer' AND b.content_md IS NOT NULL""",
        (doc_id,),
    )
    votes: dict[int, int] = {}
    for page_no, content in cur.fetchall():
        digits = re.sub(r"\D", "", content or "")
        if not digits:
            continue
        print_no = int(digits)
        if not 0 < print_no <= page_no:  # 印刷页必 ≤ 物理页（前面还有封面/目录）
            continue
        off = page_no - print_no
        votes[off] = votes.get(off, 0) + 1
    if not votes:
        return None
    return max(votes, key=votes.get)

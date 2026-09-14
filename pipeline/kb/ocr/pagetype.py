"""页类型判定：toc/ad/cover 页默认排除索引（原文保留，不参与向量化）。

判定在 parse/qc 之后跑（块已有转录内容），规则保守（宁可漏判不误伤正文）：
- toc：前 15 页块文本剥空白含「目录」（与 rag.toc.detect_toc_pages 同口径）；
- ad：命中广告关键词且无题目特征、实质文本稀薄——「扫码看视频」这类正文页
  二维码靠题目特征兜底排除；
- cover：第 1 页且除页眉页脚外无实质文本。

只降级不升级：page_type 一旦判为非 content 不再回判——人工经
/internal/page-exclusion 恢复（excluded=false）的页不会被重判覆盖。
"""
from __future__ import annotations

import re

_AD_KEYWORDS = ("公众号", "扫码", "二维码", "关注", "领取", "抖音", "小红书", "视频号", "客服")
_QUESTION_HINT = re.compile(r"(例\s*\d|练\s*\d|\d{1,2}\s*[.、]|[=＝]|答[:：]|解[:：])")
_AD_MAX_CHARS = 400


def classify_pages(conn, doc_id: str, recorder=None) -> dict:
    """判定页类型，toc/ad/cover 页置 excluded_from_index=true。返回各类新增计数。"""
    from kb.rag.toc import detect_toc_pages

    counts = {"toc": 0, "ad": 0, "cover": 0}
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.id::text, p.page_no FROM pages p
               WHERE p.document_id=%s AND p.page_type='content' ORDER BY p.page_no""",
            (doc_id,),
        )
        candidates = cur.fetchall()
        if not candidates:
            return counts
        toc_pages = set(detect_toc_pages(cur, doc_id))
        cur.execute(
            """SELECT p.page_no, b.block_type, b.content_md FROM pages p
               JOIN blocks b ON b.page_id = p.id
               WHERE p.document_id=%s AND b.content_md IS NOT NULL""",
            (doc_id,),
        )
        text_by_page: dict[int, str] = {}
        for page_no, btype, content in cur.fetchall():
            if btype in ("header", "footer"):
                continue
            text_by_page[page_no] = text_by_page.get(page_no, "") + re.sub(
                r"\s", "", content or "")
        for page_id, page_no in candidates:
            text = text_by_page.get(page_no, "")
            page_type = None
            if page_no in toc_pages:
                page_type = "toc"
            elif (any(k in text for k in _AD_KEYWORDS)
                    and not _QUESTION_HINT.search(text)
                    and len(text) <= _AD_MAX_CHARS):
                page_type = "ad"
            elif page_no == 1 and not text:
                page_type = "cover"
            if page_type:
                cur.execute(
                    "UPDATE pages SET page_type=%s, excluded_from_index=true WHERE id=%s",
                    (page_type, page_id),
                )
                counts[page_type] += 1
    if recorder is not None and any(counts.values()):
        recorder.decision(
            "pagetype",
            f"页类型判定：目录 {counts['toc']} / 广告 {counts['ad']} / 封面 {counts['cover']} 页排除索引",
            payload=counts,
        )
    return counts

"""页类型判定：toc/ad/cover 页默认排除索引（原文保留，不参与向量化）。

需要 KB_TEST_DATABASE_URL。
"""
import uuid

import pytest


def _mk_doc(cur) -> str:
    cur.execute(
        "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/pt.pdf') RETURNING id::text"
    )
    return cur.fetchone()[0]


def _mk_page(cur, doc_id: str, page_no: int) -> str:
    cur.execute(
        "INSERT INTO pages (document_id, page_no, image_path, parse_status)"
        " VALUES (%s,%s,'/tmp/x.png','parsed') RETURNING id::text",
        (doc_id, page_no),
    )
    return cur.fetchone()[0]


def _mk_block(cur, page_id: str, btype: str, content: str | None) -> None:
    cur.execute(
        """INSERT INTO blocks (page_id, block_type, crop_path, content_md, ordinal)
           VALUES (%s,%s,'/tmp/c.png',%s,
                   (SELECT coalesce(max(ordinal), 0) + 1 FROM blocks WHERE page_id=%s))""",
        (page_id, btype, content, page_id),
    )


@pytest.fixture()
def book(conn):
    """封面(纯图) / 目录页 / 正文页(带扫码关键词) / 广告页 / 正文页。"""
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
        p1 = _mk_page(cur, doc_id, 1)
        _mk_block(cur, p1, "figure", None)  # 封面：只有图，无实质文本
        p2 = _mk_page(cur, doc_id, 2)
        _mk_block(cur, p2, "text", "目 录\n第 1 讲 乘法口算 …… 1\n第 2 讲 除法 …… 9")
        p3 = _mk_page(cur, doc_id, 3)
        _mk_block(cur, p3, "text", "例1 直接写出得数 23×12=")
        _mk_block(cur, p3, "text", "扫码看视频讲解")  # 含广告关键词但有题目 → 正文
        p4 = _mk_page(cur, doc_id, 4)
        _mk_block(cur, p4, "text", "关注公众号「学霸资料库」，扫码领取更多学习资料")
        _mk_block(cur, p4, "figure", None)
        p5 = _mk_page(cur, doc_id, 5)
        _mk_block(cur, p5, "text", "1. 直接写出得数 34+25=")
    return conn, doc_id


def _page_types(conn, doc_id) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_no, page_type, excluded_from_index FROM pages"
            " WHERE document_id=%s ORDER BY page_no",
            (doc_id,),
        )
        return {r[0]: (r[1], r[2]) for r in cur.fetchall()}


def test_classify_marks_toc_ad_cover(book):
    from kb.ocr.pagetype import classify_pages

    conn, doc_id = book
    out = classify_pages(conn, doc_id)
    assert out == {"toc": 1, "ad": 1, "cover": 1}
    types = _page_types(conn, doc_id)
    assert types[1] == ("cover", True)
    assert types[2] == ("toc", True)
    assert types[4] == ("ad", True)


def test_content_pages_untouched(book):
    from kb.ocr.pagetype import classify_pages

    conn, doc_id = book
    classify_pages(conn, doc_id)
    types = _page_types(conn, doc_id)
    assert types[3] == ("content", False)  # 带「扫码」关键词但有题目，不误判
    assert types[5] == ("content", False)


def test_classify_idempotent_and_preserves_manual_restore(book):
    """重跑不改判；人工恢复（excluded=false）的页不被重新排除。"""
    from kb.ocr.pagetype import classify_pages

    conn, doc_id = book
    classify_pages(conn, doc_id)
    with conn.cursor() as cur:  # 人工恢复广告页
        cur.execute(
            "UPDATE pages SET excluded_from_index=false WHERE document_id=%s AND page_no=4",
            (doc_id,),
        )
    out = classify_pages(conn, doc_id)
    assert out == {"toc": 0, "ad": 0, "cover": 0}
    types = _page_types(conn, doc_id)
    assert types[4] == ("ad", False)  # 类型保留、排除状态不覆盖人工决定

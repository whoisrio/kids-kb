import uuid

import pymupdf as fitz
import pytest


def _cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def doc3(conn, tmp_path):
    """3 页文档，每页 1 个整页块（骨架模式）。"""
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "book.pdf"
    d = fitz.open()
    for _ in range(3):
        d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    return doc_id, cfg


class _FakeRes:
    def __init__(self, blocks):
        self.json = {"res": {"parsing_res_list": blocks}}


class FakeVL:
    """假 PaddleOCR-VL 整管线：predict 返回自带识别内容的区块。"""

    def __init__(self, blocks):
        self._blocks = blocks

    def predict(self, path):
        return [_FakeRes(self._blocks)]


FAKE_BLOCKS = [
    {"block_label": "text", "block_bbox": [0, 0, 100, 50], "block_content": "新内容一"},
    {"block_label": "display_formula", "block_bbox": [0, 60, 100, 100],
     "block_content": "$$1+1=2$$"},
    {"block_label": "figure", "block_bbox": [0, 110, 100, 160], "block_content": ""},
]


def test_reprocess_replaces_page_blocks(conn, doc3):
    from kb.reprocess import reprocess_pages_paddleocr

    doc_id, cfg = doc3
    with conn.cursor() as cur:  # 第 2 页旧块挂上复核行；第 1 章覆盖 1-2 页且已有 item
        cur.execute(
            """INSERT INTO review_queue (block_id, reason)
               SELECT b.id, 'empty' FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=2"""
        )
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, page_start, page_end)
               VALUES (%s,%s,1,'乘法',1,2)""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            """INSERT INTO items (document_id, content_type, label, chapter)
               VALUES (%s,'example','例1','第 1 讲 乘法')""",
            (doc_id,),
        )

    stats = reprocess_pages_paddleocr(conn, cfg, doc_id, [2], pipeline=FakeVL(FAKE_BLOCKS))

    assert stats["blocks"] == 3
    assert stats["items_deleted"] == 1
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.block_type, b.content_md FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=2
               ORDER BY b.created_at, b.id"""
        )
        # 空内容的 figure 落 NULL（留给 run_parse 用视觉模型补转录），不是空串
        assert cur.fetchall() == [("text", "新内容一"), ("formula", "$$1+1=2$$"),
                                  ("figure", None)]
        cur.execute("SELECT parse_status FROM pages WHERE page_no=2")
        assert cur.fetchone()[0] == "parsed"  # 内容已带，不再走分级解析
        cur.execute("SELECT count(*) FROM review_queue")
        assert cur.fetchone()[0] == 0  # 复核行随旧块级联删除
        cur.execute("SELECT count(*) FROM items")
        assert cur.fetchone()[0] == 0  # 受影响章节的旧 items 清掉，等 structure 重建
        cur.execute(
            """SELECT count(*) FROM blocks b JOIN pages p ON p.id=b.page_id
               WHERE p.page_no IN (1,3)"""
        )
        assert cur.fetchone()[0] == 2  # 未指定的页不动


def test_reprocess_keeps_unaffected_chapter_items(conn, doc3):
    from kb.reprocess import reprocess_pages_paddleocr

    doc_id, cfg = doc3
    with conn.cursor() as cur:  # 第 2 章在第 3 页，与重处理的第 2 页不相交
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, page_start, page_end)
               VALUES (%s,%s,1,'乘法',1,2), (%s,%s,2,'除法',3,3)""",
            (str(uuid.uuid4()), doc_id, str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            """INSERT INTO items (document_id, content_type, label, chapter)
               VALUES (%s,'example','例1','第 2 讲 除法')""",
            (doc_id,),
        )

    stats = reprocess_pages_paddleocr(conn, cfg, doc_id, [2], pipeline=FakeVL(FAKE_BLOCKS))

    assert stats["items_deleted"] == 0
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM items")
        assert cur.fetchone()[0] == 1  # 不相交章节的 items 保留


def test_reprocess_upgrades_star_vertical_arithmetic_to_vlm(conn, doc3):
    """VL 直出的疑似竖式文本块（多行星号/方框）不信任：改标 formula + 内容置 NULL，
    留给 run_parse 用视觉模型升级转录。"""
    from kb.reprocess import reprocess_pages_paddleocr

    doc_id, cfg = doc3
    star_block = {"block_label": "text", "block_bbox": [0, 0, 100, 100],
                  "block_content": "我你他\n×你我他\n***我\n***你\n******"}
    stats = reprocess_pages_paddleocr(conn, cfg, doc_id, [2],
                                      pipeline=FakeVL([star_block]))
    assert stats["blocks"] == 1
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.block_type, b.content_md FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=2""")
        assert cur.fetchall() == [("formula", None)]


def test_reprocess_keeps_normal_text_block(conn, doc3):
    """普通文字块不误升级：只一行含符号或纯文字都保持 text + VL 直出内容。"""
    from kb.reprocess import reprocess_pages_paddleocr

    doc_id, cfg = doc3
    blocks = [
        {"block_label": "text", "block_bbox": [0, 0, 100, 40],
         "block_content": "在下面的竖式中，不同的汉字表示不同的数字。"},
        {"block_label": "text", "block_bbox": [0, 50, 100, 90],
         "block_content": "由 9×4=36 推出除数个位为 4"},  # 只一行含 ×，不算竖式
    ]
    reprocess_pages_paddleocr(conn, cfg, doc_id, [2], pipeline=FakeVL(blocks))
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.block_type, b.content_md IS NOT NULL FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=2 ORDER BY b.created_at""")
        assert cur.fetchall() == [("text", True), ("text", True)]

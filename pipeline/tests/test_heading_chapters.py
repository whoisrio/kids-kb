"""heading 模式：无目录文档用一级标题合成章节——schema、章节合成、模式判定、编排。
设计：一级标题（blocks.title_level=1，0024）≥2 个时替代 flat 兜底。"""
import base64
import uuid

import pytest

_TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def test_struct_mode_accepts_heading(conn):
    """0025：struct_mode 受控词表放宽为 toc|flat|heading。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('x', %s) RETURNING id",
            (f"/tmp/{uuid.uuid4()}.pdf",),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute("UPDATE documents SET struct_mode='heading' WHERE id=%s", (doc_id,))
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        assert cur.fetchone()[0] == "heading"
        with pytest.raises(Exception):
            cur.execute("UPDATE documents SET struct_mode='bogus' WHERE id=%s", (doc_id,))


@pytest.fixture()
def heading_doc(conn, tmp_path):
    """无目录练习册：4 页，一级标题在页 2「第一章 口算」和页 3「第二章 竖式」。
    页 1 无一级标题；页 4 只有正文；页 3 另有二级标题（不参与合成）。"""
    from kb.core.config import Config

    png = tmp_path / "p.png"
    png.write_bytes(base64.b64decode(_TINY_PNG))
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, doc_type, source_path)
               VALUES (%s, '标题分章练习册', '数学', 'workbook', %s) RETURNING id""",
            (str(uuid.uuid4()), f"/tmp/{uuid.uuid4()}.pdf"),
        )
        doc_id = str(cur.fetchone()[0])
        spec = [
            (1, [("text", "一、口算 24+37=", None)]),
            (2, [("title", " 第一章 口算 ", 1), ("text", "例1 在下面方框填上合适的数字", None)]),
            (3, [("title", "第二章 竖式", 1), ("title", "2.1 竖式入门", 2),
                 ("text", "1. 竖式 135÷5=", None)]),
            (4, [("text", "2. 盼望祖国早日统一", None)]),
        ]
        for page_no, blocks in spec:
            cur.execute(
                """INSERT INTO pages (id, document_id, page_no, image_path, parse_status)
                   VALUES (%s,%s,%s,%s,'parsed') RETURNING id""",
                (str(uuid.uuid4()), doc_id, page_no, str(png)),
            )
            page_id = str(cur.fetchone()[0])
            for btype, content, level in blocks:
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md,
                                           ordinal, title_level)
                       VALUES (%s,%s,%s,'/tmp/c.png',%s,
                               (SELECT coalesce(max(ordinal), 0) + 1
                                FROM blocks WHERE page_id=%s), %s)""",
                    (str(uuid.uuid4()), page_id, btype, content, page_id, level),
                )
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    return doc_id, cfg


def test_synthesize_heading_chapters(conn, heading_doc):
    """2 个一级标题 -> 2 章：剥编号前缀（与 toc 同口径）、页范围顺排、末章到文档最大页。"""
    from kb.rag.heading_chapters import synthesize_heading_chapters

    doc_id, _cfg = heading_doc
    assert synthesize_heading_chapters(conn, doc_id) == 2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT chapter_no, title, page_start, page_end, print_page, taxonomy, tags
               FROM chapters WHERE document_id=%s ORDER BY chapter_no""",
            (doc_id,),
        )
        assert cur.fetchall() == [
            (1, "口算", 2, 2, None, None, []),
            (2, "竖式", 3, 4, None, None, []),
        ]


def test_synthesize_skips_fewer_than_two_headings(conn, heading_doc):
    """只有 1 个一级标题 -> 不合成（一章的书合成没意义），返回 0。"""
    from kb.rag.heading_chapters import synthesize_heading_chapters

    doc_id, _cfg = heading_doc
    with conn.cursor() as cur:
        cur.execute("DELETE FROM blocks WHERE title_level=1 AND content_md LIKE '%第一章%'")
    assert synthesize_heading_chapters(conn, doc_id) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chapters WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0


def test_synthesize_ignores_headings_on_excluded_pages(conn, heading_doc):
    """excluded_from_index 的页上的一级标题不参与合成。"""
    from kb.rag.heading_chapters import synthesize_heading_chapters

    doc_id, _cfg = heading_doc
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET excluded_from_index=true WHERE document_id=%s AND page_no=3",
            (doc_id,),
        )
    assert synthesize_heading_chapters(conn, doc_id) == 0  # 只剩 1 个有效标题


def test_synthesize_idempotent(conn, heading_doc):
    """已有章节的文档直接跳过返回 0（仿 extract_toc 幂等）。"""
    from kb.rag.heading_chapters import synthesize_heading_chapters

    doc_id, _cfg = heading_doc
    assert synthesize_heading_chapters(conn, doc_id) == 2
    assert synthesize_heading_chapters(conn, doc_id) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chapters WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 2


def _add_block(conn, doc_id, page_no, content, title_level=None, btype="text"):
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md,
                                   ordinal, title_level)
               SELECT %s, id, %s, '/tmp/c.png', %s,
                      (SELECT coalesce(max(ordinal), 0) + 1 FROM blocks WHERE page_id=pages.id),
                      %s
               FROM pages WHERE document_id=%s AND page_no=%s""",
            (str(uuid.uuid4()), btype, content, title_level, doc_id, page_no),
        )


def test_resolve_mode_heading(conn, heading_doc):
    """无目录页 + ≥2 个一级标题 -> 'heading'。"""
    from kb.rag.flat import resolve_mode

    doc_id, _cfg = heading_doc
    with conn.cursor() as cur:
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "heading"


def test_resolve_mode_single_heading_falls_flat(conn, heading_doc):
    """只有 1 个一级标题 -> 仍回退 'flat'。"""
    from kb.rag.flat import resolve_mode

    doc_id, _cfg = heading_doc
    with conn.cursor() as cur:
        cur.execute("DELETE FROM blocks WHERE title_level=1 AND content_md LIKE '%第一章%'")
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "flat"


def test_resolve_mode_toc_page_beats_heading(conn, heading_doc):
    """有目录页时仍走 toc（一级标题不抢目录）。"""
    from kb.rag.flat import resolve_mode

    doc_id, _cfg = heading_doc
    _add_block(conn, doc_id, 1, "目录 第一章 口算")
    with conn.cursor() as cur:
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "toc"
        assert resolve_mode(cur, doc_id, flat=True, toc_pages=None) == "flat"  # --flat 最高优先


_FENCE = "`" * 3


def _client_seq(texts):
    """按调用顺序弹回预设响应（同 tests/test_flat.py 手法）。"""
    seq = list(texts)

    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = seq.pop(0)

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client()


_ITEMS_CH1 = ('[{"content_type": "example", "label": "例1",'
              ' "content_md": "在下面方框填上合适的数字", "block_ids": [2]}]')
_ITEMS_CH2 = ('[{"content_type": "exercise", "label": "1",'
              ' "content_md": "竖式 135÷5=", "block_ids": [3]},'
              '{"content_type": "exercise", "label": "2",'
              ' "content_md": "盼望祖国早日统一", "block_ids": [4]}]')


def test_run_structure_heading_full(conn, heading_doc):
    """heading 全链路：合成 2 章 -> 逐章拆题 -> items 带章标签 -> struct_mode='heading'。"""
    from kb.rag.structure import run_structure

    doc_id, cfg = heading_doc
    out = run_structure(conn, cfg, doc_id, client=_client_seq([_ITEMS_CH1, _ITEMS_CH2]))
    assert out == {"mode": "heading", "chapters": 2, "items": 3}
    with conn.cursor() as cur:
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        assert cur.fetchone()[0] == "heading"
        cur.execute(
            """SELECT chapter, label, page_start, page_end FROM items
               WHERE document_id=%s ORDER BY chapter, label""",
            (doc_id,),
        )
        assert cur.fetchall() == [
            ("第 1 讲 口算", "例1", 2, 2),
            ("第 2 讲 竖式", "1", 3, 4),
            ("第 2 讲 竖式", "2", 3, 4),
        ]
        cur.execute("SELECT count(*) FROM chapters WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 2


def test_run_structure_heading_recovers_from_flat(conn, heading_doc):
    """曾回退 flat 的文档（未向量化）加标题后可切 heading：flat 合成章被清理。"""
    from kb.rag.structure import run_structure

    doc_id, cfg = heading_doc
    with conn.cursor() as cur:  # 先摘除全部一级标题，让首轮走 flat
        cur.execute("UPDATE blocks SET title_level=NULL WHERE title_level=1")
    assert run_structure(conn, cfg, doc_id)["mode"] == "flat"
    with conn.cursor() as cur:
        cur.execute("UPDATE blocks SET title_level=1 WHERE block_type='title'"
                    " AND content_md LIKE '%第_章%'")
    out = run_structure(conn, cfg, doc_id, client=_client_seq([_ITEMS_CH1, _ITEMS_CH2]))
    assert out == {"mode": "heading", "chapters": 2, "items": 3}
    with conn.cursor() as cur:
        cur.execute(
            "SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        assert cur.fetchone()[0] == "heading"

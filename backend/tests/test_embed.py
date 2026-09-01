"""检索期：章节组装、approved 条目向量化（bge-m3 + pgvector）、语义检索、编辑失效。"""
import uuid

import pymupdf as fitz
import pytest


@pytest.fixture()
def doc_chapter(conn, tmp_path):
    """1 书 1 章（页 1-2）：页 1 两块，页 2 采用整页版。两条 item（一条 approved）。"""
    from kb.config import Config
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "s.pdf"
    d = fitz.open()
    for _ in range(2):
        d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="7星学霸", subject="数学", grade="四年级")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md='例1 在方框中填入合适的数字' WHERE block_type='page'")
        cur.execute(
            "UPDATE pages SET page_md='第 2 页整页稿', adopted_source='page_md' WHERE page_no=2")
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, taxonomy, tags,
                                     page_start, page_end)
               VALUES (%s,%s,1,'乘除法竖式谜','计算类',ARRAY['倒推法'],1,2)""",
            (str(uuid.uuid4()), doc_id),
        )
        for label, qc in [("例1", "approved"), ("1-1", "pending")]:
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md,
                                      chapter, taxonomy, tags, page_start, page_end, qc_status)
                   VALUES (%s,%s,'example',%s,%s,'第 1 讲 乘除法竖式谜','计算类',
                           ARRAY['倒推法'],1,2,%s)""",
                (str(uuid.uuid4()), doc_id, label, f"**{label}** 内容", qc),
            )
    return doc_id, cfg


def test_assemble_chapter_mixed_sources(conn, doc_chapter):
    """章节组装：采用整页版的页用 page_md，其余页用块文本，页间带页码标记。"""
    from kb.assemble import assemble_chapter

    doc_id, _cfg = doc_chapter
    md = assemble_chapter(conn, doc_id, 1)
    assert "例1 在方框中填入合适的数字" in md
    assert "第 2 页整页稿" in md


def test_embed_only_approved_and_idempotent(conn, doc_chapter):
    from kb.embed import embed_approved_items

    doc_id, cfg = doc_chapter
    n = embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    assert n == 1  # 只有 approved 的例1
    with conn.cursor() as cur:
        cur.execute("SELECT meta->>'label', vector_dims(embedding) FROM chunks")
        label, dims = cur.fetchone()
        assert label == "例1" and dims == 1024
        cur.execute("SELECT meta->>'chapter', meta->>'taxonomy' FROM chunks")
        assert cur.fetchone() == ("第 1 讲 乘除法竖式谜", "计算类")
    assert embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed()) == 0  # 幂等


def test_edit_invalidates_chunk(conn, doc_chapter):
    """条目内容被改 -> 旧向量失效删除，等下次 embed 重建。"""
    from kb.embed import embed_approved_items, invalidate_chunk

    doc_id, cfg = doc_chapter
    embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute("SELECT item_id FROM chunks")
        item_id = cur.fetchone()[0]
    invalidate_chunk(conn, str(item_id))
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chunks")
        assert cur.fetchone()[0] == 0


def test_search_returns_nearest_with_meta(conn, doc_chapter):
    """向量检索：近的排前，带条目 meta。"""
    from kb.embed import embed_approved_items, search

    doc_id, cfg = doc_chapter
    embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:  # 再塞一条手工 chunk 作为对照（远离查询向量）
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter,
                                  qc_status)
               VALUES (%s,%s,'exercise','9-9','乘法练习','第 1 讲 乘除法竖式谜','approved')
               RETURNING id""",
            (str(uuid.uuid4()), doc_id),
        )
        other = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chunks (item_id, document_id, content_md, meta, embedding)
               VALUES (%s,%s,'乘法练习','{"label": "9-9", "chapter": "第 1 讲 乘除法竖式谜"}', %s)""",
            (other, doc_id, "[" + ",".join(["-1"] * 1024) + "]"),
        )
    hits = search(conn, cfg, "竖式谜怎么解", mode="vector", client=_FakeEmbed())
    assert hits[0]["label"] == "例1"  # _FakeEmbed 的全 1 向量最近
    assert hits[0]["chapter"] == "第 1 讲 乘除法竖式谜"
    assert hits[0]["score"] > 0.9
    assert hits[-1]["label"] == "9-9"


class _FakeEmbed:
    """确定性假 embedding：全 1 向量。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()

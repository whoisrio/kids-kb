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
        cur.execute("UPDATE pages SET parse_status='parsed'")
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


def test_segment_chapter_packs_paragraphs():
    from kb.embed import segment_chapter

    paras = "\n\n".join(f"段落{i}" + "字" * 20 for i in range(10))  # 每段约 22 字
    segs = segment_chapter(paras, max_chars=60)
    assert all(len(s) <= 60 for s in segs)
    assert "段落0" in segs[0] and "段落9" in segs[-1]
    # 超长单段硬切
    assert [len(s) for s in segment_chapter("长" * 200, max_chars=60)] == [60, 60, 60, 20]
    # 空内容不分段
    assert segment_chapter("") == []


def test_embed_chapters_segments_and_idempotent(conn, doc_chapter):
    from kb.embed import embed_chapters

    doc_id, cfg = doc_chapter
    content = "\n\n".join(f"# 小节{i}\n内容{i}" + "字" * 30 for i in range(5))
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,2,'语法讲义',%s)""",
            (str(uuid.uuid4()), doc_id, content),
        )
    n = embed_chapters(conn, cfg, doc_id, client=_FakeEmbed())
    assert n > 0
    with conn.cursor() as cur:
        cur.execute(
            """SELECT seg_no, meta->>'kind', meta->>'chapter', meta->>'doc_title',
                      chapter_id IS NOT NULL, item_id IS NULL, vector_dims(embedding)
               FROM chunks WHERE chapter_id IS NOT NULL ORDER BY seg_no""")
        rows = cur.fetchall()
        assert rows, "章节 chunk 应已写入"
        seg_no, kind, chapter, doc_title, has_ch, no_item, dims = rows[0]
        assert kind == "chapter"
        assert chapter == "第 2 讲 语法讲义"  # 与 structure 的 items.chapter 标签同构,供 TS 同章抑制
        assert doc_title == "7星学霸"
        assert has_ch and no_item and dims == 1024
    assert embed_chapters(conn, cfg, doc_id, client=_FakeEmbed()) == 0  # 幂等


def test_search_hybrid_keeps_chapter_hits_separate(conn, doc_chapter):
    """章节命中各自成行(不被 None item_id 合并),条目命中保留——供 CLI 调试与复核页试搜。"""
    from kb.embed import embed_approved_items, embed_chapters, search

    doc_id, cfg = doc_chapter
    embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:  # 两条章节都含'燕子':旧代码 rrf 以 item_id 为 key,None 合并成一条
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,3,'语法小章','# 语法\n比喻句本体是燕子'),
                      (%s,%s,4,'标点小章','# 标点\n燕子飞走了,省略号表示语意未尽')""",
            (str(uuid.uuid4()), doc_id, str(uuid.uuid4()), doc_id),
        )
    embed_chapters(conn, cfg, doc_id, client=_FakeEmbed())
    hits = search(conn, cfg, "燕子", mode="hybrid", client=_FakeEmbed())
    chapter_hits = [h for h in hits if h.get("kind") == "chapter"]
    assert len(chapter_hits) == 2, "两条章节命中应各自成行"
    assert any(h.get("label") for h in hits), "条目命中应保留"


def test_approve_items_bulk_and_embed(conn, doc_chapter):
    from kb.embed import approve_items, embed_chapters

    doc_id, cfg = doc_chapter
    # doc_chapter 已有:例1(approved) 与 1-1(pending);补 needs_review 与 rejected
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter, qc_status)
               VALUES (%s,%s,'exercise','2-1','待复核题','第 1 讲 乘除法竖式谜','needs_review'),
                      (%s,%s,'exercise','2-2','被打回的题','第 1 讲 乘除法竖式谜','rejected')""",
            (str(uuid.uuid4()), doc_id, str(uuid.uuid4()), doc_id))
        cur.execute(
            """INSERT INTO review_queue (item_id, reason)
               SELECT id, 'qc' FROM items WHERE document_id=%s AND label='2-1'""", (doc_id,))
    out = approve_items(conn, cfg, doc_id, client=_FakeEmbed())
    assert out["approved"] == 2  # pending(1-1) + needs_review(2-1);rejected 与已 approved 不动
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM items WHERE document_id=%s
               AND qc_status='approved' AND label IN ('1-1','2-1')""",
            (doc_id,))
        assert cur.fetchone()[0] == 2
        cur.execute(
            """SELECT count(*) FROM review_queue r JOIN items i ON i.id=r.item_id
               WHERE i.document_id=%s AND r.status='pending'""", (doc_id,))
        assert cur.fetchone()[0] == 0  # 复核行一并关闭
        cur.execute(
            "SELECT count(*) FROM chunks WHERE document_id=%s AND item_id IS NOT NULL",
            (doc_id,))
        assert cur.fetchone()[0] == 3  # 例1 + 1-1 + 2-1(approve 即向量化)


def test_approve_items_chapter_filter(conn, doc_chapter):
    from kb.embed import approve_items

    doc_id, cfg = doc_chapter
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, page_start, page_end)
               VALUES (%s,%s,2,'第二章',1,2)""",
            (str(uuid.uuid4()), doc_id))
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter, qc_status)
               VALUES (%s,%s,'exercise','3-1','第二章题','第 2 讲 第二章','pending')""",
            (str(uuid.uuid4()), doc_id))
    out = approve_items(conn, cfg, doc_id, chapter_no=2, client=_FakeEmbed())
    assert out["approved"] == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT qc_status FROM items WHERE document_id=%s AND label='1-1'", (doc_id,))
        assert cur.fetchone()[0] == "pending"  # 第一章不受影响


def test_segment_chapter_default_unchanged():
    """默认参数保持 1600/无重叠（flat 页向量化路径不受影响）。"""
    from kb.embed import segment_chapter

    segs = segment_chapter("甲" * 5000)
    assert [len(s) for s in segs] == [1600, 1600, 1600, 200]


def test_segment_chapter_paragraph_aggregation_500():
    """空行分段落、按序聚合到 500 字符切 chunk。"""
    from kb.embed import segment_chapter

    paras = [f"第{i}段 " + "字" * 180 for i in range(6)]
    segs = segment_chapter("\n\n".join(paras), max_chars=500)
    assert len(segs) == 3
    assert all(len(s) <= 500 for s in segs)


def test_segment_chapter_overlap():
    """overlap_chars：相邻 chunk 携带上一段尾部重叠。"""
    from kb.embed import segment_chapter

    text = "\n\n".join(["甲" * 300, "乙" * 300, "丙" * 300])
    segs = segment_chapter(text, max_chars=400, overlap_chars=50)
    assert segs[0] == "甲" * 300
    assert segs[1].startswith("甲" * 50) and segs[1].endswith("乙" * 300)
    assert segs[2].startswith("乙" * 50) and segs[2].endswith("丙" * 300)


def test_embed_chapters_uses_chunk_config(conn, tmp_path):
    """embed_chapters 按 cfg.chunk_max_chars/overlap 分段。"""
    from kb.config import Config
    from kb import embed as embed_mod

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        chunk_max_chars=300,
        chunk_overlap_ratio=0.2,
    )
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/c.md') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO chapters (id, document_id, chapter_no, title, content_md) VALUES (%s,%s,1,'章','内容')",
            (str(uuid.uuid4()), doc_id),
        )
    seen = []

    class FakeEmbed:
        class embeddings:
            @staticmethod
            def create(model, input):
                class D:
                    embedding = [0.0] * 1024

                class R:
                    data = [D()]

                return R()

    orig = embed_mod.segment_chapter

    def spy(content_md, max_chars=1600, overlap_chars=0):
        seen.append((max_chars, overlap_chars))
        return orig(content_md, max_chars=max_chars, overlap_chars=overlap_chars)

    embed_mod.segment_chapter = spy
    try:
        n = embed_mod.embed_chapters(conn, cfg, doc_id, client=FakeEmbed())
    finally:
        embed_mod.segment_chapter = orig
    assert n == 1
    assert seen == [(300, 60)]

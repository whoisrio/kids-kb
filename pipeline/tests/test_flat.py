"""flat 入库：无目录文档的整卷按页模式——模式判定、合成章、按页对齐向量化、approve 分流。
设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream D）"""
import base64
import uuid

import pytest

_TINY_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def test_documents_struct_mode_schema(conn):
    """0014：struct_mode 受控词表（toc|flat），缺省 NULL（旧文档无值不算错）。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('x', %s) RETURNING id, struct_mode",
            (f"/tmp/{uuid.uuid4()}.pdf",),
        )
        doc_id, mode = cur.fetchone()
        assert mode is None
        cur.execute("UPDATE documents SET struct_mode='flat' WHERE id=%s", (doc_id,))
        with pytest.raises(Exception):
            cur.execute("UPDATE documents SET struct_mode='bogus' WHERE id=%s", (doc_id,))


@pytest.fixture()
def flat_doc(conn, tmp_path):
    """无目录试卷集合：3 页——页 1 块文本（含 header 干扰）、页 2 整页稿、页 3 无内容。"""
    from kb.config import Config

    png = tmp_path / "p.png"
    png.write_bytes(base64.b64decode(_TINY_PNG))
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO documents (id, title, subject, doc_type, source_path)
               VALUES (%s, '学霸提优大试卷', '数学', 'exam', %s) RETURNING id""",
            (str(uuid.uuid4()), f"/tmp/{uuid.uuid4()}.pdf"),
        )
        doc_id = str(cur.fetchone()[0])
        spec = [(1, "blocks", None), (2, "page_md", "第二套 素养达标 竖式计算题"), (3, "blocks", None)]
        for page_no, adopted, page_md in spec:
            cur.execute(
                """INSERT INTO pages (id, document_id, page_no, image_path, status, adopted_source, page_md)
                   VALUES (%s,%s,%s,%s,'parsed',%s,%s) RETURNING id""",
                (str(uuid.uuid4()), doc_id, page_no, str(png), adopted, page_md),
            )
            page_id = str(cur.fetchone()[0])
            if page_no == 1:
                for btype, content in [("header", "第 1 页 学霸提优"),
                                       ("text", "一、口算 24+37="),
                                       ("text", "二、竖式 135÷5=")]:
                    cur.execute(
                        "INSERT INTO blocks (id, page_id, block_type, crop_path, content_md) "
                        "VALUES (%s,%s,%s,'/tmp/c.png',%s)",
                        (str(uuid.uuid4()), page_id, btype, content),
                    )
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    return doc_id, cfg


def test_page_contents_adopts_and_skips(conn, flat_doc):
    from kb.flat import page_contents

    doc_id, _cfg = flat_doc
    with conn.cursor() as cur:
        contents = page_contents(cur, doc_id)
    assert contents == [
        (1, "一、口算 24+37=\n二、竖式 135÷5="),  # header 跳过，块按 created_at 序拼接
        (2, "第二套 素养达标 竖式计算题"),           # 整页稿原样
    ]  # 页 3 无内容，不出现


def test_page_contents_orders_blocks_with_equal_created_at(conn):
    """同页块 created_at 相同时按 id 排序，避免 PostgreSQL 返回不确定顺序。"""
    from kb.flat import page_contents

    doc_id = "00000000-0000-0000-0000-000000000001"
    page_id = "00000000-0000-0000-0000-000000000002"
    created_at = "2026-01-01T00:00:00+00:00"
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s, 'flat', %s)",
            (doc_id, f"/tmp/{uuid.uuid4()}.pdf"),
        )
        cur.execute(
            """INSERT INTO pages (id, document_id, page_no, image_path, status, adopted_source)
               VALUES (%s,%s,1,'/tmp/flat-order.png','parsed','blocks')""",
            (page_id, doc_id),
        )
        for block_id, content in [
            ("00000000-0000-0000-0000-000000000004", "Z block"),
            ("00000000-0000-0000-0000-000000000003", "A block"),
        ]:
            cur.execute(
                """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md, created_at)
                   VALUES (%s,%s,'text','/tmp/flat-order.png',%s,%s)""",
                (block_id, page_id, content, created_at),
            )

    with conn.cursor() as cur:
        contents = page_contents(cur, doc_id)
    assert contents == [(1, "A block\nZ block")]


def test_build_flat_chapter_idempotent(conn, flat_doc):
    from kb.flat import build_flat_chapter

    doc_id, _cfg = flat_doc
    ch1 = build_flat_chapter(conn, doc_id)
    ch2 = build_flat_chapter(conn, doc_id)  # 重跑（页面被复核编辑后）更新内容不重建
    assert ch1 == ch2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT ch.chapter_no, ch.title, ch.content_md, d.struct_mode
               FROM chapters ch JOIN documents d ON d.id = ch.document_id WHERE ch.id=%s""",
            (ch1,),
        )
        no, title, content_md, mode = cur.fetchone()
    assert (no, title, mode) == (1, "学霸提优大试卷", "flat")
    assert "一、口算 24+37=" in content_md
    assert "第二套 素养达标 竖式计算题" in content_md
    assert "\n\n" in content_md  # 页间以空行拼接


def test_build_flat_chapter_refuses_multi_chapter_doc(conn, flat_doc):
    """多章文档（已按目录拆章）不允许混用 flat（防止合成章覆盖真章）。"""
    from kb.flat import build_flat_chapter

    doc_id, _cfg = flat_doc
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO chapters (id, document_id, chapter_no, title) VALUES (%s,%s,2,'真章')",
            (str(uuid.uuid4()), doc_id),
        )
    with pytest.raises(ValueError, match="已有章节"):
        build_flat_chapter(conn, doc_id)


class _FakeEmbed:
    """确定性假 embedding：全 1 向量（1024 维，同 tests/test_embed.py 手法）。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()


def test_embed_flat_pages_per_page_segments(conn, flat_doc):
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    n = embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    assert n == 2  # 页 1、页 2 各一段（页 3 无内容）
    with conn.cursor() as cur:
        cur.execute(
            """SELECT seg_no, meta->>'page_no', meta->>'kind', meta->>'chapter',
                      content_md, vector_dims(embedding)
               FROM chunks WHERE chapter_id IS NOT NULL ORDER BY seg_no"""
        )
        rows = cur.fetchall()
    assert [(r[0], r[1], r[2], r[3]) for r in rows] == [
        (1001, "1", "chapter", "全卷"),
        (2001, "2", "chapter", "全卷"),
    ]
    assert "一、口算" in rows[0][4] and "第二套" in rows[1][4]
    assert "第 1 页" in rows[0][4] and "第 2 页" in rows[1][4]  # content 带页定位前缀
    assert rows[0][5] == 1024


def test_embed_flat_pages_rebuild_single_page(conn, flat_doc):
    """页级重建：只重嵌目标页（删旧插新），其他页 chunk 不动——复核编辑后重发的依据。"""
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:  # 复核编辑：页 2 整页稿改内容
        cur.execute(
            "UPDATE pages SET page_md='第二套 改后内容 退位减法' WHERE document_id=%s AND page_no=2",
            (doc_id,),
        )
    n = embed_flat_pages(conn, cfg, doc_id, page_no=2, client=_FakeEmbed())
    assert n == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT meta->>'page_no', content_md FROM chunks "
            "WHERE chapter_id IS NOT NULL ORDER BY seg_no"
        )
        rows = cur.fetchall()
    assert len(rows) == 2  # 页 1 未动 + 页 2 重建
    assert rows[1] == ("2", "全卷 · 第 2 页\n\n第二套 改后内容 退位减法")


def test_embed_flat_pages_segments_long_page(conn, flat_doc):
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_md=%s WHERE document_id=%s AND page_no=2",
            ("退位减法 " * 400, doc_id),
        )
    n = embed_flat_pages(conn, cfg, doc_id, page_no=2, client=_FakeEmbed())
    assert n == 2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT seg_no FROM chunks
               WHERE chapter_id IS NOT NULL AND meta->>'page_no'='2'
               ORDER BY seg_no""",
        )
        assert [row[0] for row in cur.fetchall()] == [2001, 2002]


def test_embed_flat_pages_removes_emptied_page(conn, flat_doc):
    """页级重建/全量重建都清理已变空页的旧向量，避免检索到过期内容。"""
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_md=NULL WHERE document_id=%s AND page_no=2",
            (doc_id,),
        )
    assert embed_flat_pages(conn, cfg, doc_id, page_no=2, client=_FakeEmbed()) == 0
    with conn.cursor() as cur:
        cur.execute("SELECT meta->>'page_no' FROM chunks WHERE chapter_id IS NOT NULL")
        assert [row[0] for row in cur.fetchall()] == ["1"]


def test_embed_flat_pages_full_rebuild_removes_emptied_page(conn, flat_doc):
    from kb.flat import build_flat_chapter, embed_flat_pages

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_md=NULL WHERE document_id=%s AND page_no=2",
            (doc_id,),
        )
    assert embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed()) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT meta->>'page_no' FROM chunks WHERE chapter_id IS NOT NULL")
        assert [row[0] for row in cur.fetchall()] == ["1"]


def test_embed_flat_pages_guards(conn, flat_doc):
    """没建合成章 / 非 flat 文档 -> ValueError（internal 端点转 500）。"""
    from kb.flat import embed_flat_pages

    doc_id, cfg = flat_doc
    with pytest.raises(ValueError, match="先跑 structure"):
        embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    from kb.flat import build_flat_chapter
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    with pytest.raises(ValueError, match="非 flat"):
        embed_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())


def test_resolve_mode(conn, flat_doc):
    """优先级：--flat 显式 > --toc-pages 显式 > 自动探测（前 15 页块文本含「目录」= toc）。"""
    from kb.flat import resolve_mode

    doc_id, _cfg = flat_doc
    with conn.cursor() as cur:
        assert resolve_mode(cur, doc_id, flat=True, toc_pages=None) == "flat"
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=[4]) == "toc"
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "flat"  # 无目录块
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录 第 1 套' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
        assert resolve_mode(cur, doc_id, flat=False, toc_pages=None) == "toc"


_FENCE = "`" * 3
TOC_JSON = _FENCE + "json\n" + (
    '[{"chapter_no": 1, "title": "口算", "print_page": 1, "taxonomy": "计算类", "tags": []}]'
) + "\n" + _FENCE


def _client(*texts):
    """按调用顺序弹回预设响应（同 tests/test_toc.py 手法）。"""
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


def test_run_structure_flat_fallback(conn, flat_doc, capsys):
    """自动探测无目录 -> flat：合成 1 章、零 LLM 调用、struct_mode=flat。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    out = run_structure(conn, cfg, doc_id)
    assert out == {"mode": "flat", "chapters": 1, "items": 0}
    assert "回退整卷按页模式" in capsys.readouterr().out
    with conn.cursor() as cur:
        cur.execute(
            """SELECT struct_mode, (SELECT count(*) FROM items WHERE document_id=d.id)
               FROM documents d WHERE id=%s""",
            (doc_id,),
        )
        assert cur.fetchone() == ("flat", 0)
        cur.execute("SELECT count(*) FROM llm_calls WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0


def test_run_structure_flat_flag_overrides_toc(conn, flat_doc):
    """页 1 有「目录」块本会走 toc；--flat 强制 flat。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
    assert run_structure(conn, cfg, doc_id, flat=True)["mode"] == "flat"


def test_run_structure_toc_marks_mode(conn, flat_doc):
    """TOC 路径成功后置 struct_mode='toc'（approve 分流依据）。
    章标题在非目录页找不到 -> 校准 0、拆条跳过，恰好只消耗 1 次 VLM（TOC 抽取）。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录 第 1 讲 口算' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
    out = run_structure(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert out == {"mode": "toc", "chapters": 1, "items": 0}
    with conn.cursor() as cur:
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (doc_id,))
        assert cur.fetchone()[0] == "toc"


def test_run_structure_recovers_from_flat_to_toc(conn, flat_doc):
    """自动回退 flat 后可用目录模式恢复；未向量化的合成章可安全替换。"""
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    assert run_structure(conn, cfg, doc_id)["mode"] == "flat"
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录 第 1 讲 口算' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
    out = run_structure(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert out == {"mode": "toc", "chapters": 1, "items": 0}
    with conn.cursor() as cur:
        cur.execute(
            """SELECT struct_mode,
                      (SELECT title FROM chapters WHERE document_id=d.id),
                      (SELECT count(*) FROM chunks WHERE document_id=d.id),
                      (SELECT count(*) FROM items WHERE document_id=d.id)
               FROM documents d WHERE id=%s""",
            (doc_id,),
        )
        assert cur.fetchone() == ("toc", "口算", 0, 0)


def test_run_structure_toc_refuses_flat_with_content(conn, flat_doc):
    """flat 已向量化的文档拒绝切回目录模式（防误删已入库内容）；CLI 语义用 SystemExit。"""
    from kb.flat import approve_flat_pages
    from kb.structure import run_structure

    doc_id, cfg = flat_doc
    assert run_structure(conn, cfg, doc_id)["mode"] == "flat"
    approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())  # 产生 chunks
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md)
               SELECT %s, id, 'text', '/tmp/c.png', '目录 第 1 讲 口算' FROM pages
               WHERE document_id=%s AND page_no=1""",
            (str(uuid.uuid4()), doc_id),
        )
    with pytest.raises(SystemExit, match="flat"):
        run_structure(conn, cfg, doc_id)  # 守卫先于任何 LLM 调用


def test_approve_flat_pages_closes_rows_and_embeds(conn, flat_doc):
    from kb.flat import approve_flat_pages, build_flat_chapter

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:  # 同一文档同时挂页级 + 块级 pending 复核行
        cur.execute("SELECT id FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
        page_id = cur.fetchone()[0]
        cur.execute("SELECT id FROM blocks WHERE page_id=%s AND content_md=%s",
                    (page_id, "一、口算 24+37="))
        block_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO review_queue (id, page_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), page_id),
        )
        cur.execute(
            "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), block_id),
        )
    out = approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    assert out == {"pages": 2, "chunks": 2, "resolved": 2}
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM review_queue
               WHERE (page_id=%s OR block_id=%s) AND status='approved'""",
            (page_id, block_id),
        )
        assert cur.fetchone()[0] == 2
        cur.execute(
            """SELECT document_id, meta->>'page_no', seg_no
               FROM chunks WHERE chapter_id IS NOT NULL ORDER BY seg_no"""
        )
        rows = cur.fetchall()
    assert [(str(r[0]), r[1], r[2]) for r in rows] == [
        (doc_id, "1", 1001),
        (doc_id, "2", 2001),
    ]


def test_approve_flat_pages_is_idempotent(conn, flat_doc):
    from kb.flat import approve_flat_pages, build_flat_chapter

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE document_id=%s ORDER BY page_no", (doc_id,))
        page_id = cur.fetchone()[0]
        cur.execute(
            "SELECT id FROM blocks WHERE page_id=%s AND content_md=%s",
            (page_id, "一、口算 24+37="),
        )
        block_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO review_queue (id, page_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), page_id),
        )
        cur.execute(
            "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), block_id),
        )

    first = approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    assert first == {"pages": 2, "chunks": 2, "resolved": 2}

    second = approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    assert second == {"pages": 2, "chunks": 2, "resolved": 0}
    with conn.cursor() as cur:
        cur.execute(
            """SELECT document_id, meta->>'kind', meta->>'page_no'
               FROM chunks WHERE chapter_id IS NOT NULL ORDER BY seg_no"""
        )
        rows = cur.fetchall()
        cur.execute(
            "SELECT count(*) FROM review_queue WHERE status='pending'"
        )
        pending = cur.fetchone()[0]
    assert [(str(row[0]), row[1], row[2]) for row in rows] == [
        (doc_id, "chapter", "1"),
        (doc_id, "chapter", "2"),
    ]
    assert pending == 0


def test_approve_flat_pages_rolls_back_on_embedding_failure(conn, flat_doc, monkeypatch):
    import kb.flat
    from kb.flat import approve_flat_pages, build_flat_chapter

    doc_id, cfg = flat_doc
    build_flat_chapter(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
        page_id = cur.fetchone()[0]
        cur.execute("SELECT id FROM blocks WHERE page_id=%s AND content_md=%s",
                    (page_id, "一、口算 24+37="))
        block_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO review_queue (id, page_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), page_id),
        )
        cur.execute(
            "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,'empty')",
            (str(uuid.uuid4()), block_id),
        )

    def fail_embedding(*args, **kwargs):
        raise RuntimeError("embedding failed")

    monkeypatch.setattr(kb.flat, "embed_flat_pages", fail_embedding)
    with pytest.raises(RuntimeError, match="embedding failed"):
        approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM review_queue
               WHERE (page_id=%s OR block_id=%s) AND status='pending'""",
            (page_id, block_id),
        )
        assert cur.fetchone()[0] == 2


def test_approve_flat_pages_guards(conn, flat_doc):
    from kb.flat import approve_flat_pages

    doc_id, cfg = flat_doc
    with pytest.raises(ValueError, match="非 flat"):
        approve_flat_pages(conn, cfg, doc_id, client=_FakeEmbed())

    with pytest.raises(ValueError, match="文档不存在"):
        approve_flat_pages(conn, cfg, str(uuid.uuid4()), client=_FakeEmbed())

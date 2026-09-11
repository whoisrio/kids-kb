import uuid

import pytest

from kb.core.config import Config

_FENCE = "`" * 3


def _client_seq(texts):
    """按调用顺序返回不同响应的假客户端。"""
    it = iter(texts)

    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                text = next(it)

                class M:
                    content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def pdf_exam(conn):
    """PDF 试卷：2 页整页转录（选择题大题 + 答案区）。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'期末卷','exam','/tmp/x.pdf','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        for no, md in [
            (1, "一、选择题\n\n1. He ___ to school.\nA. go B. goes"),
            (2, "参考答案\n\n1. B"),
        ]:
            cur.execute(
                """INSERT INTO pages (id, document_id, page_no, image_path, parse_status,
                                      adopted_source, page_md)
                   VALUES (%s,%s,%s,'/tmp/x.png','parsed','page_md',%s)""",
                (str(uuid.uuid4()), doc_id, no, md),
            )
    return doc_id


EXAM_JSON = _FENCE + "json\n" + (
    '[{"label": "1", "stem_md": "He ___ to school.\\nA. go B. goes",'
    ' "answer_md": "B", "page_start": 1, "page_end": 1}]'
) + "\n" + _FENCE


def test_split_sections_by_major_headings():
    from kb.rag.structure_exam import split_sections

    text = "卷首说明\n\n一、选择题\n\n1. 题一\n\n二、填空题\n\n2. 题二"
    sections = split_sections(text)
    assert [title for title, _ in sections] == ["一、选择题", "二、填空题"]
    assert sections[0][1].startswith("卷首说明")
    assert "1. 题一" in sections[0][1] and "2. 题二" not in sections[0][1]


def test_split_sections_no_headings():
    from kb.rag.structure_exam import split_sections

    assert split_sections("1. 唯一的题") == [("全卷", "1. 唯一的题")]


def test_run_exam_structure_pdf(conn, cfg, pdf_exam):
    """PDF 试卷：拼 page_md（带【页N】标记）-> 拆题 -> 章/题目/答案配对/struct_mode。"""
    from kb.rag.structure_exam import run_exam_structure

    out = run_exam_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    assert out == {"mode": "exam", "sections": 1, "items": 2}
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, title, content_md, page_start, page_end FROM chapters")
        no, title, content_md, page_start, page_end = cur.fetchone()
        assert (no, title) == (1, "一、选择题")
        assert "【页1】" in content_md and (page_start, page_end) == (1, 1)
        cur.execute("SELECT content_type, label, page_start FROM items ORDER BY content_type")
        rows = cur.fetchall()
        assert rows == [("answer", "1", 1), ("exercise", "1", 1)]
        cur.execute(
            "SELECT count(*) FROM items WHERE content_type='exercise' AND paired_item_id IS NOT NULL"
        )
        assert cur.fetchone()[0] == 1
        cur.execute("SELECT struct_mode FROM documents WHERE id=%s", (pdf_exam,))
        assert cur.fetchone()[0] == "toc"


def test_run_exam_structure_docx(conn, cfg):
    """docx/md 试卷：现有章节即大题单元，不新建章。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'语法卷','exam','/tmp/x.docx','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO chapters (id, document_id, chapter_no, title, content_md)"
            " VALUES (%s,%s,1,'一、选择题','1. He ___ to school.')",
            (str(uuid.uuid4()), doc_id),
        )
    from kb.rag.structure_exam import run_exam_structure

    out = run_exam_structure(conn, cfg, doc_id, client=_client_seq([EXAM_JSON]))
    assert out["items"] == 2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chapters WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 1
        cur.execute("SELECT chapter, page_start FROM items WHERE content_type='exercise'")
        chapter, page_start = cur.fetchone()
        assert chapter == "一、选择题" and page_start is None


def test_run_exam_structure_section_failure_continues(conn, cfg):
    """单 section 失败记日志并继续，其它 section 照常入库。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'语法卷','exam','/tmp/x.docx','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        for no, title in [(1, "一、选择题"), (2, "二、填空题")]:
            cur.execute(
                "INSERT INTO chapters (id, document_id, chapter_no, title, content_md)"
                " VALUES (%s,%s,%s,%s,'内容')",
                (str(uuid.uuid4()), doc_id, no, title),
            )

    class Chat:
        class completions:
            calls = []

            @staticmethod
            def create(model, messages, max_tokens):
                Chat.completions.calls.append(1)
                if len(Chat.completions.calls) <= 2:
                    raise ConnectionError("Server disconnected")

                class M:
                    content = EXAM_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    from kb.rag.structure_exam import run_exam_structure

    out = run_exam_structure(conn, cfg, doc_id, client=Client())
    assert out["items"] == 2
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM pipeline_events"
            " WHERE document_id=%s AND event_type='error'",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1


def test_run_exam_structure_rerun_heals_failed_section(conn, cfg):
    """部分失败后重跑自愈：已完成 section 幂等跳过，失败的 section 补上。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, doc_type, source_path, parse_status)"
            " VALUES (%s,'语法卷','exam','/tmp/x.docx','parsed') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        for no, title in [(1, "一、选择题"), (2, "二、填空题")]:
            cur.execute(
                "INSERT INTO chapters (id, document_id, chapter_no, title, content_md)"
                " VALUES (%s,%s,%s,%s,'内容')",
                (str(uuid.uuid4()), doc_id, no, title),
            )

    class Chat:
        class completions:
            calls = []

            @staticmethod
            def create(model, messages, max_tokens):
                Chat.completions.calls.append(1)
                if len(Chat.completions.calls) <= 2:
                    raise ConnectionError("Server disconnected")  # 第一个 section 重试后仍失败

                class M:
                    content = EXAM_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    from kb.rag.structure_exam import run_exam_structure

    out1 = run_exam_structure(conn, cfg, doc_id, client=Client())
    assert out1["items"] == 2  # 只有「二、填空题」入库
    out2 = run_exam_structure(conn, cfg, doc_id, client=_client_seq([EXAM_JSON]))
    assert out2["items"] == 2  # 重跑把「一、选择题」补上
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM items WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 4
        cur.execute(
            "SELECT DISTINCT chapter FROM items WHERE document_id=%s ORDER BY chapter",
            (doc_id,),
        )
        assert [row[0] for row in cur.fetchall()] == ["一、选择题", "二、填空题"]


def test_run_exam_structure_zero_questions_fails(conn, cfg, pdf_exam):
    from kb.rag.structure_exam import run_exam_structure

    with pytest.raises(SystemExit, match="0 题"):
        run_exam_structure(conn, cfg, pdf_exam, client=_client_seq(["[]"]))


def test_run_exam_structure_idempotent(conn, cfg, pdf_exam):
    from kb.rag.structure_exam import run_exam_structure

    run_exam_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    out = run_exam_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    assert out["items"] == 0


def test_run_structure_routes_exam_by_doc_type(conn, cfg, pdf_exam):
    """doc_type='exam' 的文档跑 structure 自动走试卷拆题（无需 --exam）。"""
    from kb.rag.structure import run_structure

    out = run_structure(conn, cfg, pdf_exam, client=_client_seq([EXAM_JSON]))
    assert out["mode"] == "exam"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM items WHERE document_id=%s", (pdf_exam,))
        assert cur.fetchone()[0] == 2


def test_run_structure_flat_flag_wins_over_exam(conn, cfg, pdf_exam):
    """显式 --flat 优先于 doc_type=exam（逃生门）。"""
    from kb.rag.structure import run_structure

    out = run_structure(conn, cfg, pdf_exam, flat=True,
                        client=_client_seq([EXAM_JSON]))
    assert out["mode"] == "flat"
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM items WHERE document_id=%s", (pdf_exam,))
        assert cur.fetchone()[0] == 0

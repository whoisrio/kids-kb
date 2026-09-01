import pymupdf as fitz
import pytest


@pytest.fixture()
def doc_with_chapter(conn, tmp_path):
    """1 本书 1 章（物理 2-3 页），页 2 有 例题块+公式块，页 3 有 练习块。"""
    import uuid

    from kb.config import Config

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/b.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (document_id, chapter_no, title, print_page, taxonomy, tags,
                                     page_start, page_end)
               VALUES (%s, 1, '乘除法竖式谜', 1, '计算类', ARRAY['倒推法'], 2, 3)""",
            (doc_id,),
        )
        blocks = []
        for page_no, texts in [(2, [("text", "例1 在下面方框填上合适的数字"),
                                    ("figure", "$\\square 7 6$ 竖式图"),
                                    ("text", "答：第二个因数十位是 8")]),
                               (3, [("text", "1. 盼望祖国早日统一 算式谜")])]:
            cur.execute(
                "INSERT INTO pages (id, document_id, page_no, image_path, status) VALUES (%s,%s,%s,'/tmp/x.png','parsed') RETURNING id",
                (str(uuid.uuid4()), doc_id, page_no),
            )
            page_id = str(cur.fetchone()[0])
            for btype, content in texts:
                bid = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO blocks (id, page_id, block_type, crop_path, content_md) VALUES (%s,%s,%s,'/tmp/c.png',%s)",
                    (bid, page_id, btype, content),
                )
                blocks.append(bid)
    return doc_id, cfg, blocks


_FENCE = "`" * 3
ITEMS_JSON = _FENCE + "json\n" + (
    '[{"content_type": "example", "label": "例1",'
    ' "content_md": "在下面方框填上合适的数字。$\\\\square 7 6$", "block_ids": [1, 2, 3]},'
    '{"content_type": "exercise", "label": "1",'
    ' "content_md": "盼望祖国早日统一 算式谜", "block_ids": [4]}]'
) + "\n" + _FENCE


def _client(text):
    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = text

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    return Client()


def test_structure_chapter_creates_items(conn, doc_with_chapter):
    from kb.structure import structure_chapter

    doc_id, cfg, blocks = doc_with_chapter
    n = structure_chapter(conn, cfg, doc_id, chapter_no=1, client=_client(ITEMS_JSON))
    assert n == 2
    with conn.cursor() as cur:
        cur.execute(
            """SELECT content_type, label, chapter, taxonomy, tags, page_start, page_end
               FROM items ORDER BY label"""
        )
        rows = cur.fetchall()
    assert rows[0][:3] == ("exercise", "1", "第 1 讲 乘除法竖式谜")
    assert rows[1][0] == "example"
    assert rows[1][3] == "计算类" and rows[1][4] == ["倒推法"]
    assert (rows[1][5], rows[1][6]) == (2, 3)  # 跨页：例题引用了页2的块
    with conn.cursor() as cur:
        cur.execute("SELECT block_id, role FROM item_blocks ORDER BY role")
        rb = {str(b): r for b, r in cur.fetchall()}
    assert rb[blocks[1]] == "figure"   # figure 块记 figure
    assert rb[blocks[0]] == "stem"     # 文本块记 stem


def test_structure_chapter_skips_done(conn, doc_with_chapter):
    from kb.structure import structure_chapter

    doc_id, cfg, _blocks = doc_with_chapter
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(ITEMS_JSON)) == 2
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(ITEMS_JSON)) == 0  # 幂等


def test_pair_items_links_answers(conn, doc_with_chapter):
    import uuid

    from kb.structure import pair_items

    doc_id, _cfg, _blocks = doc_with_chapter
    with conn.cursor() as cur:
        ex_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES (%s,%s,'exercise','3','题')",
            (ex_id, doc_id),
        )
        cur.execute(
            "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES (%s,%s,'answer','3','答')",
            (str(uuid.uuid4()), doc_id),
        )
    assert pair_items(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT paired_item_id FROM items WHERE content_type='exercise'")
        assert cur.fetchone()[0] is not None


def test_structure_prompt_requires_fidelity():
    """拆条 prompt 必须含忠于原文约束（防模型改写/脑补续写）。"""
    from kb.structure import STRUCTURE_PROMPT
    assert "忠于源块原文" in STRUCTURE_PROMPT
    assert "严禁改写" in STRUCTURE_PROMPT

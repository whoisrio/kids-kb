import pymupdf as fitz
import pytest


@pytest.fixture()
def doc_with_chapter(conn, tmp_path):
    """1 本书 1 章（物理 2-3 页），页 2 有 例题块+公式块，页 3 有 练习块。"""
    import uuid

    from kb.core.config import Config

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
                "INSERT INTO pages (id, document_id, page_no, image_path, parse_status) VALUES (%s,%s,%s,'/tmp/x.png','parsed') RETURNING id",
                (str(uuid.uuid4()), doc_id, page_no),
            )
            page_id = str(cur.fetchone()[0])
            for btype, content in texts:
                bid = str(uuid.uuid4())
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, crop_path, content_md, ordinal)
                       VALUES (%s,%s,%s,'/tmp/c.png',%s,
                               (SELECT coalesce(max(ordinal), 0) + 1 FROM blocks WHERE page_id=%s))""",
                    (bid, page_id, btype, content, page_id),
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
    from kb.rag.structure import structure_chapter

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
    from kb.rag.structure import structure_chapter

    doc_id, cfg, _blocks = doc_with_chapter
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(ITEMS_JSON)) == 2
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(ITEMS_JSON)) == 0  # 幂等


def test_structure_chapter_tolerates_malformed_entries(conn, doc_with_chapter):
    """模型返回单个对象（非数组）或数组里混有字符串时，跳过坏条目不炸整章。
    （真实踩过：TypeError: string indices must be integers 中断整章拆条）"""
    from kb.rag.structure import structure_chapter

    doc_id, cfg, _ = doc_with_chapter
    mixed = ('[{"content_type": "example", "label": "例1", "content_md": "题干", "block_ids": [1]},'
             ' "这不是条目", 42]')
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(mixed)) == 1


def test_structure_chapter_accepts_single_object(conn, doc_with_chapter):
    """模型把单条结果直接输出为对象（而非数组）时按一条处理。"""
    from kb.rag.structure import structure_chapter

    doc_id, cfg, _ = doc_with_chapter
    single = '{"content_type": "example", "label": "例1", "content_md": "题干", "block_ids": [1]}'
    assert structure_chapter(conn, cfg, doc_id, 1, client=_client(single)) == 1


def test_structure_chapter_accepts_string_block_ids(conn, doc_with_chapter):
    """LLM 可能把块号输出为字符串；拆条必须归一化而不是崩溃。"""
    from kb.rag.structure import structure_chapter

    doc_id, cfg, blocks = doc_with_chapter
    items_json = _FENCE + "json\n" + (
        '[{"content_type": "exercise", "label": "1",'
        ' "content_md": "在下面方框填上合适的数字。", "block_ids": ["1", "2"]}]'
    ) + "\n" + _FENCE

    n = structure_chapter(conn, cfg, doc_id, chapter_no=1, client=_client(items_json))

    assert n == 1
    with conn.cursor() as cur:
        cur.execute(
            """SELECT ib.role
               FROM item_blocks ib
               JOIN items i ON i.id=ib.item_id
               JOIN blocks b ON b.id=ib.block_id
               JOIN pages p ON p.id=b.page_id
               WHERE i.document_id=%s
               ORDER BY p.page_no, b.ordinal""",
            (doc_id,),
        )
        assert [r[0] for r in cur.fetchall()] == ["stem", "figure"]


def test_pair_items_links_answers(conn, doc_with_chapter):
    import uuid

    from kb.rag.structure import pair_items

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


def test_structure_chapter_uses_content_md(conn, tmp_path):
    """docx 章（content_md 非空、页码 NULL）：直接拆章稿，不再因 page_start NULL 跳过。"""
    import uuid

    from kb.core.config import Config
    from kb.rag.structure import structure_chapter

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/e.docx') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'选择题','# 一、选择题\n\n1. He ___ to school by bus.')""",
            (str(uuid.uuid4()), doc_id),
        )
    items_json = '[{"content_type":"exercise","label":"1","content_md":"He ___ to school by bus.","block_ids":[1]}]'
    n = structure_chapter(conn, cfg, doc_id, 1, client=_client(items_json))
    assert n == 1
    with conn.cursor() as cur:
        cur.execute("SELECT label, page_start FROM items WHERE document_id=%s", (doc_id,))
        label, page_start = cur.fetchone()
    assert label == "1" and page_start is None  # docx 条目无页码


def test_structure_prompt_requires_fidelity():
    """拆条 prompt 必须含忠于原文约束（防模型改写/脑补续写）。"""
    from kb.rag.structure import STRUCTURE_PROMPT
    assert "忠于源块原文" in STRUCTURE_PROMPT
    assert "严禁改写" in STRUCTURE_PROMPT


def test_structure_retries_on_connection_error(conn, doc_with_chapter):
    """远端断连（APIConnectionError 类）重试一次，不直接炸掉整章。"""
    from kb.rag.structure import structure_chapter

    doc_id, cfg, _blocks = doc_with_chapter
    calls = []

    class FlakyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                calls.append(1)
                if len(calls) == 1:
                    raise ConnectionError("Server disconnected")
                class M:
                    content = ITEMS_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class FlakyClient:
        chat = FlakyChat()

    n = structure_chapter(conn, cfg, doc_id, 1, client=FlakyClient())
    assert n == 2 and len(calls) == 2


def test_structure_disables_reasoning_with_fallback(conn, doc_with_chapter):
    """拆条默认关闭 reasoning；端点不认识参数时降级为普通调用。"""
    from kb.rag.structure import structure_chapter

    doc_id, cfg, _blocks = doc_with_chapter
    calls = []

    class Chat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens, **kwargs):
                calls.append(kwargs)
                if "extra_body" in kwargs:
                    raise RuntimeError("reasoning_effort not supported")

                class M:
                    content = ITEMS_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class Client:
        chat = Chat()

    n = structure_chapter(conn, cfg, doc_id, 1, client=Client())

    assert n == 2
    assert calls == [{"extra_body": {"reasoning_effort": "none"}}, {}]


def test_structure_uses_doc_ognize_model_when_set(conn, doc_with_chapter):
    """配置 doc_ognize_model 时拆条用它，否则回落 vision_model。"""
    import dataclasses

    from kb.rag.structure import structure_chapter

    doc_id, cfg, _blocks = doc_with_chapter
    cfg = dataclasses.replace(cfg, doc_ognize_model="qwen3-32b")
    seen = []

    class SpyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                seen.append(model)

                class M:
                    content = ITEMS_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class SpyClient:
        chat = SpyChat()

    structure_chapter(conn, cfg, doc_id, 1, client=SpyClient())
    assert seen == ["qwen3-32b"]


def test_structure_uses_page_md_for_adopted_pages(conn, doc_with_chapter):
    """采用整页版的页：章节窗口用 page_md 替代该页块文本。"""
    from kb.rag.structure import structure_chapter

    doc_id, cfg, blocks = doc_with_chapter
    with conn.cursor() as cur:  # 第 2 页（章首页）采用整页版
        cur.execute("SELECT id FROM pages WHERE page_no=2")
        pid = str(cur.fetchone()[0])
        cur.execute(
            "UPDATE pages SET page_md='整页版：例9 整页转录内容', adopted_source='page_md' WHERE id=%s",
            (pid,),
        )
    seen = []

    class SpyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                seen.append(messages[0]["content"])
                class M:
                    content = ITEMS_JSON

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class SpyClient:
        chat = SpyChat()

    structure_chapter(conn, cfg, doc_id, 1, client=SpyClient())
    assert "整页版：例9 整页转录内容" in seen[0]
    # 该页块文本不应再进 prompt（fixture 第 1 页块内容）
    with conn.cursor() as cur:
        cur.execute("SELECT content_md FROM blocks WHERE page_id=%s LIMIT 1", (pid,))
        block_text = cur.fetchone()[0]
    if block_text:
        assert block_text not in seen[0]


def test_chapter_blocks_skip_excluded_pages(conn, doc_with_chapter):
    """章节拆条输入跳过被排除的页——广告/目录页不进 LLM 拆题窗口。"""
    from kb.rag.structure import _chapter_blocks

    doc_id, _cfg, _blocks = doc_with_chapter
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET excluded_from_index=true WHERE document_id=%s AND page_no=2",
            (doc_id,),
        )
        blocks = _chapter_blocks(cur, doc_id, 2, 3)
    assert [content for _bid, _btype, content in blocks] == ["1. 盼望祖国早日统一 算式谜"]

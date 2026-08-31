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
def doc_with_toc(conn, tmp_path):
    """1 本书：第 1 页是目录（块文本含"目录"），共 3 页。"""
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
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute(
            """UPDATE blocks SET content_md='目录 第 1 讲 xxx' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=1)"""
        )
    return doc_id, cfg


_FENCE = "`" * 3
TOC_JSON = _FENCE + "json\n" + (
    '[{"chapter_no": 1, "title": "乘除法竖式谜", "print_page": 1, "taxonomy": "计算类", "tags": ["倒推法", "枚举法"]},'
    '{"chapter_no": 2, "title": "三角形", "print_page": 10, "taxonomy": "几何类", "tags": ["构造思想"]}]'
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


def test_parse_json_array_strips_code_fence():
    from kb.toc import _parse_json_array
    data = _parse_json_array(TOC_JSON)
    assert data[0]["title"] == "乘除法竖式谜"
    assert data[1]["tags"] == ["构造思想"]


def test_extract_toc_writes_chapters(conn, doc_with_toc):
    from kb.toc import extract_toc

    doc_id, cfg = doc_with_toc
    n = extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, title, print_page, taxonomy FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, "乘除法竖式谜", 1, "计算类"), (2, "三角形", 10, "几何类")]
    assert extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON)) == 0  # 幂等


def test_extract_toc_auto_detects_toc_page(conn, doc_with_toc):
    """不显式给 toc_pages 时，应自动找到块文本含"目录"的第 1 页（只调用 1 次模型）。"""
    from kb.toc import extract_toc

    doc_id, cfg = doc_with_toc
    calls = []

    class SpyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                calls.append(1)
                return _client(TOC_JSON).chat.completions.create(model, messages, max_tokens)

    class SpyClient:
        chat = SpyChat()

    n = extract_toc(conn, cfg, doc_id, client=SpyClient())
    assert n == 2
    assert len(calls) == 1  # 只有第 1 页含"目录"


def test_calibrate_pages_maps_print_to_physical(conn, doc_with_toc):
    from kb.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    with conn.cursor() as cur:  # 第 1 讲标题出现在物理第 2 页，第 2 讲在物理第 3 页
        cur.execute(
            """UPDATE blocks SET content_md='第 1 讲 乘除法竖式谜 正文' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=2)"""
        )
        cur.execute(
            """UPDATE blocks SET content_md='第 2 讲 三角形 正文' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=3)"""
        )
    assert calibrate_pages(conn, doc_id) == 2
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, page_start, page_end FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, 2, 2), (2, 3, 3)]  # 文档共 3 页，末章到末页


def test_calibrate_pages_skips_toc_page(conn, doc_with_toc):
    """回归：目录页块文本含所有章节标题时，校准必须跳过目录页（真实数据踩过：全命中目录页导致 5->4 空区间）。"""
    from kb.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    with conn.cursor() as cur:
        cur.execute(  # 目录页同时含两个章节标题（模拟真实目录）
            """UPDATE blocks SET content_md='目录 乘除法竖式谜 1 三角形 10' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=1)"""
        )
        cur.execute(
            """UPDATE blocks SET content_md='第 1 讲 乘除法竖式谜 正文' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=2)"""
        )
        cur.execute(
            """UPDATE blocks SET content_md='第 2 讲 三角形 正文' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=3)"""
        )
    assert calibrate_pages(conn, doc_id) == 2
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, page_start, page_end FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, 2, 2), (2, 3, 3)]


def test_calibrate_pages_leaves_null_when_not_found(conn, doc_with_toc):
    from kb.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert calibrate_pages(conn, doc_id) == 0  # 页面没解析，定位不到
    with conn.cursor() as cur:
        cur.execute("SELECT page_start FROM chapters")
        assert all(r[0] is None for r in cur.fetchall())

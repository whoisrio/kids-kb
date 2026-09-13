import pymupdf as fitz
import pytest


def _cfg(tmp_path):
    from kb.core.config import Config
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
    from kb.ocr.layout import run_layout
    from kb.ocr.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "book.pdf"
    d = fitz.open()
    for _ in range(3):
        d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET parse_status='parsed'")
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
    from kb.rag.toc import _parse_json_array
    data = _parse_json_array(TOC_JSON)
    assert data[0]["title"] == "乘除法竖式谜"
    assert data[1]["tags"] == ["构造思想"]


def test_extract_toc_writes_chapters(conn, doc_with_toc):
    from kb.rag.toc import extract_toc

    doc_id, cfg = doc_with_toc
    n = extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, title, print_page, taxonomy FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, "乘除法竖式谜", 1, "计算类"), (2, "三角形", 10, "几何类")]
    assert extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON)) == 0  # 幂等


def test_extract_toc_auto_detects_toc_page(conn, doc_with_toc):
    """不显式给 toc_pages 时，应自动找到块文本含"目录"的第 1 页（只调用 1 次模型）。"""
    from kb.rag.toc import extract_toc

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
    from kb.rag.toc import calibrate_pages, extract_toc

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
    from kb.rag.toc import calibrate_pages, extract_toc

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
    from kb.rag.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    assert calibrate_pages(conn, doc_id) == 0  # 页面没解析，定位不到
    with conn.cursor() as cur:
        cur.execute("SELECT page_start FROM chapters")
        assert all(r[0] is None for r in cur.fetchall())


def test_calibrate_pages_detects_toc_by_title_density(conn, doc_with_toc):
    """回归：目录横幅是艺术字、OCR 成「目\\n录」（不含连续「目录」二字）时，
    校准仍须跳过目录页——靠标题密度判（命中 ≥半数且 ≥2 个章节标题即目录页），
    不靠搜「目录」字面量（真实数据踩过：7 星学霸目录页横幅 OCR 为 '目\\n录'）。"""
    from kb.rag.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))
    with conn.cursor() as cur:
        cur.execute(  # 目录页：横幅被 OCR 拆开 + 全部章节标题，无连续「目录」
            """UPDATE blocks SET content_md='目
录
第 1 讲 乘除法竖式谜………………1
第 2 讲 三角形………………10' WHERE page_id IN
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


def test_detect_toc_pages_tolerates_split_banner(conn, doc_with_toc):
    """目录横幅艺术字被 OCR 拆成「目\\n录」时，自动探测也要能找到目录页。"""
    from kb.rag.toc import detect_toc_pages

    doc_id, cfg = doc_with_toc
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE blocks SET content_md='目
录
第 1 讲 乘除法竖式谜……1' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=1)"""
        )
        assert detect_toc_pages(cur, doc_id) == [1]


def test_calibrate_pages_prefers_footer_print_page_offset(conn, doc_with_toc):
    """页脚有印刷页码时优先用偏移换算（章节横幅艺术字 OCR 不可靠的正解）：
    footer 纯数字拟合 物理页-印刷页 偏移众数，print_page+offset 得物理页；
    物理页未入库的章节留 NULL。"""
    from kb.rag.toc import calibrate_pages, extract_toc

    doc_id, cfg = doc_with_toc
    extract_toc(conn, cfg, doc_id, client=_client(TOC_JSON))  # 印刷页 1 / 10
    with conn.cursor() as cur:  # 物理 2 页 = 印刷 1 页，物理 3 页 = 印刷 2 页 → offset=1
        cur.execute(
            """UPDATE blocks SET block_type='footer', content_md='1' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=2)"""
        )
        cur.execute(
            """UPDATE blocks SET block_type='footer', content_md='$$ 2 $$' WHERE page_id IN
               (SELECT id FROM pages WHERE page_no=3)"""
        )
    assert calibrate_pages(conn, doc_id) == 1  # 第 2 讲印刷页 10 → 物理 11 未入库
    with conn.cursor() as cur:
        cur.execute("SELECT chapter_no, page_start, page_end FROM chapters ORDER BY chapter_no")
        assert cur.fetchall() == [(1, 2, 3), (2, None, None)]  # 唯一定位章到末页


def test_parse_json_array_tolerates_latex_backslashes():
    """模型在 JSON 字符串里直接写 LaTeX（\\square 等非法转义）时，清洗后仍能解析。"""
    from kb.rag.toc import _parse_json_array
    raw = '[{"content_md": "$\\\\square 7$"}, {"content_md": "正常"}]'
    # 模拟模型输出：\\square 写成了单反斜杠（非法 JSON 转义）
    raw = raw.replace("\\\\square", "\\square")
    data = _parse_json_array(raw)
    assert data[0]["content_md"] == "$\\square 7$"
    assert data[1]["content_md"] == "正常"

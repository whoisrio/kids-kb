import pymupdf as fitz
import pytest

from kb.config import Config


def _cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def parsed_doc(conn, tmp_path):
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = _cfg(tmp_path)
    p = tmp_path / "scan.pdf"
    d = fitz.open()
    d.new_page()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    return doc_id, cfg


class FakeMessage:
    content = "转录结果 $1+1=2$"


class FakeChoice:
    message = FakeMessage()


class FakeResponse:
    choices = [FakeChoice()]


class FakeChat:
    class completions:
        @staticmethod
        def create(model, messages, max_tokens):
            assert model == "qwen3:4b"
            return FakeResponse()


class FakeClient:
    chat = FakeChat()


def test_transcribe_image_calls_openai_compatible_api(tmp_path):
    from kb.parse import transcribe_image

    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG fake")
    text, usage = transcribe_image(FakeClient(), "qwen3:4b", img)
    assert text == "转录结果 $1+1=2$"
    assert usage == (None, None)  # 假客户端无 usage 时容忍 None


def test_transcribe_image_downscales_oversized_image(tmp_path):
    """超大整页扫描图先降采样再送视觉模型：vision token 数与分辨率正相关，
    高分辨率会让思考型模型 reasoning 爆预算、content 被截空。"""
    import base64

    from kb.parse import transcribe_image

    big = fitz.open()
    page = big.new_page(width=3000, height=4000)
    img = tmp_path / "big.png"
    page.get_pixmap().save(str(img))

    captured = {}

    class CapChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                captured["url"] = messages[0]["content"][1]["image_url"]["url"]
                return FakeResponse()

    class CapClient:
        chat = CapChat()

    transcribe_image(CapClient(), "m", img)
    payload = base64.b64decode(captured["url"].split(",", 1)[1])
    small = fitz.open(stream=payload, filetype="png")
    pix = small[0].get_pixmap()
    assert max(pix.width, pix.height) <= 2000


def test_transcribe_image_disables_reasoning_and_falls_back(tmp_path):
    """思考型模型（qwen3.5）reasoning 会烧穿输出预算把 content 截空：
    默认带 reasoning_effort=none；服务端不认这个参数时降级为普通调用。"""
    from kb.parse import transcribe_image

    img = tmp_path / "p.png"
    img.write_bytes(b"\x89PNG fake")
    calls = []

    class RejectChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens, **kwargs):
                calls.append(kwargs)
                if "extra_body" in kwargs:
                    raise RuntimeError("reasoning_effort not supported")
                return FakeResponse()

    class RejectClient:
        chat = RejectChat()

    text, _ = transcribe_image(RejectClient(), "m", img)
    assert text == "转录结果 $1+1=2$"
    assert len(calls) == 2
    assert calls[0]["extra_body"] == {"reasoning_effort": "none"}
    assert "extra_body" not in calls[1]

    class AcceptChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens, **kwargs):
                calls.append(kwargs)
                return FakeResponse()

    class AcceptClient:
        chat = AcceptChat()

    transcribe_image(AcceptClient(), "m", img)
    assert calls[-1]["extra_body"] == {"reasoning_effort": "none"}


def test_run_parse_fills_block_content_and_marks_page(conn, parsed_doc):
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    n = run_parse(conn, cfg, doc_id, client=FakeClient())
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM blocks WHERE content_md IS NOT NULL")
        assert cur.fetchone()[0] == 2
        cur.execute("SELECT status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}


def test_run_parse_failure_marks_page_failed(conn, parsed_doc):
    from kb.parse import run_parse

    class BoomChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                raise RuntimeError("模型挂了")

    class BoomClient:
        chat = BoomChat()

    doc_id, cfg = parsed_doc
    n = run_parse(conn, cfg, doc_id, client=BoomClient())
    assert n == 0
    with conn.cursor() as cur:
        cur.execute("SELECT status, parse_error FROM pages WHERE document_id=%s", (doc_id,))
        rows = cur.fetchall()
    assert all(s == "failed" and "模型挂了" in (e or "") for s, e in rows)


def test_run_parse_repairs_drifted_page_status(conn, parsed_doc):
    """历史 bug 可能把已解析页打回 rendered；run_parse 应按块内容自愈页状态。"""
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    with conn.cursor() as cur:  # 模拟状态漂移：内容在，状态被重置
        cur.execute("UPDATE blocks SET content_md='已有内容'")
        cur.execute("UPDATE pages SET status='rendered'")
    assert run_parse(conn, cfg, doc_id, client=FakeClient()) == 0  # 无待解析块
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM pages WHERE document_id=%s", (doc_id,))
        assert {r[0] for r in cur.fetchall()} == {"parsed"}


def test_ocr_text_blocks_with_rapidocr(tmp_path):
    """rapidocr 真能认出渲染出来的文字（本地 ONNX，无需模型服务）。"""
    from kb.parse import ocr_image

    img = tmp_path / "t.png"
    d = fitz.open()
    pg = d.new_page()
    pg.insert_text((36, 72), "乘除法竖式谜", fontsize=24, fontname="china-s")  # 默认 helv 不支持 CJK
    pg.get_pixmap(dpi=150).save(img)
    text = ocr_image(img)
    assert "乘除法竖式谜" in text.replace(" ", "")


def test_run_parse_routes_by_block_type(conn, parsed_doc):
    """text 块走 ocr（不调视觉模型），formula 块走视觉模型。"""
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    calls = []

    class SpyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                calls.append(model)

                class M:
                    content = "视觉结果"

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class SpyClient:
        chat = SpyChat()

    with conn.cursor() as cur:  # 把第 1 块改成 text，第 2 块改成 formula
        cur.execute("SELECT id FROM blocks ORDER BY created_at LIMIT 2")
        b1, b2 = [r[0] for r in cur.fetchall()]
        cur.execute("UPDATE blocks SET block_type='text' WHERE id=%s", (b1,))
        cur.execute("UPDATE blocks SET block_type='formula' WHERE id=%s", (b2,))

    def fake_ocr(image_path):
        calls.append("ocr")
        return "OCR结果"

    n = run_parse(conn, cfg, doc_id, client=SpyClient(), ocr=fake_ocr)
    assert n == 2
    assert calls.count("ocr") == 1  # text 块走 ocr
    assert calls.count(cfg.vision_model) == 1  # formula 块走视觉模型


def test_run_parse_escalates_starred_ocr_to_vlm(conn, parsed_doc):
    """OCR 兜底产出多行星号/方框（竖式被拍扁）-> 升级视觉模型重转录。"""
    from kb.parse import run_parse

    doc_id, cfg = parsed_doc
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM blocks ORDER BY created_at LIMIT 2")
        b1, b2 = [r[0] for r in cur.fetchall()]
        cur.execute("UPDATE blocks SET block_type='text' WHERE id IN (%s,%s)", (b1, b2))

    class SpyChat:
        class completions:
            @staticmethod
            def create(model, messages, max_tokens):
                class M:
                    content = "$$\\begin{array}{r} 1+1=2 \\end{array}$$"

                class C:
                    message = M()

                class R:
                    choices = [C()]

                return R()

    class SpyClient:
        chat = SpyChat()

    texts = iter(["我你他\n×你我他\n***我\n***你", "普通文字没有符号"])
    n = run_parse(conn, cfg, doc_id, client=SpyClient(), ocr=lambda p: next(texts))
    assert n == 2
    with conn.cursor() as cur:
        cur.execute("SELECT source_model, content_md FROM blocks WHERE id=%s", (b1,))
        source, content = cur.fetchone()
        assert source == "qwen3:4b"  # 升级到了视觉模型
        assert "array" in content
        cur.execute("SELECT source_model FROM blocks WHERE id=%s", (b2,))
        assert cur.fetchone()[0] == "rapidocr"  # 正常文字不升级

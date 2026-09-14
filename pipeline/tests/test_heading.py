"""标题层级判定（ingest heading 阶段）：候选过滤 / 分批锚点 / 幂等 / 容错。"""
import time
import uuid

import pytest
from psycopg.types.json import Jsonb

from kb.core.config import Config


def _cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test_a",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


def _mk_doc(conn, tmp_path, blocks_spec):
    """建 1 个文档 + 按需建页和块。

    blocks_spec: [(page_no, ordinal, block_type, content_md, bbox, excluded, title_level)]
    """
    doc_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,'t',%s)",
            (doc_id, str(tmp_path / f"{doc_id}.pdf")),
        )
        page_ids = {}
        for page_no, ordinal, btype, content, bbox, excluded, title_level in blocks_spec:
            if page_no not in page_ids:
                pid = str(uuid.uuid4())
                cur.execute(
                    """INSERT INTO pages (id, document_id, page_no, image_path,
                                          excluded_from_index)
                       VALUES (%s,%s,%s,'p.png',%s)""",
                    (pid, doc_id, page_no, excluded),
                )
                page_ids[page_no] = pid
            cur.execute(
                """INSERT INTO blocks (page_id, block_type, bbox, crop_path, ordinal,
                                       content_md, title_level)
                   VALUES (%s,%s,%s,'c.png',%s,%s,%s)""",
                (page_ids[page_no], btype, Jsonb(bbox) if bbox else None,
                 ordinal, content, title_level),
            )
    return doc_id


def _client(responses, calls):
    """假 LLM client：responses 依次吐出（list）或恒定（str），calls 收集每次的 user prompt。"""
    class Completions:
        @staticmethod
        def create(model, messages, max_tokens, **kwargs):
            calls.append(messages[-1]["content"])
            text = responses.pop(0) if isinstance(responses, list) else responses

            class M:
                content = text

            class C:
                message = M()

            class R:
                choices = [C()]

            return R()

    class Chat:
        completions = Completions()

    class Client:
        chat = Chat()

    return Client()


def _levels(conn, doc_id):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.content_md, b.title_level FROM blocks b
               JOIN pages p ON p.id=b.page_id
               WHERE p.document_id=%s ORDER BY p.page_no, b.ordinal""",
            (doc_id,),
        )
        return cur.fetchall()


def test_detect_headings_assigns_levels(conn, tmp_path):
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "title", "第 1 讲 乘除法竖式谜", [10, 10, 500, 90], False, None),
        (2, 1, "title", "一、竖式谜的突破口", [10, 10, 400, 60], False, None),
        (3, 1, "title", "（一）首位分析法", [10, 10, 300, 40], False, None),
    ])
    calls = []
    n = detect_headings(conn, _cfg(tmp_path), doc_id,
                        client=_client('[{"index":1,"level":1},{"index":2,"level":2},'
                                       '{"index":3,"level":3}]', calls))
    assert n == 3
    assert _levels(conn, doc_id) == [
        ("第 1 讲 乘除法竖式谜", 1), ("一、竖式谜的突破口", 2), ("（一）首位分析法", 3)]
    assert len(calls) == 1
    # 块特征进 prompt：页码 + bbox 高度 + 文本
    assert "第1页" in calls[0] and "高度80" in calls[0] and "乘除法竖式谜" in calls[0]
    # 计量落 llm_calls，purpose='heading'
    with conn.cursor() as cur:
        cur.execute("SELECT purpose FROM llm_calls WHERE document_id=%s", (doc_id,))
        assert [r[0] for r in cur.fetchall()] == ["heading"]


def test_detect_headings_idempotent_skips_judged(conn, tmp_path):
    """已判定的块天然跳过：只送未判定块，全部判完后重跑返回 0 且不再调模型。"""
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "title", "第 1 讲 乘除法竖式谜", [10, 10, 500, 90], False, 1),  # 已判定
        (2, 1, "title", "一、突破口", [10, 10, 400, 60], False, None),
    ])
    calls = []
    n = detect_headings(conn, _cfg(tmp_path), doc_id,
                        client=_client('[{"index":1,"level":2}]', calls))
    assert n == 1
    assert len(calls) == 1 and "乘除法竖式谜" not in calls[0]
    assert _levels(conn, doc_id) == [("第 1 讲 乘除法竖式谜", 1), ("一、突破口", 2)]
    calls2 = []
    assert detect_headings(conn, _cfg(tmp_path), doc_id,
                           client=_client("[]", calls2)) == 0
    assert calls2 == []  # 没有候选就不再调模型


def test_detect_headings_batches_with_anchors(conn, tmp_path, monkeypatch):
    """>BATCH_SIZE 出两批；第二批 prompt 带上一批末尾的已判定锚点（文本+层级）。"""
    import kb.ocr.heading as heading
    monkeypatch.setattr(heading, "BATCH_SIZE", 3)

    spec = [(1, i, "title", f"标题{i}", [10, 10, 400, 60], False, None) for i in range(1, 4)]
    spec += [(2, 1, "title", "标题4", [10, 10, 400, 60], False, None)]
    doc_id = _mk_doc(conn, tmp_path, spec)
    calls = []
    responses = [
        '[{"index":1,"level":1},{"index":2,"level":2},{"index":3,"level":3}]',
        '[{"index":1,"level":2}]',
    ]
    n = heading.detect_headings(conn, _cfg(tmp_path), doc_id, client=_client(responses, calls))
    assert n == 4
    assert len(calls) == 2
    assert "标题1" in calls[0] and "标题4" not in calls[0]
    assert "标题4" in calls[1]
    # 锚点：上一批判定的文本+层级进第二批 prompt
    assert "标题1" in calls[1] and "标题3" in calls[1]
    assert "L1" in calls[1] and "L3" in calls[1]


def test_detect_headings_bad_json_retries_once_then_leaves_null(conn, tmp_path, monkeypatch):
    """解析失败重试一次（sleep 3），仍失败该批留 NULL 等下轮断点续跑。"""
    monkeypatch.setattr(time, "sleep", lambda s: None)
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "title", "第 1 讲 乘除法竖式谜", [10, 10, 500, 90], False, None),
        (2, 1, "title", "一、突破口", [10, 10, 400, 60], False, None),
    ])
    calls = []
    n = detect_headings(conn, _cfg(tmp_path), doc_id,
                        client=_client(["这不是JSON", "依然是垃圾"], calls))
    assert n == 0
    assert len(calls) == 2  # 重试一次
    assert _levels(conn, doc_id) == [
        ("第 1 讲 乘除法竖式谜", None), ("一、突破口", None)]


def test_detect_headings_retry_recovers(conn, tmp_path, monkeypatch):
    """第一次输出坏 JSON，重试成功则正常落库。"""
    monkeypatch.setattr(time, "sleep", lambda s: None)
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "title", "第 1 讲 乘除法竖式谜", [10, 10, 500, 90], False, None),
    ])
    calls = []
    n = detect_headings(conn, _cfg(tmp_path), doc_id,
                        client=_client(["坏输出", '[{"index":1,"level":1}]'], calls))
    assert n == 1
    assert len(calls) == 2
    assert _levels(conn, doc_id) == [("第 1 讲 乘除法竖式谜", 1)]


def test_detect_headings_invalid_entries_dropped(conn, tmp_path):
    """非法 level（非 1/2/3）丢弃该条；漏判/越界的 index 跳过不炸。"""
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "title", "第 1 讲 A", [10, 10, 500, 90], False, None),
        (1, 2, "title", "一、B", [10, 10, 400, 60], False, None),
        (1, 3, "title", "（一）C", [10, 10, 300, 40], False, None),
    ])
    n = detect_headings(conn, _cfg(tmp_path), doc_id, client=_client(
        '[{"index":1,"level":5},{"index":2,"level":2},{"index":9,"level":1},'
        '{"index":"x","level":1},{"level":3}]', []))
    assert n == 1
    assert _levels(conn, doc_id) == [("第 1 讲 A", None), ("一、B", 2), ("（一）C", None)]


def test_text_block_with_chapter_number_is_candidate(conn, tmp_path):
    """版面模型把章节横幅判成 text 时，靠编号线索（第N讲/章/节/课/单元）入选。"""
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "text", "第 3 讲 和差问题", [10, 10, 500, 90], False, None),
        (1, 2, "text", "这是一段普通的正文，不是标题。", [10, 10, 300, 40], False, None),
        (1, 3, "formula", "$$1+1=2$$", [10, 10, 300, 40], False, None),
    ])
    calls = []
    n = detect_headings(conn, _cfg(tmp_path), doc_id,
                        client=_client('[{"index":1,"level":1}]', calls))
    assert n == 1
    assert len(calls) == 1
    assert "和差问题" in calls[0] and "普通的正文" not in calls[0]
    assert _levels(conn, doc_id) == [
        ("第 3 讲 和差问题", 1), ("这是一段普通的正文，不是标题。", None),
        ("$$1+1=2$$", None)]


def test_excluded_page_blocks_not_candidates(conn, tmp_path):
    """excluded_from_index 页（目录/广告/封面）上的块不入选。"""
    from kb.ocr.heading import detect_headings

    doc_id = _mk_doc(conn, tmp_path, [
        (1, 1, "title", "目录页标题", [10, 10, 500, 90], True, None),
        (2, 1, "title", "第 1 讲 正文标题", [10, 10, 500, 90], False, None),
    ])
    calls = []
    n = detect_headings(conn, _cfg(tmp_path), doc_id,
                        client=_client('[{"index":1,"level":1}]', calls))
    assert n == 1
    assert len(calls) == 1 and "目录页标题" not in calls[0]
    assert _levels(conn, doc_id) == [("目录页标题", None), ("第 1 讲 正文标题", 1)]

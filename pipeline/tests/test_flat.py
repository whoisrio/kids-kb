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

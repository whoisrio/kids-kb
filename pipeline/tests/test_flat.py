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

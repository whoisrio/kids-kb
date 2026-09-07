"""approve：approve 条数 + 向量化条数进 trajectory。"""
import uuid

from kb.config import Config
from kb.embed import approve_items


class FakeEmbedClient:
    class embeddings:
        @staticmethod
        def create(**kw):
            return type("R", (), {"data": [type("D", (), {"embedding": [0.1] * 1024})()]})()


def _cfg(tmp_path, level="simple"):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


def test_approve_items_records_events(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
            (doc_id, "approve 测试", f"/tmp/{doc_id}.pdf"),
        )
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md)
               VALUES (%s,%s,'exercise','1','1+1=?')""",
            (str(uuid.uuid4()), doc_id),
        )
    out = approve_items(conn, _cfg(tmp_path), doc_id, client=FakeEmbedClient())
    assert out["approved"] == 1
    with conn.cursor() as cur:
        cur.execute(
            """SELECT stage, event_type FROM pipeline_events
               WHERE document_id=%s ORDER BY id""",
            (doc_id,),
        )
        rows = cur.fetchall()
    stages = {(r[0], r[1]) for r in rows}
    assert ("approve", "stage_start") in stages
    assert ("approve", "decision") in stages
    assert ("embed", "decision") in stages
    assert ("approve", "stage_end") in stages

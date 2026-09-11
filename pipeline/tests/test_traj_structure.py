"""structure 编排：run 级阶段事件 + 拆条 llm_call。"""
import uuid

from kb.core.config import Config
from kb.rag.structure import run_structure


class _FakeMessage:
    def __init__(self, content):
        self.content = content


class _FakeResp:
    def __init__(self, content):
        self.choices = [type("C", (), {"message": _FakeMessage(content)})()]
        self.usage = type("U", (), {"prompt_tokens": 10, "completion_tokens": 5})()


class FakeStructureClient:
    """structure_chapter 的 chat.completions.create 返回空条目数组。"""

    class chat:
        class completions:
            @staticmethod
            def create(**kw):
                return _FakeResp("[]")


def _cfg(tmp_path, level="simple"):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


def test_run_structure_flat_records_stages(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
            (doc_id, "flat 测试", f"/tmp/{doc_id}.pdf"),
        )
        cur.execute(
            "INSERT INTO pages (id, document_id, page_no, image_path) VALUES (%s,%s,%s,%s)",
            (str(uuid.uuid4()), doc_id, 1, "/tmp/p1.png"),
        )
    out = run_structure(conn, _cfg(tmp_path), doc_id, flat=True)
    assert out["mode"] == "flat"
    with conn.cursor() as cur:
        cur.execute(
            """SELECT stage, event_type FROM pipeline_events
               WHERE document_id=%s ORDER BY id""",
            (doc_id,),
        )
        rows = cur.fetchall()
    assert ("structure", "stage_start") in rows
    assert ("structure", "stage_end") in rows
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(DISTINCT run_id) FROM pipeline_events WHERE document_id=%s",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1

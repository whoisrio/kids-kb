"""ingest 编排：run 级阶段事件 + parse 的 llm_call 事件带 page_id。"""
import uuid

import pymupdf
import pytest

from kb.core.config import Config
from kb.pdf_ingest import ingest


class _FakeMessage:
    content = "转录内容"


class _FakeChoice:
    message = _FakeMessage()


class _FakeUsage:
    prompt_tokens = 10
    completion_tokens = 5


class _FakeResp:
    choices = [_FakeChoice()]
    usage = _FakeUsage()


class _FakeCompletions:
    def create(self, **kw):
        return _FakeResp()


class _FakeChat:
    completions = _FakeCompletions()


class FakeClient:
    chat = _FakeChat()


def _cfg(tmp_path, level="simple"):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


@pytest.fixture()
def pdf(tmp_path):
    p = tmp_path / "a.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(p)
    doc.close()
    return p


def test_ingest_records_stage_events(conn, tmp_path, pdf):
    cfg = _cfg(tmp_path)
    doc_id = ingest(conn, cfg, pdf, "traj 测试", client=FakeClient())
    with conn.cursor() as cur:
        cur.execute(
            """SELECT DISTINCT stage FROM pipeline_events
               WHERE document_id=%s AND event_type='stage_start'""",
            (doc_id,),
        )
        stages = {r[0] for r in cur.fetchall()}
    assert {"render", "layout", "parse", "qc", "crosscheck"} <= stages
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(DISTINCT run_id) FROM pipeline_events WHERE document_id=%s",
            (doc_id,),
        )
        assert cur.fetchone()[0] == 1


def test_ingest_off_records_nothing(conn, tmp_path, pdf):
    cfg = _cfg(tmp_path, level="off")
    doc_id = ingest(conn, cfg, pdf, "traj 测试", client=FakeClient())
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pipeline_events WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0

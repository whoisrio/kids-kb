"""Recorder：级别裁剪、JSONL 镜像、记录失败不阻塞主链路。"""
import json
import uuid

import pytest

from kb.config import Config
from kb.traj import Recorder


def _cfg(tmp_path, level):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        trajectory_level=level,
    )


def _mk_doc(cur):
    doc_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
        (doc_id, "traj", f"/tmp/{doc_id}.pdf"),
    )
    return doc_id


def _events(conn, doc_id):
    with conn.cursor() as cur:
        cur.execute(
            """SELECT stage, event_type, summary, payload, status FROM pipeline_events
               WHERE document_id=%s ORDER BY id""",
            (doc_id,),
        )
        return cur.fetchall()


def test_verbose_writes_payload_and_jsonl(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "verbose"), doc_id)
    rec.llm_call("parse", "transcribe qwen3:4b", model="qwen3:4b",
                 usage=(100, 50), prompt="完整提示词", output="完整输出")
    rows = _events(conn, doc_id)
    assert len(rows) == 1
    assert rows[0][3] == {"prompt": "完整提示词", "output": "完整输出"}
    mirror = tmp_path / "storage" / doc_id / "trajectory" / f"{rec.run_id}.jsonl"
    lines = mirror.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["stage"] == "parse"


def test_simple_strips_payload(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "simple"), doc_id)
    rec.llm_call("parse", "transcribe qwen3:4b", model="qwen3:4b",
                 usage=(100, 50), prompt="完整提示词", output="完整输出")
    rows = _events(conn, doc_id)
    assert len(rows) == 1
    assert rows[0][2] == "transcribe qwen3:4b"
    assert rows[0][3] is None


def test_off_is_noop(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "off"), doc_id)
    rec.start("parse", "开始解析")
    rec.llm_call("parse", "x", model="m")
    assert _events(conn, doc_id) == []
    assert not (tmp_path / "storage" / doc_id / "trajectory").exists()


def test_db_failure_does_not_raise(tmp_path):
    class BadConn:
        def cursor(self):
            raise RuntimeError("db down")

    rec = Recorder(BadConn(), _cfg(tmp_path, "simple"), str(uuid.uuid4()))
    rec.start("parse", "开始解析")
    rec.error("parse", "失败")


def test_start_end_duration(conn, tmp_path):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
    rec = Recorder(conn, _cfg(tmp_path, "simple"), doc_id)
    t0 = rec.start("parse", "开始")
    rec.end("parse", "结束", started=t0)
    rows = _events(conn, doc_id)
    assert [r[1] for r in rows] == ["stage_start", "stage_end"]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT duration_ms FROM pipeline_events WHERE document_id=%s AND event_type='stage_end'",
            (doc_id,),
        )
        assert cur.fetchone()[0] is not None

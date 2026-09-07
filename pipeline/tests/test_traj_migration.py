"""pipeline_events 表：migration 建表 + 删文档级联删事件。"""
import uuid


def _mk_doc(cur, title="traj 测试"):
    doc_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO documents (id, title, source_path) VALUES (%s,%s,%s)",
        (doc_id, title, f"/tmp/{doc_id}.pdf"),
    )
    return doc_id


def test_pipeline_events_table_exists(conn):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
        cur.execute(
            """INSERT INTO pipeline_events (run_id, document_id, stage, event_type, summary)
               VALUES (%s,%s,'parse','stage_start','测试事件')""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute(
            "SELECT stage, event_type, status, actor FROM pipeline_events WHERE document_id=%s",
            (doc_id,),
        )
        assert cur.fetchone() == ("parse", "stage_start", "ok", "pipeline")


def test_pipeline_events_cascade_on_document_delete(conn):
    with conn.cursor() as cur:
        doc_id = _mk_doc(cur)
        cur.execute(
            """INSERT INTO pipeline_events (run_id, document_id, stage, event_type, summary)
               VALUES (%s,%s,'parse','stage_start','测试事件')""",
            (str(uuid.uuid4()), doc_id),
        )
        cur.execute("DELETE FROM documents WHERE id=%s", (doc_id,))
        cur.execute("SELECT count(*) FROM pipeline_events WHERE document_id=%s", (doc_id,))
        assert cur.fetchone()[0] == 0

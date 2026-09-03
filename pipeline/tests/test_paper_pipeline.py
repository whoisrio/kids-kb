"""试卷管线:页图渲染 -> 每页单次 VLM 拆题+对错识别 -> 裁题图 -> 全量替换落库。

设计:docs/superpowers/specs/2026-09-03-paper-pipeline-design.md
papers.status 由 TS 编排层管理;本模块只写 source_path/page_count/paper_questions 与文件。
"""
# tests/test_paper_pipeline.py 先只放 schema 断言;后续 Task 逐步补充。
import uuid

import pytest


@pytest.fixture()
def child(conn):
    cid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (id, name) VALUES (%s,%s)", (cid, "小宝"))
    return cid


def _paper(conn, child_id, status="processing"):
    pid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO papers (id, child_id, title, subject, status) VALUES (%s,%s,%s,%s,%s)",
            (pid, child_id, "期中卷", "数学", status),
        )
    return pid


def test_papers_schema(conn, child):
    with conn.cursor() as cur:
        # subject / status 受控词表
        with pytest.raises(Exception):
            cur.execute(
                "INSERT INTO papers (id, child_id, title, subject) VALUES (%s,%s,%s,%s)",
                (str(uuid.uuid4()), child, "x", "体育"),
            )
        cur.execute(
            "INSERT INTO papers (id, child_id, title, subject) VALUES (%s,%s,%s,%s)",
            (str(uuid.uuid4()), child, "x", "数学"),
        )
        with pytest.raises(Exception):
            cur.execute(
                "INSERT INTO papers (id, child_id, title, subject, status) VALUES (%s,%s,%s,%s,%s)",
                (str(uuid.uuid4()), child, "x", "数学", "bogus"),
            )


def test_attempts_relaxed_for_paper(conn, child):
    paper = _paper(conn, child)
    qid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO paper_questions
               (id, paper_id, page_no, seq_in_page, content_md, recognized_result)
               VALUES (%s,%s,1,1,'1+1=',NULL)""",
            (qid, paper),
        )
        # 只有 paper_question_id 也能入 attempts(item_id 为空合法)
        cur.execute(
            "INSERT INTO attempts (child_id, paper_question_id, result) VALUES (%s,%s,'wrong')",
            (child, qid),
        )
        # 两者皆空仍拒绝
        with pytest.raises(Exception):
            conn.execute(
                "INSERT INTO attempts (child_id, result) VALUES (%s,'wrong')", (child,)
            )
        # paper_question 级联删除连带 attempts
        cur.execute("DELETE FROM paper_questions WHERE id=%s", (qid,))
        n = cur.execute("SELECT count(*) FROM attempts WHERE paper_question_id=%s", (qid,)).fetchone()[0]
        assert n == 0

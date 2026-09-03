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


class TestParsePageQuestions:
    def _run(self, text):
        from kb.paper_pipeline import parse_page_questions
        return parse_page_questions(text)

    def test_正常_JSON_规范化(self):
        qs = self._run(
            '{"questions": [{"seq_in_page": 3, "bbox": [10, 20, 500, 200],'
            ' "content_md": "246 × 37 =", "answer_excerpt": "9102",'
            ' "result": "wrong", "mark_desc": "老师红笔 ✗"}]}'
        )
        assert qs == [{
            "seq_in_page": 1,  # 按数组顺序重编,不信模型的编号
            "bbox": [10, 20, 500, 200],
            "content_md": "246 × 37 =",
            "answer_excerpt": "9102",
            "recognized_result": "wrong",
            "mark_desc": "老师红笔 ✗",
        }]

    def test_剥掉_markdown_围栏(self):
        qs = self._run('```json\n{"questions": [{"content_md": "1+1="}]}\n```')
        assert qs[0]["content_md"] == "1+1="

    def test_result_非法归_null_缺字段兜底(self):
        qs = self._run('{"questions": [{"content_md": "1+1=", "result": "对"}]}')
        assert qs[0]["recognized_result"] is None
        assert qs[0]["bbox"] is None
        assert qs[0]["answer_excerpt"] is None

    def test_bbox_越界_clamp_倒序交换_过小作废(self):
        assert self._run('{"questions": [{"content_md": "x", "bbox": [-50, 990, 2000, 2000]}]}')[0]["bbox"] == [0, 990, 1000, 1000]
        assert self._run('{"questions": [{"content_md": "x", "bbox": [500, 200, 100, 400]}]}')[0]["bbox"] == [100, 200, 500, 400]
        assert self._run('{"questions": [{"content_md": "x", "bbox": [10, 10, 12, 400]}]}')[0]["bbox"] is None

    def test_非_JSON_或缺_questions_抛_ValueError(self):
        with pytest.raises(ValueError):
            self._run("这不是 JSON")
        with pytest.raises(ValueError):
            self._run('{"foo": 1}')
        with pytest.raises(ValueError):
            self._run('{"questions": [{"answer_excerpt": "无题干"}]}')

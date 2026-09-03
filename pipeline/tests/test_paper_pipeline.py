"""试卷管线:页图渲染 -> 每页单次 VLM 拆题+对错识别 -> 裁题图 -> 全量替换落库。

设计:docs/superpowers/specs/2026-09-03-paper-pipeline-design.md
papers.status 由 TS 编排层管理;本模块只写 source_path/page_count/paper_questions 与文件。
"""
# tests/test_paper_pipeline.py 先只放 schema 断言;后续 Task 逐步补充。
import json as _json
import uuid
from pathlib import Path

import pytest


@pytest.fixture()
def child(conn):
    cid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (id, name) VALUES (%s,%s)", (cid, "小宝"))
    return cid


@pytest.fixture()
def cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="fake",
    )


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


class FakeVLM:
    """按调用次数弹回预设响应;记录收到的 prompt 供断言。"""

    def __init__(self, responses: list[str]):
        self.responses = list(responses)
        self.prompts: list[str] = []

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    def create(self, *, messages, **_kw):
        from types import SimpleNamespace
        self.prompts.append(messages[0]["content"][0]["text"])
        text = self.responses.pop(0)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=20),
        )


def _make_pdf(tmp_path, pages: int = 1) -> str:
    import pymupdf as fitz
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=595, height=842)
    p = str(tmp_path / "source.pdf")
    doc.save(p)
    return p


def _vlm_json(questions: list[dict]) -> str:
    return _json.dumps({"questions": questions}, ensure_ascii=False)


def _responses_for(pages_with_questions: list[list[dict]]) -> list[str]:
    return [_vlm_json(qs) for qs in pages_with_questions]


class TestIngestPaper:
    def test_拆题落库_裁图_计量_页数回填(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper
        pid = _paper(conn, child)
        pdf = _make_pdf(tmp_path)
        vlm = FakeVLM(_responses_for([[
            {"seq_in_page": 1, "bbox": [0, 0, 500, 300], "content_md": "1. 246 × 37 =",
             "answer_excerpt": "9102", "result": "wrong", "mark_desc": "红笔 ✗"},
        ]]))
        out = ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(), client=vlm)
        assert out == {"pages": 1, "questions": 1}
        row = conn.execute(
            "SELECT page_no, seq_in_page, content_md, recognized_result, bbox, image_path, "
            "answer_excerpt, mark_desc FROM paper_questions WHERE paper_id=%s", (pid,)
        ).fetchone()
        assert row[0] == 1 and row[1] == 1
        assert row[2] == "1. 246 × 37 =" and row[3] == "wrong"
        assert row[4] == [0, 0, 500, 300]
        assert row[5] and Path(row[5]).exists()      # 题图裁切落盘
        assert row[6] == "9102" and row[7] == "红笔 ✗"
        paper = conn.execute(
            "SELECT source_path, page_count FROM papers WHERE id=%s", (pid,)).fetchone()
        assert Path(paper[0]).exists() and paper[1] == 1
        meter = conn.execute(
            "SELECT count(*) FROM llm_calls WHERE paper_id=%s AND purpose='paper_vlm' "
            "AND modality='image'", (pid,)).fetchone()[0]
        assert meter == 1

    def test_幂等_重跑全量替换(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper
        pid = _paper(conn, child)
        pdf = _make_pdf(tmp_path, pages=2)
        q = [{"seq_in_page": 1, "bbox": None, "content_md": "题", "result": None,
              "answer_excerpt": "", "mark_desc": ""}]
        ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(),
                     client=FakeVLM(_responses_for([q, q])))
        ingest_paper(conn, cfg, pid, client=FakeVLM(_responses_for([q, q])))  # 重驱动不带 bytes
        n = conn.execute(
            "SELECT count(*) FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert n == 2  # 不是 4

    def test_解析失败重试一次_再失败抛错且计量两次(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper
        pid = _paper(conn, child)
        pdf = _make_pdf(tmp_path)
        vlm = FakeVLM(["坏输出", "还是坏输出"])
        with pytest.raises(RuntimeError, match="解析失败"):
            ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(), client=vlm)
        assert len(vlm.prompts) == 2
        assert "严格修正" in vlm.prompts[1]  # 第二次带错误反馈
        assert conn.execute(
            "SELECT count(*) FROM llm_calls WHERE paper_id=%s", (pid,)).fetchone()[0] == 2


class TestRecognizePage:
    def test_只重跑目标页(self, conn, cfg, child, tmp_path):
        from kb.paper_pipeline import ingest_paper, recognize_page
        pid = _paper(conn, child, status="ready_for_review")
        pdf = _make_pdf(tmp_path, pages=2)
        q = [{"seq_in_page": 1, "bbox": None, "content_md": "旧题", "result": None,
              "answer_excerpt": "", "mark_desc": ""}]
        ingest_paper(conn, cfg, pid, pdf_bytes=Path(pdf).read_bytes(),
                     client=FakeVLM(_responses_for([q, q])))
        # 确认两题,模拟已有人工痕迹
        conn.execute("UPDATE paper_questions SET confirmed_result='correct' WHERE paper_id=%s", (pid,))
        new_q = [{"seq_in_page": 1, "bbox": None, "content_md": "新题", "result": "wrong",
                  "answer_excerpt": "", "mark_desc": ""}]
        out = recognize_page(conn, cfg, pid, 1, client=FakeVLM(_responses_for([new_q])))
        assert out == {"pages": 1, "questions": 1}
        rows = conn.execute(
            "SELECT page_no, content_md, confirmed_result FROM paper_questions "
            "WHERE paper_id=%s ORDER BY page_no, seq_in_page", (pid,)).fetchall()
        assert rows == [(1, "新题", None), (2, "旧题", "correct")]  # 页1重置,页2不动

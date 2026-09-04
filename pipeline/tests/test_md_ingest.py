"""md 入库:整份 markdown 切章 -> chapters.content_md -> 章节向量化 -> 章稿落盘。"""
import uuid

import pytest

from kb.config import Config


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


class _FakeEmbed:
    """确定性假 embedding:全 1 向量(embed_texts 逐条调用 create)。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()


def test_ingest_md_splits_chapters_and_embeds(conn, cfg, tmp_path):
    from kb.text_ingest import ingest_md

    md = tmp_path / "grammar.md"
    md.write_text(
        "# 一、修辞手法\n\n比喻句:本体是燕子。\n\n# 二、标点\n\n省略号表示语意未尽。\n",
        encoding="utf-8",
    )
    doc_id = ingest_md(conn, cfg, md, title="语法讲义", subject="语文",
                       doc_type="workbook", client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no, title, content_md FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        rows = cur.fetchall()
        assert len(rows) == 2
        assert rows[0][1] == "一、修辞手法" and "燕子" in rows[0][2]
        # 入库即向量化:章节 chunk 已就位(不经 structure/approve)
        cur.execute(
            """SELECT meta->>'kind', meta->>'chapter', meta->>'subject', seg_no
               FROM chunks WHERE document_id=%s AND chapter_id IS NOT NULL ORDER BY seg_no""",
            (doc_id,),
        )
        chunks = cur.fetchall()
        assert chunks and chunks[0] == ("chapter", "第 1 讲 一、修辞手法", "语文", 1)
    # 章稿落盘镜像
    assert (cfg.storage_dir / doc_id / "chapters" / "c01.md").exists()


def test_ingest_md_idempotent_by_path(conn, cfg, tmp_path):
    from kb.text_ingest import ingest_md

    md = tmp_path / "same.md"
    md.write_text("# 唯一章\n\n内容\n", encoding="utf-8")
    d1 = ingest_md(conn, cfg, md, title="t", client=_FakeEmbed())
    d2 = ingest_md(conn, cfg, md, title="t", client=_FakeEmbed())
    assert d1 == d2  # source_path 为幂等键
    with conn.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM chapters WHERE document_id=%s", (d1,))
        assert cur.fetchone()[0] == 1
        cur.execute(
            "SELECT count(*) FROM chunks WHERE document_id=%s", (d1,))
        assert cur.fetchone()[0] == 1

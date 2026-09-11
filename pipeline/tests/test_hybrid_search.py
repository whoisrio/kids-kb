"""混合检索：BM25（纯 Python，CJK 二元分词）+ 向量 + RRF 融合 + 可选 bge-reranker。"""
import uuid

import pymupdf as fitz
import pytest


@pytest.fixture()
def three_chunks(conn, tmp_path):
    """3 条 chunk：A 含'倒推法'但语义远，B 语义近但不含该词，C 两者皆弱。返回 (conn, cfg)。"""
    from kb.core.config import Config
    from kb.ocr.layout import run_layout
    from kb.ocr.render import render_document

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "s.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="t")
    run_layout(conn, doc_id)
    vecs = {"A": [1.0] + [0.0] * 1023, "B": [0.9] + [0.1] * 1023, "C": [-1.0] * 1024}
    texts = {"A": "用倒推法从末位往前推导竖式", "B": "加法交换律练习", "C": "无关内容"}
    for key, vec in vecs.items():
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md,
                                      qc_status)
                   VALUES (%s,%s,'exercise',%s,%s,'approved') RETURNING id""",
                (str(uuid.uuid4()), doc_id, key, texts[key]),
            )
            item_id = str(cur.fetchone()[0])
            cur.execute(
                """INSERT INTO chunks (item_id, document_id, content_md,
                                       meta, embedding)
                   VALUES (%s,%s,%s,%s,%s)""",
                (item_id, doc_id, texts[key],
                 '{"label": "%s"}' % key, "[" + ",".join(map(str, vec)) + "]"),
            )
    return conn, cfg


def test_bm25_exact_term_wins(three_chunks):
    """BM25：含查询词'倒推法'的 A 必须排第一（纯字符二元分词，无需 jieba）。"""
    from kb.rag.lexical import bm25_search

    conn, _cfg = three_chunks
    hits = bm25_search(conn, "倒推法 竖式", top_k=3)
    assert hits[0]["label"] == "A"
    assert hits[0]["bm25"] > hits[1]["bm25"]


def test_hybrid_rrf_fuses_lexical_and_vector(three_chunks):
    """RRF：A 是 BM25 第一、向量最远；B 向量最近、BM25 弱。融合后 A、B 都压过双弱的 C。"""
    from kb.rag.embed import search

    conn, cfg = three_chunks

    class QueryVec:
        """查询向量靠近 B（0.9,0.1,...）。"""

        class embeddings:
            @staticmethod
            def create(model, input):
                class D:
                    embedding = [0.9] + [0.1] * 1023

                class R:
                    data = [D()]

                return R()

    hits = search(conn, cfg, "倒推法", mode="hybrid", top_k=3, client=QueryVec())
    labels = [h["label"] for h in hits]
    assert labels.index("A") < labels.index("C")
    assert labels.index("B") < labels.index("C")
    assert hits[0]["label"] in ("A", "B")  # 双强者居首


def test_rerank_reorders_by_cross_encoder(three_chunks):
    """rerank：注入假 cross-encoder 把 C 打到第一 -> 结果按 rerank 分排序。"""
    from kb.rag.embed import search

    conn, cfg = three_chunks

    class FakeReranker:
        def compute_score(self, pairs):
            return [10.0 if "无关内容" in p[1] else 0.0 for p in pairs]

    hits = search(conn, cfg, "随便", mode="vector", reranker=FakeReranker(), top_k=2)
    assert hits[0]["label"] == "C"
    assert "rerank_score" in hits[0]

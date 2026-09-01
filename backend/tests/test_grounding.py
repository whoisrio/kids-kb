"""L1 编造筛查：item 文字句 vs 溯源块文本，检出"源块里压根没有"的内容（串章/脑补）。

定位是幻觉预筛而非正确性判定：OCR 错字被 LLM 修这类"合法偏离"会误报，
由人工在复核行裁决；对图 fidelity 属 L2（VLM 对裁图）。
"""
import uuid

import pymupdf as fitz
import pytest


def test_ungrounded_sentences_pure():
    from kb.grounding import ungrounded_sentences

    src = ["例1 在下面的方框中填上合适的数字。由 9×4=36 推出除数个位为4"]
    # 逐字句 + 数学段（应跳过）-> 无检出
    assert ungrounded_sentences(
        "**例1** 在下面的方框中填上合适的数字。\n$$\\begin{array}{r}\\square\\square\\end{array}$$",
        src) == []
    # 编造的串章内容 -> 检出，带摘录
    bad = ungrounded_sentences(
        "在下面的方框中填上合适的数字。如图，将三角形 ABC 绕点 C 顺时针旋转 30 度得到新三角形。",
        src)
    assert len(bad) == 1 and "三角形" in bad[0]
    # 短句豁免（栏目名）
    assert ungrounded_sentences("分析", src) == []


def test_inline_math_unwrapped_on_both_sides():
    """行内公式的字母内容参与比对（两侧一致解包），否则含变量的正常句被误报。"""
    from kb.grounding import ungrounded_sentences

    src = ["如图, 将三角形 $ABC$ 绕点 $C$ 按顺时针方向旋转 $30^{\\circ}$, 得到三角形 $A'B'C$。"]
    # 同一内容的不同排版（item 侧）应判接地
    assert ungrounded_sentences("如图，将三角形 $ABC$ 绕点 $C$ 按顺时针方向旋转 $30^{\\circ}$。", src) == []


@pytest.fixture()
def doc_item(conn, tmp_path):
    """1 页 1 块（源文本）+ 1 条 item 引用该块。"""
    from kb.config import Config
    from kb.layout import run_layout
    from kb.render import render_document

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
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md='在方框中填入合适的数字。由9乘4等于36推出除数个位为4。' RETURNING id")
        block_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
               VALUES (%s,%s,'example','例1','占位','第 1 讲') RETURNING id""",
            (str(uuid.uuid4()), doc_id),
        )
        item_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,'stem')",
            (item_id, block_id),
        )
    return doc_id, item_id


def test_run_grounding_flags_and_auto_closes(conn, doc_item):
    from kb.grounding import run_grounding

    doc_id, item_id = doc_item
    with conn.cursor() as cur:  # 忠实内容 -> 不建行
        cur.execute("UPDATE items SET content_md='在方框中填入合适的数字。由9乘4等于36推出除数个位为4。' WHERE id=%s",
                    (item_id,))
    assert run_grounding(conn, doc_id) == 0

    with conn.cursor() as cur:  # 混入脑补句 -> 建 ungrounded 行
        cur.execute("UPDATE items SET content_md=%s WHERE id=%s",
                    ("在方框中填入合适的数字。如图将三角形绕点顺时针旋转三十度得到新三角形。", item_id))
    assert run_grounding(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason, item_id, status FROM review_queue")
        reason, rid, st = cur.fetchone()
        assert reason.startswith("ungrounded:") and "三角形" in reason
        assert str(rid) == item_id and st == "pending"
    assert run_grounding(conn, doc_id) == 0  # 幂等

    with conn.cursor() as cur:  # 修复后重算 -> 自动关闭
        cur.execute("UPDATE items SET content_md='在方框中填入合适的数字。' WHERE id=%s", (item_id,))
    run_grounding(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue")
        assert cur.fetchone()[0] == "approved"


def test_run_grounding_flags_item_without_source_blocks(conn, doc_item):
    """一个溯源块都没有的 item -> 无出处。"""
    from kb.grounding import run_grounding

    doc_id, item_id = doc_item
    with conn.cursor() as cur:
        cur.execute("DELETE FROM item_blocks WHERE item_id=%s", (item_id,))
    assert run_grounding(conn, doc_id) == 1
    with conn.cursor() as cur:
        cur.execute("SELECT reason FROM review_queue")
        assert "no_source" in cur.fetchone()[0]


def test_unbalanced_display_math_across_blocks():
    """源块逐块剥数学段：跨块的残缺 $$ 定界符不能吞掉中间的正常文字。"""
    from kb.grounding import ungrounded_sentences
    # 块1 有未闭合的 $$，若先拼接再剥，块2 的正常文字会被当成公式吞掉
    src = ["$$\\begin{array}{r} 1+1 \\end{array}", "被除数末尾为7，竖式有余数为1，由此可以用倒推法"]
    assert ungrounded_sentences("被除数末尾为7，竖式有余数为1，由此可以用倒推法。", src) == []

"""阶段④结构化拆分：章节窗口（跨页合并）-> items + item_blocks。

块按页序编号进 prompt，模型输出每条 item 引用的块号；taxonomy/tags 取该章词表。
幂等：该章已有 items 则跳过。
"""
from __future__ import annotations

import uuid

from openai import OpenAI

from kb.config import Config
from kb.metering import extract_usage, record_llm_call
from kb.toc import _parse_json_array

_SKIP_TYPES = ("header", "footer")

STRUCTURE_PROMPT = (
    "下面是一本书某一讲的全部内容（已按阅读顺序排列，每块以【块N】编号）。\n"
    "请把它拆成条目，输出 JSON 数组，每项：\n"
    '- content_type: "example"(例题讲解，含解析) / "exercise"(练习题) / "answer"(答案解析)\n'
    "- label: 原书题号（如\"例1\"、\"3\"）\n"
    "- content_md: 该条目的完整内容（题干+例题解析），数学内容用 LaTeX（$...$）\n"
    "- block_ids: 该条目引用的块号数组\n"
    "规则：同一道题跨页/跨块要合并成一条；例题的题干和解析同属一条；只输出 JSON。\n"
    "文字必须忠于源块原文：只能拼接和整理顺序、修正明显 OCR 错字（如题号），"
    "把竖式/公式整理为 LaTeX；严禁改写、概括、补充或续写源块里没有的句子。\n\n"
    "本讲分类：{taxonomy}；思想方法：{tags}\n\n"
    "{blocks_text}"
)


def _chapter_blocks(cur, doc_id: str, page_start: int, page_end: int) -> list[tuple]:
    """章节窗口的输入：逐页按采用版本取——adopted=page_md 的页用整页转录（单条伪块，
    block_id 为 None 不进 item_blocks），其余页用块文本。"""
    cur.execute(
        """SELECT p.id, p.adopted_source, p.page_md FROM pages p
           WHERE p.document_id=%s AND p.page_no BETWEEN %s AND %s
           ORDER BY p.page_no""",
        (doc_id, page_start, page_end),
    )
    rows = []
    for page_id, adopted, page_md in cur.fetchall():
        if adopted == "page_md" and page_md:
            rows.append((None, "page", page_md))
            continue
        cur.execute(
            """SELECT b.id, b.block_type, b.content_md FROM blocks b
               WHERE b.page_id=%s
                 AND NOT (b.block_type = ANY(%s)) AND b.content_md IS NOT NULL
               ORDER BY b.created_at""",
            (page_id, list(_SKIP_TYPES)),
        )
        rows.extend(cur.fetchall())
    return rows


def structure_chapter(conn, cfg: Config, doc_id: str, chapter_no: int, client=None,
                      recorder=None) -> int:
    """拆分一章。返回新增 item 数。"""
    base_url, api_key, model = cfg.doc_ognize_endpoint()
    client = client or OpenAI(base_url=base_url, api_key=api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, chapter_no, title, taxonomy, tags, page_start, page_end, content_md
               FROM chapters WHERE document_id=%s AND chapter_no=%s""",
            (doc_id, chapter_no),
        )
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"章节不存在: doc={doc_id} 第 {chapter_no} 章")
        _cid, _no, title, taxonomy, tags, page_start, page_end, content_md = row
        if page_start is None and not content_md:
            return 0  # 页面未入库，跳过（放量重跑时自动补）
        chapter_label = f"第 {chapter_no} 讲 {title}"
        cur.execute(
            "SELECT 1 FROM items WHERE document_id=%s AND chapter=%s LIMIT 1",
            (doc_id, chapter_label),
        )
        if cur.fetchone():
            return 0  # 幂等
        if content_md:
            # docx 章：整份章稿作窗口（单条伪块，block_id None 不进 item_blocks）
            blocks = [(None, "chapter", content_md)]
        else:
            blocks = _chapter_blocks(cur, doc_id, page_start, page_end)
        if not blocks:
            return 0
        blocks_text = "\n\n".join(
            f"【块{i + 1}】{content}" for i, (_bid, _bt, content) in enumerate(blocks)
        )
        prompt = STRUCTURE_PROMPT.format(
            taxonomy=taxonomy or "未知", tags="、".join(tags or []) or "无",
            blocks_text=blocks_text,
        )
        import time

        resp = None
        for attempt in (1, 2):  # 远端偶发断连（长输出时尤甚），重试一次
            try:
                resp = client.chat.completions.create(
                    model=model, messages=[{"role": "user", "content": prompt}],
                    max_tokens=8192,
                )
                break
            except Exception:  # noqa: BLE001 - 连接类错误重试，解析错误不重试
                if attempt == 2:
                    raise
                time.sleep(3)
        record_llm_call(conn, doc_id, "structure", model, extract_usage(resp),
                        recorder=recorder, stage="structure",
                        prompt=prompt, output=resp.choices[0].message.content)
        entries = _parse_json_array(resp.choices[0].message.content)
        n = 0
        for entry in entries:
            item_id = str(uuid.uuid4())
            cur.execute(
                """INSERT INTO items (id, document_id, content_type, label, content_md,
                                      chapter, taxonomy, tags, page_start, page_end, source_model)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (item_id, doc_id, entry["content_type"], entry["label"], entry["content_md"],
                 chapter_label, taxonomy, tags or [], page_start, page_end, model),
            )
            for idx in entry.get("block_ids", []):
                if not (1 <= idx <= len(blocks)):
                    continue  # 模型引用了不存在的块号，跳过不炸
                bid, btype, _content = blocks[idx - 1]
                if bid is None:
                    continue  # 整页版伪块：溯源退化为页图，不进 item_blocks
                if entry["content_type"] == "answer":
                    role = "solution"
                elif btype in ("figure", "table"):
                    role = "figure"
                else:
                    role = "stem"
                cur.execute(
                    "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (item_id, bid, role),
                )
            n += 1
    return n


def pair_items(conn, doc_id: str) -> int:
    """按 label 精确配对 answer <-> exercise/example。返回新增配对数。"""
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE items a SET paired_item_id = q.id
               FROM items q
               WHERE a.document_id=%s AND q.document_id=%s
                 AND a.content_type='answer' AND q.content_type <> 'answer'
                 AND a.label = q.label AND a.paired_item_id IS NULL""",
            (doc_id, doc_id),
        )
        n1 = cur.rowcount
        cur.execute(
            """UPDATE items q SET paired_item_id = a.id
               FROM items a
               WHERE a.document_id=%s AND q.document_id=%s
                 AND a.content_type='answer' AND q.content_type <> 'answer'
                 AND a.label = q.label AND q.paired_item_id IS NULL""",
            (doc_id, doc_id),
        )
        return n1  # 配对数按 answer 侧计（双向回写是同一对的两侧）


def run_structure(conn, cfg: Config, doc_id: str, toc_pages: list[int] | None = None,
                  flat: bool = False, exam: bool = False, client=None) -> dict:
    """structure 编排（CLI 同款流程，可直接测试）。
    模式判定：--flat 显式 / --toc-pages 显式 / 自动探测目录页，探测不到回退 flat。"""
    from kb.export_md import export_chapter_mds, export_page_mds
    from kb.flat import build_flat_chapter, resolve_mode
    from kb.grounding import run_grounding
    from kb.qc import check_label_continuity
    from kb.toc import calibrate_pages, extract_toc
    from kb.traj import Recorder

    rec = Recorder(conn, cfg, doc_id)
    rec.start("structure", "结构化拆条开始",
              payload={"flat": flat, "exam": exam, "toc_pages": toc_pages})
    with conn.cursor() as cur:
        cur.execute("SELECT doc_type FROM documents WHERE id=%s", (doc_id,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"文档不存在: {doc_id}")
        if flat:
            mode = "flat"
        elif exam or row[0] == "exam":
            mode = "exam"
        else:
            mode = resolve_mode(cur, doc_id, flat=False, toc_pages=toc_pages)
    rec.decision("structure", f"模式判定: {mode}", payload={"mode": mode})
    if mode == "exam":
        from kb.structure_exam import run_exam_structure

        return run_exam_structure(conn, cfg, doc_id, client=client, recorder=rec)
    if mode == "flat":
        if not flat:
            print("未找到目录页，回退整卷按页模式（--toc-pages 可显式指定目录页）")
        build_flat_chapter(conn, doc_id)
        print(f"整卷按页模式: 合成 1 章（不拆条,页级通过后按页向量化）; "
              f"落盘 {export_page_mds(conn, cfg, doc_id)} 页 md, "
              f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
        rec.end("structure", "整卷按页模式完成")
        return {"mode": "flat", "chapters": 1, "items": 0}

    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """SELECT d.struct_mode, count(ch.id),
                      NOT EXISTS (SELECT 1 FROM items WHERE document_id=d.id),
                      NOT EXISTS (SELECT 1 FROM chunks WHERE document_id=d.id)
               FROM documents d LEFT JOIN chapters ch ON ch.document_id=d.id
               WHERE d.id=%s GROUP BY d.id, d.struct_mode""",
            (doc_id,),
        )
        row = cur.fetchone()
        if row and row[0] == "flat":
            if row[1]:
                if row[1] != 1 or not row[2] or not row[3]:
                    raise SystemExit(
                        "文档已有生成的 flat 内容，无法自动切换为目录模式；"
                        "请先清理该文档或重新入库"
                    )
                cur.execute(
                    "DELETE FROM chapters WHERE document_id=%s AND chapter_no=1",
                    (doc_id,),
                )

    n_toc = extract_toc(conn, cfg, doc_id, client=client, toc_pages=toc_pages,
                        recorder=rec)
    n_cal = calibrate_pages(conn, doc_id)
    print(f"目录: {n_toc} 章入库, {n_cal} 章完成页码校准")
    rec.decision("structure", f"目录: {n_toc} 章入库, {n_cal} 章完成页码校准")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chapter_no FROM chapters WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        chapters = [r[0] for r in cur.fetchall()]
    total = 0
    for no in chapters:
        try:
            total += structure_chapter(conn, cfg, doc_id, no, client=client,
                                       recorder=rec)
        except SystemExit as e:
            rec.error("structure", f"第 {no} 章跳过: {e}")
            print(f"第 {no} 章跳过: {e}")
    print(f"条目: {total} 条入库; 配对 {pair_items(conn, doc_id)} 处; "
          f"题号质检新增 {check_label_continuity(conn, doc_id)} 条; "
          f"接地检查新增 {run_grounding(conn, doc_id)} 条")
    rec.decision("structure", f"条目: {total} 条入库")
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    print(f"落盘: {export_page_mds(conn, cfg, doc_id)} 页 md, "
          f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
    rec.end("structure", f"拆条完成，{len(chapters)} 章 {total} 条")
    return {"mode": "toc", "chapters": len(chapters), "items": total}

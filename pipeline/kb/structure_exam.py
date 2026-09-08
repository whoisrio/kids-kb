"""试卷（--type exam）结构化：整卷转录文本 -> LLM 按题拆分 -> items + 答案配对。"""
from __future__ import annotations

import re
import time
import uuid

from openai import OpenAI

from kb.config import Config
from kb.metering import extract_usage, record_llm_call
from kb.toc import _parse_json_array

_SECTION_RE = re.compile(r"^(?:#{1,6}\s*)?第?[一二三四五六七八九十]+[、.．]\s*\S", re.M)

EXAM_PROMPT = (
    "下面是一份试卷「{section}」的全部内容（已按阅读顺序排列，页码以【页N】标记）。\n"
    "请把其中的题目逐题提取，输出 JSON 数组，每项：\n"
    "- label: 题号（字符串，优先数字，如 \"1\"、\"2\"）\n"
    "- stem_md: 题干完整内容（含选项；数学内容用 LaTeX $...$）\n"
    "- answer_md: 该题答案/解析（仅当内容里有答案区时给出，否则 null）\n"
    "- page_start / page_end: 该题所在页码（整数；无页标记则 null）\n"
    "规则：跨页/跨段的同一题合并成一题；答案区的答案按题号对应到题目；\n"
    "文字必须忠于原文：只能拼接整理、修正明显 OCR 错字；严禁改写、概括、补充。\n"
    "只输出 JSON。\n\n"
    "{exam_text}"
)


def split_sections(text: str) -> list[tuple[str, str]]:
    """按大题标题（一、二、…）切 section，卷首并入第一个；无匹配则整卷一个。"""
    matches = list(_SECTION_RE.finditer(text))
    if not matches:
        body = text.strip()
        return [("全卷", body)] if body else []
    sections = []
    for i, match in enumerate(matches):
        begin = 0 if i == 0 else match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        line_end = text.find("\n", match.start())
        stop = line_end if line_end != -1 else len(text)
        title = text[match.start():stop]
        sections.append((title.strip().lstrip("#").strip(), text[begin:end].strip()))
    return sections


def exam_sections(conn, doc_id: str) -> list[dict]:
    """试卷的大题单元。PDF：拼各页采用稿后按大题标题切；docx/md 用现有章节。"""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pages WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            from kb.flat import page_contents

            contents = page_contents(cur, doc_id)
            text = "\n\n".join(f"【页{no}】\n{content}" for no, content in contents)
            return [
                {"chapter_no": i, "title": title, "text": body, "write_chapter": True}
                for i, (title, body) in enumerate(split_sections(text), start=1)
            ]
        cur.execute(
            "SELECT chapter_no, title, content_md FROM chapters"
            " WHERE document_id=%s ORDER BY chapter_no",
            (doc_id,),
        )
        return [
            {"chapter_no": no, "title": title, "text": content or "",
             "write_chapter": False}
            for no, title, content in cur.fetchall()
        ]


def _as_page(value) -> int | None:
    return int(value) if isinstance(value, (int, float)) else None


def extract_section(conn, cfg: Config, doc_id: str, section: dict, model: str,
                    client, recorder=None) -> int:
    """一个大题 section 的 LLM 拆题。断连/JSON 解析失败重试一次。"""
    chapter_label = section["title"]
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM items WHERE document_id=%s AND chapter=%s LIMIT 1",
            (doc_id, chapter_label),
        )
        if cur.fetchone():
            return 0
        if section["write_chapter"]:
            cur.execute(
                """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
                   VALUES (%s,%s,%s,%s,%s)
                   ON CONFLICT (document_id, chapter_no) DO UPDATE
                   SET title=EXCLUDED.title, content_md=EXCLUDED.content_md""",
                (str(uuid.uuid4()), doc_id, section["chapter_no"],
                 chapter_label, section["text"]),
            )
    prompt = EXAM_PROMPT.format(section=chapter_label, exam_text=section["text"])
    response = None
    entries = []
    for attempt in (1, 2):
        try:
            response = client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": prompt}],
                max_tokens=8192,
            )
            entries = _parse_json_array(response.choices[0].message.content)
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(3)
    record_llm_call(conn, doc_id, "structure_exam", model, extract_usage(response),
                    recorder=recorder, stage="structure", prompt=prompt,
                    output=response.choices[0].message.content)
    count = 0
    pages: list[int] = []
    with conn.cursor() as cur:
        for entry in entries:
            label = str(entry.get("label") or "").strip()
            stem = (entry.get("stem_md") or "").strip()
            if not label or not stem:
                continue
            page_start = _as_page(entry.get("page_start"))
            page_end = _as_page(entry.get("page_end")) or page_start
            if not section["write_chapter"]:
                page_start = page_end = None
            if page_start is not None:
                pages.extend([page_start, page_end])
            for content_type, content in (
                ("exercise", stem),
                ("answer", entry.get("answer_md")),
            ):
                if not isinstance(content, str) or not content.strip():
                    continue
                cur.execute(
                    """INSERT INTO items (id, document_id, content_type, label, content_md,
                                          chapter, tags, page_start, page_end, source_model)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), doc_id, content_type, label, content.strip(),
                     chapter_label, [], page_start, page_end, model),
                )
                count += 1
        if section["write_chapter"] and pages:
            cur.execute(
                "UPDATE chapters SET page_start=%s, page_end=%s"
                " WHERE document_id=%s AND chapter_no=%s",
                (min(pages), max(pages), doc_id, section["chapter_no"]),
            )
    return count


def run_exam_structure(conn, cfg: Config, doc_id: str, client=None, recorder=None) -> dict:
    """试卷拆题编排：大题 section 逐个 LLM 提取，失败记日志继续；整卷 0 题判失败。"""
    from kb.export_md import export_chapter_mds, export_page_mds
    from kb.structure import pair_items
    from kb.traj import Recorder

    recorder = recorder or Recorder(conn, cfg, doc_id)
    base_url, api_key, model = cfg.doc_ognize_endpoint()
    client = client or OpenAI(base_url=base_url, api_key=api_key)
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM items WHERE document_id=%s LIMIT 1", (doc_id,))
        if cur.fetchone():
            recorder.decision("structure", "试卷已有条目，跳过（幂等）")
            return {"mode": "exam", "sections": 0, "items": 0}
    sections = [section for section in exam_sections(conn, doc_id)
                if section["text"].strip()]
    if not sections:
        raise SystemExit("试卷没有可用转录文本，请先完成解析/入库")
    recorder.decision(
        "structure", f"试卷拆题: {len(sections)} 个大题单元",
        payload={"sections": [section["title"] for section in sections]},
    )
    total, failed = 0, []
    for section in sections:
        try:
            total += extract_section(conn, cfg, doc_id, section, model, client,
                                     recorder=recorder)
        except Exception as exc:
            failed.append(section["title"])
            recorder.error("structure", f"大题「{section['title']}」拆题失败: {exc}",
                           exc=exc)
            print(f"大题「{section['title']}」拆题失败: {exc}")
    if total == 0:
        recorder.end("structure", "试卷拆题失败：0 题", status="error")
        raise SystemExit("试卷拆题结果为 0 题，请检查转录质量或换更强的 DOC_OGNIZE 模型")
    paired = pair_items(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE documents SET struct_mode='toc' WHERE id=%s", (doc_id,))
    print(f"条目: {total} 条入库; 答案配对 {paired} 处"
          + (f"; 失败大题: {'、'.join(failed)}" if failed else ""))
    print(f"落盘: {export_page_mds(conn, cfg, doc_id)} 页 md, "
          f"{export_chapter_mds(conn, cfg, doc_id)} 章 md")
    recorder.end("structure", f"试卷拆题完成，{len(sections)} 个大题 {total} 条")
    return {"mode": "exam", "sections": len(sections), "items": total}

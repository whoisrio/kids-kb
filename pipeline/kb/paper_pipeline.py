"""试卷管线:页图渲染 -> 每页单次 VLM 拆题+对错识别 -> 裁题图 -> 全量替换落库。

设计:docs/superpowers/specs/2026-09-03-paper-pipeline-design.md
papers.status 由 TS 编排层管理;本模块只写 source_path/page_count/paper_questions 与文件。
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import pymupdf as fitz

from kb.core.config import Config
from kb.ocr.pad import pad_mm_for
from kb.telemetry.metering import extract_usage, record_llm_call

PAPER_VLM_PROMPT = """你是试卷解析助手。把这一页试卷拆成一道道独立的题,并识别批改痕迹。
只输出纯 JSON(不要 markdown 围栏),结构:
{"questions": [
  {"seq_in_page": 1,
   "bbox": [x1, y1, x2, y2],
   "content_md": "题干全文,算式用自然文本(如 135 ÷ 5 =、246 × 37),不要 LaTeX 记号",
   "answer_excerpt": "学生作答内容摘录(没有则空字符串)",
   "result": "correct|wrong|partial|null",
   "mark_desc": "批改痕迹描述,如「老师红笔 ✗」(没有则空字符串)"}
]}
规则:
- bbox 用 0-1000 归一化坐标,框住这道题的完整区域(题干+作答)。
- result 判定:明确 ✓ 或对勾 -> correct;✗、叉、红圈、扣分 -> wrong;半对(如 ✓ 但有扣分、半勾)-> partial;没有批改痕迹或拿不准 -> null。
- 忽略页眉、页脚、姓名栏、分数栏、页码;题目按从上到下的阅读顺序编号。
- 页面上没有题目时输出 {"questions": []}。"""

_RESULTS = {"correct", "wrong", "partial"}
_MAX_TOKENS = 8192


def _strip_fences(text: str) -> str:
    """剥 markdown 围栏,并截取最外层大括号(VLM 可能夹带前后说明文字)。"""
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", t).strip()
    m = re.search(r"\{.*\}", t, re.DOTALL)
    return m.group(0) if m else t


def _normalize_content_md(raw: str) -> str:
    """LaTeX 记号 -> 自然文本,与题库 content_md 对齐(自动匹配按表面文本做 embedding)。

    VLM 即使被要求自然文本也可能给 "$135 \\div 5$" 这类 LaTeX;而题库里是 "135 ÷ 5 =",
    bge-m3 对两者余弦会跌破匹配阈值(实测 0.75 vs 0.97)。这里幂等地把 LaTeX 还原。
    """
    t = raw.strip()
    # \frac{a}{b} -> (a)/(b)(先于运算符替换,内部可能含 \times 等)
    t = re.sub(r"\\frac\{([^{}]*)\}\{([^{}]*)\}", r"(\1)/(\2)", t)
    # \sqrt{x} -> √x
    t = re.sub(r"\\sqrt\{([^{}]*)\}", r"√\1", t)
    # 常见运算符命令 -> Unicode
    for pat, rep in (
        (r"\div", "÷"), (r"\times", "×"), (r"\cdot", "×"),
        (r"\pm", "±"), (r"\approx", "≈"), (r"\le", "≤"),
        (r"\ge", "≥"), (r"\neq", "≠"),
    ):
        t = t.replace(pat, rep)
    # 剥行内公式边界 $ \( \)
    t = t.replace("$", "").replace(r"\(", "").replace(r"\)", "")
    # 残留 LaTeX 命令与转义空白(如 \left \right \, \;)剥掉
    t = re.sub(r"\\[a-zA-Z]+", "", t)
    t = t.replace(r"\,", " ").replace(r"\;", " ").replace("\\ ", " ")
    # 行首序号:1. 1、 (1) [1] 1) 剥掉(题库 content_md 无序号)
    t = re.sub(r"^\s*(?:\(\d+\)|\[\d+\]|\d+[.)、])\s*", "", t)
    return re.sub(r"\s+", " ", t).strip()


def _norm_bbox(raw) -> list[int] | None:
    if not (isinstance(raw, list) and len(raw) == 4):
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in raw)
    except (TypeError, ValueError):
        return None
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    clamp = lambda v: max(0, min(1000, v))  # noqa: E731
    x1, y1, x2, y2 = (clamp(v) for v in (x1, y1, x2, y2))
    if x2 - x1 < 5 or y2 - y1 < 5:  # 面积过小视为非法,题图兜底整页
        return None
    return [round(v) for v in (x1, y1, x2, y2)]


def parse_page_questions(text: str) -> list[dict]:
    """VLM 原始输出 -> 规范化题目列表;非法结构抛 ValueError。"""
    try:
        data = json.loads(_strip_fences(text))
    except json.JSONDecodeError as e:
        raise ValueError(f"不是合法 JSON: {e}") from e
    questions = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(questions, list):
        raise ValueError("缺少 questions 数组")
    out = []
    for i, q in enumerate(questions, start=1):
        if not isinstance(q, dict):
            raise ValueError(f"第 {i} 项不是对象")
        content = _normalize_content_md(q.get("content_md") or "")
        if not content:
            raise ValueError(f"第 {i} 项缺少 content_md")
        result = q.get("result")
        if result not in _RESULTS:
            result = None
        out.append({
            "seq_in_page": i,  # 按数组顺序重编,不信模型的编号
            "bbox": _norm_bbox(q.get("bbox")),
            "content_md": content,
            "answer_excerpt": (q.get("answer_excerpt") or "").strip() or None,
            "recognized_result": result,
            "mark_desc": (q.get("mark_desc") or "").strip() or None,
        })
    return out


def _vlm_call(client, model: str, image_path: str, feedback: str | None):
    """单次 VLM 调用;feedback 非空时为重试(带错误反馈)。"""
    prompt = PAPER_VLM_PROMPT
    if feedback:
        prompt += f"\n\n你上次的输出有问题:{feedback}\n请严格修正后重新输出,仍然只输出纯 JSON。"
    b64 = base64.b64encode(Path(image_path).read_bytes()).decode("ascii")
    resp = client.chat.completions.create(
        model=model,
        messages=[{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ],
        }],
        max_tokens=_MAX_TOKENS,
    )
    return resp.choices[0].message.content, extract_usage(resp)


def _recognize_page(conn, cfg: Config, paper_id: str, page_no: int,
                    image_path: str, client=None) -> list[dict]:
    """一页 VLM 识别:失败重试一次(带反馈),再失败抛 RuntimeError。每次调用都计量。"""
    if client is None:
        from openai import OpenAI
        client = OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    feedback: str | None = None
    for _ in range(2):
        text, usage = _vlm_call(client, cfg.vision_model, image_path, feedback)
        record_llm_call(conn, None, "paper_vlm", cfg.vision_model, usage,
                        paper_id=paper_id, modality="image")
        try:
            return parse_page_questions(text)
        except ValueError as e:
            feedback = str(e)
    raise RuntimeError(f"第 {page_no} 页 VLM 输出两次解析失败: {feedback}")


def _crop_question(page: fitz.Page, dpi: int, bbox: list[int], out_path: Path) -> None:
    """按 0-1000 归一化 bbox 裁题图，text 档 padding（spec §5.2）+ clamp 页内（§5.3）。

    用 page.get_pixmap(clip=) 而非 Pixmap(pix, IRect) 二次裁切:后者在 PyMuPDF
    1.28.x 存在 Pixmap 双参构造的兼容问题,前者坐标语义(页面 pt)更干净。
    """
    w, h = page.rect.width, page.rect.height
    pad_h_mm, pad_v_mm = pad_mm_for("text")
    ux = pad_h_mm / (w * 25.4 / 72) * 1000
    uy = pad_v_mm / (h * 25.4 / 72) * 1000
    x1, y1, x2, y2 = bbox
    rect = fitz.Rect(w * (x1 - ux) / 1000, h * (y1 - uy) / 1000,
                     w * (x2 + ux) / 1000, h * (y2 + uy) / 1000) & page.rect
    page.get_pixmap(dpi=dpi, clip=rect).save(str(out_path))


def _insert_questions(conn, paper_id: str, questions: list[dict]) -> None:
    from psycopg.types.json import Jsonb
    with conn.cursor() as cur:
        for q in questions:
            cur.execute(
                """INSERT INTO paper_questions
                   (paper_id, page_no, seq_in_page, content_md, answer_excerpt, mark_desc,
                    recognized_result, bbox, image_path)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (paper_id, q["page_no"], q["seq_in_page"], q["content_md"],
                 q["answer_excerpt"], q["mark_desc"], q["recognized_result"],
                 Jsonb(q["bbox"]) if q["bbox"] else None, q["image_path"]),
            )


def ingest_paper(conn, cfg: Config, paper_id: str, pdf_bytes: bytes | None = None,
                 client=None) -> dict:
    """全卷加工(幂等):存 source.pdf -> 渲染页图 -> 每页 VLM -> 裁题图 -> 全量替换。

    pdf_bytes 缺省 = 重驱动,复用已存的 source.pdf。原子性:DELETE+INSERT 包在一个事务里。
    """
    root = cfg.storage_dir / "papers" / paper_id
    pages_dir, questions_dir = root / "pages", root / "questions"
    source = root / "source.pdf"
    if pdf_bytes is not None:
        # 先验证再落盘:坏 PDF 不留残留文件(否则 retry 复用坏文件永远同错,只能重传)
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as e:
            raise ValueError(f"PDF 无法解析(文件损坏或加密): {e}") from e
        root.mkdir(parents=True, exist_ok=True)
        source.write_bytes(pdf_bytes)
    elif source.exists():
        doc = fitz.open(str(source))
    else:
        raise FileNotFoundError("source.pdf 不存在(重驱动须先上传)")
    pages_dir.mkdir(parents=True, exist_ok=True)
    questions_dir.mkdir(parents=True, exist_ok=True)

    recognized: list[dict] = []
    for i, page in enumerate(doc, start=1):
        img_rel = pages_dir / f"p{i:04d}.png"
        if not img_rel.exists():
            page.get_pixmap(dpi=cfg.dpi).save(str(img_rel))
        questions = _recognize_page(conn, cfg, paper_id, i, str(img_rel), client=client)
        for q in questions:
            if q["bbox"]:
                rel = questions_dir / f"p{i:04d}_q{q['seq_in_page']:02d}.png"
                _crop_question(page, cfg.dpi, q["bbox"], rel)
                q["image_path"] = rel.relative_to(cfg.storage_dir).as_posix()
            else:
                q["image_path"] = None
            q["page_no"] = i
            recognized.append(q)

    with conn.transaction():  # autocommit 连接上的显式事务:全量替换原子生效
        with conn.cursor() as cur:
            cur.execute("DELETE FROM paper_questions WHERE paper_id=%s", (paper_id,))
        _insert_questions(conn, paper_id, recognized)
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE papers SET source_path=%s, page_count=%s WHERE id=%s",
                (str(source.resolve()), doc.page_count, paper_id),
            )
    return {"pages": doc.page_count, "questions": len(recognized)}


def recognize_page(conn, cfg: Config, paper_id: str, page_no: int, client=None) -> dict:
    """页级重识别(幂等):删该页题目 -> 复用/渲染该页图 -> 单页 VLM -> 重插。"""
    with conn.cursor() as cur:
        source_path = cur.execute(
            "SELECT source_path FROM papers WHERE id=%s", (paper_id,)
        ).fetchone()
    if not source_path or not source_path[0]:
        raise FileNotFoundError("试卷还没有 source.pdf")
    doc = fitz.open(source_path[0])
    if not (1 <= page_no <= doc.page_count):
        raise ValueError(f"page_no 越界: {page_no} / {doc.page_count}")

    root = cfg.storage_dir / "papers" / paper_id
    pages_dir, questions_dir = root / "pages", root / "questions"
    pages_dir.mkdir(parents=True, exist_ok=True)
    questions_dir.mkdir(parents=True, exist_ok=True)
    img_rel = pages_dir / f"p{page_no:04d}.png"
    # 重识别 bbox 可能变,页图本身不重渲染(DPI 不变),但旧题图作废重裁
    if not img_rel.exists():
        doc[page_no - 1].get_pixmap(dpi=cfg.dpi).save(str(img_rel))
    questions = _recognize_page(conn, cfg, paper_id, page_no, str(img_rel), client=client)
    page = doc[page_no - 1]
    for q in questions:
        if q["bbox"]:
            rel = questions_dir / f"p{page_no:04d}_q{q['seq_in_page']:02d}.png"
            _crop_question(page, cfg.dpi, q["bbox"], rel)
            q["image_path"] = rel.relative_to(cfg.storage_dir).as_posix()
        else:
            q["image_path"] = None
        q["page_no"] = page_no

    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM paper_questions WHERE paper_id=%s AND page_no=%s",
                (paper_id, page_no),
            )
        _insert_questions(conn, paper_id, questions)
    return {"pages": 1, "questions": len(questions)}

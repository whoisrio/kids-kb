"""试卷管线:页图渲染 -> 每页单次 VLM 拆题+对错识别 -> 裁题图 -> 全量替换落库。

设计:docs/superpowers/specs/2026-09-03-paper-pipeline-design.md
papers.status 由 TS 编排层管理;本模块只写 source_path/page_count/paper_questions 与文件。
"""
from __future__ import annotations

import json
import re

PAPER_VLM_PROMPT = """你是试卷解析助手。把这一页试卷拆成一道道独立的题,并识别批改痕迹。
只输出纯 JSON(不要 markdown 围栏),结构:
{"questions": [
  {"seq_in_page": 1,
   "bbox": [x1, y1, x2, y2],
   "content_md": "题干全文,数学公式用 LaTeX",
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
        content = (q.get("content_md") or "").strip()
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

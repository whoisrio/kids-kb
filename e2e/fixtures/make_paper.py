"""生成 E2E 合成试卷:3 张 PNG(每张一题),第 1 题红 ✗、第 2 题红 ✓、第 3 题无痕迹。

用法(在 e2e/ 目录): uv run --project ../pipeline python fixtures/make_paper.py <out_dir>
依赖 pipeline 的 pymupdf(内置 CJK 字体 china-s)。
"""
import sys
from pathlib import Path

import pymupdf as fitz

QUESTIONS = [
    ("1. 246 × 37 =", "wrong"),    # 红 ✗
    ("2. 135 ÷ 5 =", "correct"),   # 红 ✓
    ("3. 507 − 348 =", None),      # 无痕迹
]


def make(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    for i, (text, mark) in enumerate(QUESTIONS):
        page = doc.new_page(width=595, height=420)
        # 标题(中文用 china-s;数字紧凑:用 fontsize 14 同行短写,缩短视觉空隙)
        page.insert_text((60, 60), "三年级数学期中练习", fontname="china-s", fontsize=14)
        page.insert_text((60, 150), text, fontname="china-s", fontsize=18)
        # 作答 y 错开到 220,避免与题干重叠;蓝字
        page.insert_text((60, 220), "作答：" + ("9102" if i == 0 else "27" if i == 1 else "159"),
                         fontname="china-s", fontsize=18, color=(0, 0, 0.6))
        if mark == "wrong":  # 红 ✗(两条交叉线)
            page.draw_line(fitz.Point(440, 130), fitz.Point(480, 170), color=(0.9, 0, 0), width=3)
            page.draw_line(fitz.Point(480, 130), fitz.Point(440, 170), color=(0.9, 0, 0), width=3)
        if mark == "correct":  # 红 ✓
            page.draw_line(fitz.Point(440, 145), fitz.Point(458, 170), color=(0.9, 0, 0), width=3)
            page.draw_line(fitz.Point(458, 170), fitz.Point(485, 130), color=(0.9, 0, 0), width=3)
        pix = page.get_pixmap(dpi=150)
        pix.save(str(out_dir / f"paper{i + 1}.png"))
    doc.close()


if __name__ == "__main__":
    make(Path(sys.argv[1]))

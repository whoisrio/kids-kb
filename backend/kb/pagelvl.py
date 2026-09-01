"""页级整页 VLM 转录：块级解析问题较多时的第二解析产物。

page_md 不回切块；与块级解析并存，人工复核时选择 adopted_source（blocks|page_md），
structure 按采用版本混排章节输入。手动（复核页按钮）与自动（实质问题 ≥2）两个入口。
"""
from __future__ import annotations

from openai import OpenAI

from kb.config import Config
from kb.metering import record_llm_call
from kb.parse import transcribe_image

PAGE_VLM_PROMPT = (
    "请完整转录这一整页的内容，保持原有阅读顺序（从上到下、从左到右）。\n"
    "输出干净的 markdown：标题/正文/题目直接写，数学公式、竖式、算式一律用 LaTeX"
    "（行内 $...$，独立公式 $$...$$），只用 KaTeX 支持的命令（横线用 \\hline，禁止 \\cline）。\n"
    "页眉、页脚、页码、装饰图标、二维码直接忽略，不要描述它们。"
)

_AUTO_THRESHOLD = 2  # 实质问题（非页眉页脚 empty）达到此数自动整页转录


def transcribe_page(conn, cfg: Config, page_id: str, client=None) -> str:
    """整页图发远端 VLM，page_md/page_md_model 落库。手动重发覆盖旧值。返回 page_md。"""
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT image_path, document_id FROM pages WHERE id=%s", (page_id,))
        image_path, doc_id = cur.fetchone()
    text, usage = transcribe_image(client, cfg.vision_model, image_path,
                                   prompt=PAGE_VLM_PROMPT)
    record_llm_call(conn, str(doc_id), "page_vlm", cfg.vision_model, usage)
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE pages SET page_md=%s, page_md_model=%s WHERE id=%s",
            (text, cfg.vision_model, page_id),
        )
    return text


def auto_page_vlm(conn, cfg: Config, doc_id: str, client=None) -> int:
    """实质问题（非页眉页脚 empty）pending ≥2 且无 page_md 的页自动整页转录。返回触发页数。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.id FROM pages p
               WHERE p.document_id=%s AND p.status IN ('parsed','failed')
                 AND p.page_md IS NULL
                 AND (SELECT count(*) FROM review_queue r
                      LEFT JOIN blocks b ON b.id = r.block_id
                      WHERE r.status='pending'
                        AND (r.page_id = p.id OR b.page_id = p.id)
                        AND NOT (r.reason='empty'
                                 AND b.block_type IN ('header','footer'))) >= %s""",
            (doc_id, _AUTO_THRESHOLD),
        )
        page_ids = [str(r[0]) for r in cur.fetchall()]
    for pid in page_ids:
        transcribe_page(conn, cfg, pid, client=client)
    return len(page_ids)

"""阶段③解析：视觉模型（OpenAI 兼容端点，本地/远端由配置决定）转录区块图像。"""
from __future__ import annotations

import base64
from pathlib import Path

from openai import OpenAI

from kb.config import Config

TRANSCRIBE_PROMPT = (
    "请完整转录这张页面上的所有文字内容，保持原有阅读顺序"
    "（从上到下、从左到右）。\n"
    "不要丢失也不要编造页面上没有的内容；"
    "如果页面含多个栏块，请按顺序逐块列出。\n"
    "特别注意：如果内容包含数学公式、表达式、算式、符号等，"
    "必须一律使用 LaTeX 表达--行内公式用 $...$，独立公式块用 $$...$$，"
    "确保公式可被标准 LaTeX 渲染器正确还原。"
)


def transcribe_image(client, model: str, image_path, prompt: str = TRANSCRIBE_PROMPT) -> str:
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
        max_tokens=4096,
    )
    return resp.choices[0].message.content


def run_parse(conn, cfg: Config, doc_id: str, client=None) -> int:
    """转录所有未解析的 block；单页失败只记 parse_error，不中断。返回成功解析的 block 数。"""
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.crop_path, b.page_id FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND b.content_md IS NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for block_id, crop_path, page_id in rows:
            try:
                text = transcribe_image(client, cfg.vision_model, crop_path)
            except Exception as e:  # noqa: BLE001 - 单页失败不中断
                cur.execute(
                    "UPDATE pages SET status='failed', parse_error=%s WHERE id=%s",
                    (str(e)[:500], page_id),
                )
                continue
            cur.execute("UPDATE blocks SET content_md=%s WHERE id=%s", (text, block_id))
            cur.execute("UPDATE pages SET status='parsed', parse_error=NULL WHERE id=%s", (page_id,))
            n += 1
        # 自愈历史漂移：块内容齐全的页必为 parsed（与逐块更新同一不变量）
        cur.execute(
            """UPDATE pages SET status='parsed', parse_error=NULL
               WHERE document_id=%s AND status IN ('rendered', 'failed')
               AND NOT EXISTS (
                   SELECT 1 FROM blocks b WHERE b.page_id = pages.id AND b.content_md IS NULL
               )""",
            (doc_id,),
        )
    return n

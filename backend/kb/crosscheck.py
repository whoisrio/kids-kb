"""质检 L3：双模型比对。

全部 formula/figure/table 块必查；text 块按 block_id 哈希稳定抽 5%。
用第二渠道（KB_VISION_COMPARE_MODEL，未配置则整体跳过）重转录，
与首次结果 CER>0.2 建 llm_disagree 复核行。
llm_disagree 属人工裁决类，不进 CHECKABLE_REASONS，不会随内容编辑自动关闭。
"""
from __future__ import annotations

import uuid

from openai import OpenAI

from kb.config import Config
from kb.golden import char_error_rate
from kb.parse import transcribe_image

_ALWAYS_TYPES = {"formula", "figure", "table"}
_SAMPLE_MOD = 20  # text 块抽 1/20 = 5%
_CER_THRESHOLD = 0.2


def _sampled(block_id: str, block_type: str) -> bool:
    if block_type in _ALWAYS_TYPES:
        return True
    return uuid.UUID(block_id).int % _SAMPLE_MOD == 0


def run_llm_crosscheck(conn, cfg: Config, doc_id: str, compare_client=None,
                       threshold: float = _CER_THRESHOLD) -> int:
    """返回新增 llm_disagree 复核行数。"""
    if not cfg.vision_compare_model:
        return 0
    client = compare_client or OpenAI(base_url=cfg.vision_base_url,
                                      api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.crop_path, b.content_md, b.block_type FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND p.status='parsed' AND b.content_md IS NOT NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        n = 0
        for block_id, crop_path, content, block_type in cur.fetchall():
            if not _sampled(str(block_id), block_type):
                continue
            cur.execute(
                "SELECT 1 FROM review_queue WHERE block_id=%s AND reason='llm_disagree'",
                (block_id,),
            )
            if cur.fetchone():
                continue  # 幂等：已有记录不重复比对
            second = transcribe_image(client, cfg.vision_compare_model, crop_path)
            if char_error_rate(content, second) <= threshold:
                continue
            cur.execute(
                "INSERT INTO review_queue (id, block_id, reason) VALUES (%s,%s,'llm_disagree')",
                (str(uuid.uuid4()), block_id),
            )
            n += 1
    return n

"""标题层级判定（ingest heading 阶段）：给标题块判 1/2/3 级写入 blocks.title_level。

候选（被排除的页 excluded_from_index 一律不入选）：
- block_type='title' 且有转录内容的块；
- block_type='text' 但内容带章节编号线索（第N讲/章/节/课/单元）的块——兜住版面
  模型把章节横幅判成 text 的情况。

按 (page_no, ordinal) 阅读顺序分批送本地小模型；批间带上一批末尾 10 条已判定的
（文本+层级）作锚点，保证全书层级口径一致。
幂等：title_level 非 NULL 的块天然跳过，重跑只补未判定的；模型输出解析失败重试
一次，仍失败则该批留 NULL（下轮断点续跑），记 trajectory error。
"""
from __future__ import annotations

import re
import time

from openai import OpenAI

from kb.core.config import Config
from kb.rag.toc import _parse_json_array
from kb.telemetry.metering import extract_usage, record_llm_call

BATCH_SIZE = 100
ANCHOR_TAIL = 10

_CHAPTER_NO = re.compile(r"^\s*第\s*[0-9一二三四五六七八九十百]+\s*[讲章节课单元]")

HEADING_PROMPT = (
    "下面是按阅读顺序排列的一本书的标题候选块，格式为「序号 | 页码 | 块高度 | 文本」"
    "（块高度是标题在页面图上的像素高度，越大通常字号越大、层级越高）。\n"
    "请判断每个标题的层级：1=章/讲/单元级（如「第 3 讲」「第二单元」），"
    "2=节级（如「一、认识三角形」），3=小节/知识点级（如「（一）三角形的边」）。\n"
    '只输出 JSON 数组，形如 [{"index":1,"level":2}]，index 对应上面的序号，'
    "不要输出任何其他文字。\n"
)


def _create_completion(client, model: str, messages: list[dict], max_tokens: int):
    """关闭思考型模型 reasoning；端点不认识参数时降级普通调用（同 structure.py）。"""
    try:
        return client.chat.completions.create(
            model=model, messages=messages, max_tokens=max_tokens,
            extra_body={"reasoning_effort": "none"},
        )
    except Exception:  # noqa: BLE001 - 端点拒绝该参数时重试普通调用
        return client.chat.completions.create(
            model=model, messages=messages, max_tokens=max_tokens,
        )


def detect_headings(conn, cfg: Config, doc_id: str, client=None, recorder=None) -> int:
    """判定文档标题块层级。返回新判定的块数。"""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id::text, p.page_no, b.block_type, b.content_md, b.bbox
               FROM blocks b JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND NOT p.excluded_from_index
                 AND b.title_level IS NULL AND b.content_md IS NOT NULL
                 AND b.block_type IN ('title', 'text')
               ORDER BY p.page_no, b.ordinal""",
            (doc_id,),
        )
        candidates = [
            r for r in cur.fetchall()
            if r[2] == "title" or _CHAPTER_NO.match(r[3])
        ]
        if not candidates:
            return 0
        base_url, api_key, model = cfg.heading_endpoint()
        client = client or OpenAI(base_url=base_url, api_key=api_key)
        judged: list[tuple[str, int]] = []  # 已判定的 (文本, 层级)，批间锚点
        updated = 0
        for start in range(0, len(candidates), BATCH_SIZE):
            batch = candidates[start:start + BATCH_SIZE]
            lines = []
            for i, (_bid, page_no, _bt, text, bbox) in enumerate(batch, start=1):
                h = str(int(round(bbox[3] - bbox[1]))) if bbox else "未知"
                lines.append(f"{i} | 第{page_no}页 | 高度{h} | {text.strip()}")
            anchor_sec = ""
            if judged:
                anchor_sec = (
                    "以下是前面已判定的标题（作为层级口径锚点，请保持全书口径一致）：\n"
                    + "\n".join(f"- L{lv} {t}" for t, lv in judged[-ANCHOR_TAIL:])
                    + "\n\n"
                )
            prompt = HEADING_PROMPT + anchor_sec + "\n".join(lines)
            entries = None
            for attempt in (1, 2):  # 解析失败重试一次
                try:
                    resp = _create_completion(
                        client, model, [{"role": "user", "content": prompt}], 2048)
                    out = resp.choices[0].message.content
                    record_llm_call(conn, doc_id, "heading", model, extract_usage(resp),
                                    recorder=recorder, stage="heading",
                                    prompt=prompt, output=out)
                    entries = _parse_json_array(out)
                    break
                except Exception:  # noqa: BLE001 - 留 NULL 断点续跑，不炸整个 ingest
                    if attempt == 2:
                        if recorder is not None:
                            recorder.error(
                                "heading",
                                f"标题层级判定失败（第 {start + 1}~{start + len(batch)} "
                                "块留 NULL，下轮续跑）")
                    else:
                        time.sleep(3)
            if not isinstance(entries, list):
                continue  # 该批留 NULL
            batch_judged: list[tuple[int, str, int]] = []
            for entry in entries:
                if not isinstance(entry, dict):
                    continue  # 坏条目跳过不炸
                idx, level = entry.get("index"), entry.get("level")
                if not isinstance(idx, int) or not 1 <= idx <= len(batch):
                    continue  # 漏判/越界 index 跳过
                if level not in (1, 2, 3):
                    continue  # 非法 level 丢弃该条
                cur.execute(
                    "UPDATE blocks SET title_level=%s WHERE id=%s",
                    (level, batch[idx - 1][0]),
                )
                batch_judged.append((idx, batch[idx - 1][3].strip(), level))
                updated += 1
            judged.extend((t, lv) for _i, t, lv in sorted(batch_judged))
    return updated

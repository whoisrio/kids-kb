"""远端调用计量：llm_calls 流水 + 响应 usage 提取（假客户端无 usage 时容忍 None）。"""
from __future__ import annotations


def extract_usage(resp) -> tuple[int | None, int | None]:
    """OpenAI 兼容响应 -> (prompt_tokens, completion_tokens)；无 usage 返回 (None, None)。"""
    usage = getattr(resp, "usage", None)
    if usage is None:
        return None, None
    return getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None)


def record_llm_call(conn, doc_id: str | None, purpose: str, model: str,
                    usage: tuple[int | None, int | None],
                    paper_id: str | None = None,
                    modality: str | None = None,
                    recorder=None, stage: str | None = None,
                    page_id: str | None = None,
                    duration_ms: int | None = None,
                    prompt: str | None = None,
                    output: str | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO llm_calls (document_id, paper_id, purpose, model, modality,
                                      prompt_tokens, completion_tokens)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (doc_id, paper_id, purpose, model, modality, usage[0], usage[1]),
        )
    if recorder is not None and doc_id is not None:
        recorder.llm_call(stage or purpose, f"{purpose} {model}",
                          page_id=page_id, model=model, usage=usage,
                          duration_ms=duration_ms, prompt=prompt, output=output)

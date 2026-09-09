"""阶段③解析：视觉模型（OpenAI 兼容端点，本地/远端由配置决定）转录区块图像。"""
from __future__ import annotations

import base64
import re
import time
from pathlib import Path

import pymupdf as fitz
from openai import OpenAI

from kb.core.config import Config
from kb.core.paths import resolve_storage_path
from kb.telemetry.metering import record_llm_call

TRANSCRIBE_PROMPT = (
    "请完整转录这张页面上的所有文字内容，保持原有阅读顺序"
    "（从上到下、从左到右）。\n"
    "不要丢失也不要编造页面上没有的内容；"
    "如果页面含多个栏块，请按顺序逐块列出。\n"
    "特别注意：如果内容包含数学公式、表达式、算式、符号等，"
    "必须一律使用 LaTeX 表达--行内公式用 $...$，独立公式块用 $$...$$，"
    "公式必须能被 KaTeX 渲染：只用常见命令，禁止用 \\cline、\\textcircled、\\rule "
    "（横线用 \\hline，圈起来的字符用 \\boxed{}）。"
)


def normalize_latex(content: str) -> str:
    """把模型常用但 KaTeX 不支持的命令归一化为可渲染写法（确定性，不进复核队列）。"""
    out = re.sub(r"\\cline\{[^}]*\}", r"\\hline", content)
    out = re.sub(r"\\textcircled\{([^{}]*)\}", r"\\boxed{\1}", out)
    out = re.sub(r"\\overline\{\\rule\{[^}]*\}\{[^}]*\}\}", r"\\hline", out)
    out = re.sub(r"@\{[^}]*\}", "", out)  # array 列声明装饰符，KaTeX 不支持
    return out


def transcribe_image(client, model: str, image_path, prompt: str = TRANSCRIBE_PROMPT):
    """转录图像 -> (text, (prompt_tokens, completion_tokens))。usage 缺失时为 (None, None)。"""
    from kb.telemetry.metering import extract_usage

    b64 = base64.b64encode(_downscale_for_vision(image_path)).decode("ascii")
    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ],
    }]
    # 思考型模型（qwen3.5 等）reasoning 可烧数千 token：预算不足会把 content
    # 截空（finish_reason=length 且 content 为空串）。默认关思考；个别
    # OpenAI 兼容端点不认 reasoning_effort 时降级为普通调用。
    try:
        resp = client.chat.completions.create(
            model=model, messages=messages,
            # 预算给足，非思考模型用不满，无副作用。
            max_tokens=12288,
            extra_body={"reasoning_effort": "none"},
        )
    except Exception:  # noqa: BLE001 - 服务端拒绝该参数时重试
        resp = client.chat.completions.create(
            model=model, messages=messages, max_tokens=12288,
        )
    return resp.choices[0].message.content, extract_usage(resp)


_MAX_IMAGE_DIM = 2000


def _downscale_for_vision(image_path, max_dim: int = _MAX_IMAGE_DIM) -> bytes:
    """超大图先降采样再送视觉模型：vision token 数随分辨率增长，
    整页扫描图（3000px+）会让思考型模型 reasoning 爆掉输出预算。
    小图（区块裁剪）原样返回；fitz 打不开的（假图/怪格式）也原样返回。"""
    raw = Path(image_path).read_bytes()
    try:
        with fitz.open(stream=raw, filetype="png") as doc:
            rect = doc[0].rect
            scale = min(1.0, max_dim / max(rect.width, rect.height))
            if scale >= 1.0:
                return raw
            pix = doc[0].get_pixmap(matrix=fitz.Matrix(scale, scale))
            return pix.tobytes("png")
    except Exception:  # noqa: BLE001 - 降采样失败不阻断转录
        return raw


# 走本地 rapidocr 的区块类型；其余（formula/figure/table/page）走视觉模型
_OCRABLE_TYPES = {"text", "title", "header", "footer"}

_MATH_MARK_RE = re.compile(r"[□＊*×✕☐]")


def starred_math(content: str) -> bool:
    """多行含竖式符号（□＊*× 等）：竖式被拍扁成星号占位的特征。"""
    if not content:
        return False
    return sum(1 for line in content.splitlines() if _MATH_MARK_RE.search(line)) >= 2

_ocr_engine = None


def _get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def ocr_image(image_path) -> str:
    """rapidocr 识别区块图像，按阅读顺序（y 后 x）拼接文本行。"""
    result, _ = _get_ocr_engine()(str(image_path))
    if not result:
        return ""
    lines = sorted(result, key=lambda r: (round(r[0][0][1] / 10), r[0][0][0]))
    return "\n".join(r[1] for r in lines)


def run_parse(conn, cfg: Config, doc_id: str, client=None, ocr=None,
              recorder=None) -> int:
    """按区块类型分级解析；单块失败不中断。返回成功解析的 block 数。"""
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    ocr = ocr or ocr_image
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.id, b.crop_path, b.page_id, b.block_type FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND b.content_md IS NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for block_id, crop_path, page_id, block_type in rows:
            crop_path = str(resolve_storage_path(cfg, crop_path))
            try:
                if block_type in _OCRABLE_TYPES:
                    text, source, usage = ocr(crop_path), "rapidocr", (None, None)
                    if starred_math(text):  # OCR 把竖式拍成星号 -> 升级视觉模型
                        t0 = time.monotonic()
                        text, usage = transcribe_image(client, cfg.vision_model, crop_path)
                        source = cfg.vision_model
                        record_llm_call(
                            conn, doc_id, "transcribe", cfg.vision_model, usage,
                            recorder=recorder, stage="parse", page_id=str(page_id),
                            duration_ms=int((time.monotonic() - t0) * 1000),
                            prompt=TRANSCRIBE_PROMPT, output=text)
                else:
                    t0 = time.monotonic()
                    text, usage = transcribe_image(client, cfg.vision_model, crop_path)
                    source = cfg.vision_model
                    record_llm_call(
                        conn, doc_id, "transcribe", cfg.vision_model, usage,
                        recorder=recorder, stage="parse", page_id=str(page_id),
                        duration_ms=int((time.monotonic() - t0) * 1000),
                        prompt=TRANSCRIBE_PROMPT, output=text)
            except Exception as e:  # noqa: BLE001 - 单块失败不中断
                if recorder is not None:
                    recorder.error("parse", f"块转录失败: {str(e)[:200]}",
                                   page_id=str(page_id), exc=e)
                cur.execute(
                    "UPDATE pages SET parse_status='failed', parse_error=%s WHERE id=%s",
                    (str(e)[:500], page_id),
                )
                continue
            if not (text or "").strip():
                # 空转录是失败（思考型模型 reasoning 烧穿预算的典型产物），
                # 不能落空串——空串块会被自愈逻辑误标为 parsed。
                cur.execute(
                    "UPDATE pages SET parse_status='failed', parse_error=%s WHERE id=%s",
                    ("转录结果为空", page_id),
                )
                continue
            cur.execute(
                """UPDATE blocks SET content_md=%s, source_model=%s,
                       prompt_tokens=%s, completion_tokens=%s WHERE id=%s""",
                (normalize_latex(text), source, usage[0], usage[1], block_id),
            )
            cur.execute("UPDATE pages SET parse_status='parsed', parse_error=NULL WHERE id=%s", (page_id,))
            n += 1
        # 自愈历史漂移：块内容齐全的页必为 parsed（与逐块更新同一不变量）
        cur.execute(
            """UPDATE pages SET parse_status='parsed', parse_error=NULL
               WHERE document_id=%s AND parse_status IN ('rendered', 'failed')
               AND NOT EXISTS (
                   SELECT 1 FROM blocks b WHERE b.page_id = pages.id AND b.content_md IS NULL
               )""",
            (doc_id,),
        )
    return n

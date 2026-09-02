"""PaddleOCR-VL spike：对一页真实扫描页跑版面+识别，打印区块与耗时。

用法: uv run --extra layout python pipeline/scripts/spike_paddleocr.py [image]
"""
import json
import sys
import time


def main() -> None:
    image = sys.argv[1] if len(sys.argv) > 1 else "page6.png"
    from paddleocr import PaddleOCRVL

    t0 = time.time()
    pipeline = PaddleOCRVL(pipeline_version="v1.5")  # 首次会下载模型（~2GB）
    output = pipeline.predict(image)
    dt = time.time() - t0
    res = output[0]
    data = res.json if hasattr(res, "json") else json.loads(json.dumps(res, default=str))
    blocks = (data.get("res") or data).get("parsing_res_list", [])
    print(f"耗时 {dt:.1f}s，区块数 {len(blocks)}")
    for b in blocks:
        label = b.get("block_label") or b.get("label")
        bbox = b.get("block_bbox") or b.get("bbox")
        content = (b.get("block_content") or b.get("content") or "")[:60].replace("\n", " ")
        print(f"  [{label}] {bbox} {content}")


if __name__ == "__main__":
    main()

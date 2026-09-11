from kb.ocr.golden import char_error_rate, normalize


def test_normalize_strips_whitespace():
    assert normalize("第 1 讲\n\n乘除法") == "第1讲乘除法"


def test_char_error_rate():
    assert char_error_rate("abcd", "abcd") == 0.0
    assert 0.0 < char_error_rate("abcd", "ab") < 1.0


def test_iou():
    from kb.ocr.golden import iou
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert 0.3 < iou((0, 0, 10, 10), (5, 0, 15, 10)) < 0.4  # 交 5x10 / 并 15x10 = 1/3


def test_match_blocks_greedy():
    from kb.ocr.golden import match_blocks
    golden = [
        {"block_type": "title", "bbox": [0, 0, 10, 5]},
        {"block_type": "text", "bbox": [0, 6, 10, 20]},
    ]
    pred = [
        {"block_type": "title", "bbox": [0, 0, 10, 5]},
        {"block_type": "text", "bbox": [0, 7, 10, 20]},    # 稍微偏一点
        {"block_type": "figure", "bbox": [50, 50, 60, 60]},  # 多出的块
    ]
    matched, missing, extra = match_blocks(golden, pred, iou_threshold=0.5)
    assert len(matched) == 2 and len(missing) == 0 and len(extra) == 1

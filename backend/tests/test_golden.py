from kb.golden import char_error_rate, normalize


def test_normalize_strips_whitespace():
    assert normalize("第 1 讲\n\n乘除法") == "第1讲乘除法"


def test_char_error_rate():
    assert char_error_rate("abcd", "abcd") == 0.0
    assert 0.0 < char_error_rate("abcd", "ab") < 1.0

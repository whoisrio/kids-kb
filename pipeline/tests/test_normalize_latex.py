"""normalize_latex：把模型常用但 KaTeX 不支持的命令归一化为可渲染写法。"""
from kb.ocr.parse import normalize_latex


def test_cline_to_hline():
    assert "\\hline" in normalize_latex("$$\\begin{array}{c|c} a & b \\\\ \\cline{2-2} c & d\\end{array}$$")
    assert "\\cline" not in normalize_latex("\\cline{1-3}")


def test_textcircled_to_boxed():
    assert normalize_latex("$\\textcircled{7}$") == "$\\boxed{7}$"


def test_rule_overline_to_hline():
    out = normalize_latex("\\overline{\\rule{6em}{0.4pt}}")
    assert "\\rule" not in out


def test_array_at_decorator_stripped():
    """KaTeX 不支持 array 列声明里的 @{...} 装饰符。"""
    out = normalize_latex("$$\\begin{array}{r@{\\,}c@{\\,}c} a & b\\end{array}$$")
    assert "@{" not in out
    assert "\\begin{array}{rcc}" in out


def test_untouched_when_clean():
    s = "$$\\begin{array}{r} 1+1=2 \\\\ \\hline \\end{array}$$"
    assert normalize_latex(s) == s

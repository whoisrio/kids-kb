"""toc 条目规整：模型输出的 chapter_no/print_page 类型不定，落库前强校验。"""

from kb.rag.toc import normalize_toc_entries


def test_numeric_chapter_no_normalized():
    """数字/数字字符串都能解析；编号统一按出现顺序重排为 1..N
    （chapter_no 本质是序号键，相对顺序与标题承载语义）。"""
    entries = normalize_toc_entries([
        {"chapter_no": 3, "title": "竖式谜", "print_page": 12},
        {"chapter_no": "4", "title": "图形计数", "print_page": "20"},
    ])
    assert [e["chapter_no"] for e in entries] == [1, 2]
    assert [e["title"] for e in entries] == ["竖式谜", "图形计数"]
    assert entries[1]["print_page"] == 20


def test_non_numeric_chapter_no_renumbered():
    """'第一单元' 这类字符串编号：按出现顺序重排为 1..N。"""
    entries = normalize_toc_entries([
        {"chapter_no": "第一单元", "title": "素养达标（A卷）", "print_page": 1},
        {"chapter_no": "第二单元", "title": "能力提优（B卷）", "print_page": 7},
        {"chapter_no": None, "title": "期中测评", "print_page": None},
    ])
    assert [e["chapter_no"] for e in entries] == [1, 2, 3]


def test_missing_title_skipped_and_gap_filling():
    """无 title 的脏条目丢弃，编号连续不跳号。"""
    entries = normalize_toc_entries([
        {"chapter_no": 1, "title": "数与代数", "print_page": 1},
        {"chapter_no": 2, "title": None, "print_page": 5},
        {"chapter_no": "3", "title": "图形几何", "print_page": 9},
    ])
    assert [e["chapter_no"] for e in entries] == [1, 2]
    assert entries[1]["title"] == "图形几何"

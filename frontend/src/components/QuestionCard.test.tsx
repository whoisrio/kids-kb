import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pageImageUrl, questionImageUrl, type PaperQuestion } from "../api/papers";
import { QuestionCard } from "./QuestionCard";

const Q: PaperQuestion = {
  id: "q1", paper_id: "p1", page_no: 1, seq_in_page: 1, seq: 1,
  content_md: "135 ÷ 5 =", answer_excerpt: null, mark_desc: null,
  recognized_result: null, confirmed_result: null, error_cause: null, note: null,
  matched_item_id: null, match_score: null, matched_label: null,
  matched_chapter: null, matched_doc_title: null,
};

describe("QuestionCard 题图", () => {
  it("默认请求裁图;裁图 404 回退整页图;整页也缺才提示缺失", () => {
    render(<QuestionCard question={Q} />);
    const img = screen.getByRole("img", { name: "第 1 题裁图" }) as HTMLImageElement;
    expect(img.src).toContain(questionImageUrl("q1"));

    fireEvent.error(img);  // bbox null → 裁图接口 404
    const page = screen.getByRole("img", { name: "第 1 页原卷" }) as HTMLImageElement;
    expect(page.src).toContain(pageImageUrl("p1", 1));

    fireEvent.error(page);  // 整页也没有(如 storage 被清理)
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/题图缺失/)).toBeTruthy();
  });

  it("题图回退状态不跨题残留(换题后重新从裁图开始)", () => {
    const { rerender } = render(<QuestionCard question={Q} />);
    const img = screen.getByRole("img", { name: "第 1 题裁图" }) as HTMLImageElement;
    fireEvent.error(img);  // 第 1 题裁图失败 → 整页图
    expect(screen.getByRole("img").getAttribute("src")).toContain(pageImageUrl("p1", 1));

    // 切到第 2 题(组件不重挂载但 props 变):应从裁图重新加载
    rerender(<QuestionCard question={{ ...Q, id: "q2", seq: 2 }} />);
    const again = screen.getByRole("img") as HTMLImageElement;
    expect(again.getAttribute("src")).toContain(questionImageUrl("q2"));
  });
});

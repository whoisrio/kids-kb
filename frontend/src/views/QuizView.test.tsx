import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonResponse } from "../test/support";
import { QuizView } from "./QuizView";
import type { QuizDetail, QuizSummary } from "../api/quizzes";

const SUMMARY_PENDING: QuizSummary = {
  id: "q1",
  child_id: "c1",
  title: "薄弱点专项练习",
  tags: ["计算类", "口算"],
  status: "pending",
  created_at: "2026-09-10T00:00:00Z",
  submitted_at: null,
  question_count: 3,
  total_points: 30,
  earned_points: null,
};

const SUMMARY_SUBMITTED: QuizSummary = {
  ...SUMMARY_PENDING,
  status: "submitted",
  submitted_at: "2026-09-10T01:00:00Z",
  earned_points: 15,
};

/** 列表里第二条已完成的练习（独立 id，与 q1 的答题流互不干扰）。 */
const SUMMARY_DONE: QuizSummary = { ...SUMMARY_SUBMITTED, id: "q2" };

const DETAIL_PENDING: QuizDetail = {
  ...SUMMARY_PENDING,
  questions: [
    {
      id: "qu1", seq: 1, type: "single", question: "1+1=?",
      options: [{ value: "A", label: "1" }, { value: "B", label: "2" }],
      points: 10, answer: null, analysis: null,
    },
    {
      id: "qu2", seq: 2, type: "multiple", question: "哪些是偶数？",
      options: [{ value: "A", label: "2" }, { value: "B", label: "3" }, { value: "C", label: "4" }],
      points: 10, answer: null, analysis: null,
    },
    {
      id: "qu3", seq: 3, type: "short_answer", question: "说说你怎么检查计算结果",
      options: null, points: 10, answer: null, analysis: null,
    },
  ],
};

const DETAIL_SUBMITTED: QuizDetail = {
  ...SUMMARY_SUBMITTED,
  questions: [
    { ...DETAIL_PENDING.questions[0], answer: ["B"], analysis: "1+1=2，选 B。" },
    { ...DETAIL_PENDING.questions[1], answer: ["A", "C"], analysis: "2 和 4 是偶数。" },
    { ...DETAIL_PENDING.questions[2], answer: null, analysis: "要点：逐位复核、逆运算验算。" },
  ],
};

const RESULTS = [
  { question_id: "qu1", result: "correct" as const, earned: 10, points: 10, comment: null },
  { question_id: "qu2", result: "wrong" as const, earned: 0, points: 10, comment: null },
  { question_id: "qu3", result: "partial" as const, earned: 5, points: 10, comment: "思路对，漏了逆运算。" },
];

/** 已提交详情由后端带 results（attempts 还原，comment 恒为 null）。 */
const DETAIL_DONE: QuizDetail = {
  ...DETAIL_SUBMITTED,
  id: "q2",
  results: RESULTS.map((r) => ({ ...r, comment: null })),
};

interface Stub {
  calls: { method: string; url: string; body?: unknown }[];
  fetchImpl: typeof fetch;
  /** deferSubmit 时挂起 submit 响应，调 release 后才返回（用于断言「判分中」中间态）。 */
  releaseSubmit: () => void;
}

/** 列表固定两条；q1 初始 pending，POST submit 后详情切到已提交版本。 */
function stubFlow(
  list: QuizSummary[] = [SUMMARY_PENDING, SUMMARY_DONE],
  opts: { deferSubmit?: boolean } = {},
): Stub {
  const calls: Stub["calls"] = [];
  let submitted = false;
  let release: () => void = () => {};
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url === "/api/quizzes?child_id=c1") {
      return jsonResponse({
        quizzes: list.map((q) => (q.id === "q1" && submitted ? { ...q, status: "submitted", earned_points: 15 } : q)),
      });
    }
    if (url === "/api/quizzes/q1" && init?.method !== "POST") {
      return jsonResponse({ quiz: submitted ? DETAIL_SUBMITTED : DETAIL_PENDING });
    }
    if (url === "/api/quizzes/q2" && init?.method !== "POST") {
      return jsonResponse({ quiz: DETAIL_DONE });
    }
    if (url === "/api/quizzes/q1/submit" && init?.method === "POST") {
      submitted = true;
      const payload = jsonResponse({ quiz: SUMMARY_SUBMITTED, results: RESULTS });
      if (!opts.deferSubmit) return payload;
      return new Promise<Response>((resolve) => {
        release = () => resolve(payload);
      });
    }
    return new Response(`no route for ${url}`, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, releaseSubmit: () => release() };
}

/** 从列表点开 q1（第一张卡）并进入答题屏。 */
async function enterAnswering() {
  const cards = await screen.findAllByRole("button", { name: /薄弱点专项练习/ });
  fireEvent.click(cards[0]);
  // cover 屏
  expect(await screen.findByText(/共 3 题/)).toBeInTheDocument();
  expect(screen.getByText(/总分 30 分/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "开始答题" }));
  expect(await screen.findByText("已答 0/3")).toBeInTheDocument();
}

describe("QuizView", () => {
  it("无孩子：空态提示", () => {
    render(<QuizView childId={null} />);
    expect(screen.getByText(/先在复核页上传试卷时添加孩子/)).toBeInTheDocument();
  });

  it("空列表：引导去统计页出题", async () => {
    const { fetchImpl } = stubFlow([]);
    render(<QuizView childId="c1" fetchImpl={fetchImpl} />);
    expect(await screen.findByText("还没有练习，去统计页针对薄弱点出题")).toBeInTheDocument();
  });

  it("列表：标题/tags/题数/状态徽章，已完成显示得分", async () => {
    const { fetchImpl } = stubFlow();
    render(<QuizView childId="c1" fetchImpl={fetchImpl} />);
    const cards = await screen.findAllByRole("button", { name: /薄弱点专项练习/ });
    expect(cards).toHaveLength(2);
    expect(screen.getAllByText("计算类").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/3 题 · 30 分/)).toHaveLength(2);
    expect(screen.getByText("待作答")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText(/得分 15\/30/)).toBeInTheDocument();
  });

  it("答题流：cover → 三种题型作答 → 提交 → 结果页分数/对错/解析/评语", async () => {
    const { calls, fetchImpl, releaseSubmit } = stubFlow(undefined, { deferSubmit: true });
    render(<QuizView childId="c1" fetchImpl={fetchImpl} />);
    await enterAnswering();

    const submitBtn = screen.getByRole("button", { name: "提交答案" });
    expect(submitBtn).toBeDisabled();

    // 单选：radio 式选项按钮
    fireEvent.click(screen.getByRole("button", { name: /B\. 2/ }));
    expect(screen.getByText("已答 1/3")).toBeInTheDocument();
    // 多选：chip 多选
    fireEvent.click(screen.getByRole("button", { name: /A\. 2/ }));
    fireEvent.click(screen.getByRole("button", { name: /C\. 4/ }));
    expect(screen.getByText("已答 2/3")).toBeInTheDocument();
    // 简答：textarea
    fireEvent.change(screen.getByLabelText("第 3 题作答"), { target: { value: "逐位复核" } });
    expect(screen.getByText("已答 3/3")).toBeInTheDocument();
    expect(submitBtn).toBeEnabled();

    fireEvent.click(submitBtn);
    // 提交中
    expect(await screen.findByText(/判分中/)).toBeInTheDocument();
    await act(async () => releaseSubmit());
    // 结果页
    const banner = await screen.findByText(/15\/30 分/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/正确率 50%/)).toBeInTheDocument();
    expect(document.querySelector(".qz-banner--low")).not.toBeNull();
    expect(screen.getByText(/答对了/)).toBeInTheDocument();
    expect(screen.getByText(/答错了/)).toBeInTheDocument();
    expect(screen.getByText(/部分正确/)).toBeInTheDocument();
    expect(screen.getByText(/1\+1=2，选 B。/)).toBeInTheDocument();
    expect(screen.getByText(/要点：逐位复核/)).toBeInTheDocument();
    expect(screen.getByText(/AI 评语：思路对，漏了逆运算。/)).toBeInTheDocument();
    expect(screen.getByText(/5\/10 分/)).toBeInTheDocument();

    // 提交请求体：单选 string、多选 string[]、简答 string
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/quizzes/q1/submit",
      body: { answers: { qu1: "B", qu2: ["A", "C"], qu3: "逐位复核" } },
    });

    // 返回列表：重新拉取，q1 也变为已完成
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(2));
    expect(screen.queryByText("待作答")).toBeNull();
  });

  it("未答完禁止提交", async () => {
    const { fetchImpl } = stubFlow();
    render(<QuizView childId="c1" fetchImpl={fetchImpl} />);
    await enterAnswering();
    fireEvent.click(screen.getByRole("button", { name: /B\. 2/ }));
    fireEvent.change(screen.getByLabelText("第 3 题作答"), { target: { value: "验算" } });
    expect(screen.getByText("已答 2/3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交答案" })).toBeDisabled();
    // 简答清空后回到未答
    fireEvent.change(screen.getByLabelText("第 3 题作答"), { target: { value: "  " } });
    expect(screen.getByText("已答 1/3")).toBeInTheDocument();
  });

  it("多选再点一次取消选择", async () => {
    const { fetchImpl } = stubFlow();
    render(<QuizView childId="c1" fetchImpl={fetchImpl} />);
    await enterAnswering();
    const chip = screen.getByRole("button", { name: /A\. 2/ });
    fireEvent.click(chip);
    expect(screen.getByText("已答 1/3")).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.getByText("已答 0/3")).toBeInTheDocument();
  });

  it("已提交 quiz 直接进回顾：分数横幅 + 逐题对错徽标 + 正确答案 + 解析，刷新后仍可完整回顾", async () => {
    const { fetchImpl } = stubFlow();
    render(<QuizView childId="c1" fetchImpl={fetchImpl} />);
    // 第二张卡是已完成的
    const cards = await screen.findAllByRole("button", { name: /薄弱点专项练习/ });
    fireEvent.click(cards[1]);
    expect(await screen.findByText(/15\/30 分/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始答题" })).toBeNull();
    expect(screen.getByText(/1\+1=2，选 B。/)).toBeInTheDocument();
    expect(screen.getByText(/要点：逐位复核/)).toBeInTheDocument();
    // 正确答案按选项渲染
    expect(screen.getByText(/正确答案：B\. 2/)).toBeInTheDocument();
    expect(screen.getByText(/正确答案：A\. 2、C\. 4/)).toBeInTheDocument();
    // 逐题对错徽标由 detail.results 还原
    expect(screen.getByText(/答对了/)).toBeInTheDocument();
    expect(screen.getByText(/答错了/)).toBeInTheDocument();
    expect(screen.getByText(/部分正确/)).toBeInTheDocument();
    expect(screen.getByText(/5\/10 分/)).toBeInTheDocument();
    // 历史作答未持久化，不展示「你的作答」
    expect(screen.queryByText(/你的作答/)).toBeNull();
    // 返回列表
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    expect(await screen.findByText("待作答")).toBeInTheDocument();
  });
});

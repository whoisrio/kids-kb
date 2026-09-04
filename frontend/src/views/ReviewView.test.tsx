import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { ReviewView } from "./ReviewView";

afterEach(() => vi.unstubAllGlobals());

const CHILDREN = [{ id: "c1", name: "小宝", grade: null, created_at: "2026-01-01" }];
const CHILDREN_RES = { children: CHILDREN };

function paper(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: "p1", title: "期中卷", subject: "数学", status, error: null, page_count: 1,
    created_at: "2026-09-03", total_questions: 2, confirmed_questions: 0,
    child_name: "小宝", ...extra,
  };
}

function detail(questions: unknown[], status: string = "ready_for_review") {
  return {
    id: "p1", title: "期中卷", subject: "数学", child_id: "c1", status,
    error: null, page_count: 1, created_at: "2026-09-03",
    total_questions: questions.length, confirmed_questions: 0, questions,
  };
}

const Q1 = {
  id: "q1", paper_id: "p1", page_no: 1, seq_in_page: 1, seq: 1,
  content_md: "135 ÷ 5 =", answer_excerpt: "27", mark_desc: "红笔 ✗",
  recognized_result: "wrong", confirmed_result: null, error_cause: null, note: null,
  matched_item_id: null, match_score: null, matched_label: null,
  matched_chapter: null, matched_doc_title: null,
};
const Q2 = { ...Q1, id: "q2", seq_in_page: 2, seq: 2, content_md: "画一画", recognized_result: null };

function stub(routes: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal("fetch", fetchRouter(routes));
}

describe("ReviewView", () => {
  it("挂载:左侧卷列表 + 选中卷加载题目详情", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1, Q2])),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    // VLM 预识别展示 + 预选中提示
    expect(screen.getByText(/红笔 ✗/)).toBeInTheDocument();
  });

  it("键盘流转:1=错(确认并下一条),Enter=采纳预选;焦点在输入框时不触发", async () => {
    const confirms: unknown[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1, Q2])),
      "/api/paper-questions/q1/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q1", paper_status: "ready_for_review" });
      },
      "/api/paper-questions/q2/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q2", paper_status: "done" });
      },
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    // 焦点在备注框时按 1 不触发(keydown 冒泡到 window,target 是输入框被拦)
    fireEvent.keyDown(screen.getByLabelText("备注"), { key: "1" });
    expect(confirms).toEqual([]);
    // 焦点在 body:1 = 错,确认并跳下一条
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(confirms[0]).toEqual({ result: "wrong" }));
    await waitFor(() => expect(screen.getByText("画一画")).toBeInTheDocument());
    // Enter = 采纳预选(Q2 无预选,不触发)
    fireEvent.keyDown(window, { key: "Enter" });
    expect(confirms).toHaveLength(1);
  });

  it("确认带错因与备注(先填后按键)", async () => {
    const confirms: unknown[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/paper-questions/q1/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q1", paper_status: "done" });
      },
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("错因"), { target: { value: "计算错" } });
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "对位错" } });
    fireEvent.keyDown(window, { key: "1" });
    await waitFor(() => expect(confirms[0]).toEqual({
      result: "wrong", error_cause: "计算错", note: "对位错",
    }));
  });

  it("匹配:待匹配题点开候选浮层点选关联", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/paper-questions/q1/candidates": () => jsonResponse({
        candidates: [{ item_id: "i1", content_md: "135 ÷ 5 =", vec_score: 0.93, label: "1", chapter: "第3讲", doc_title: "数学书" }],
      }),
      "/api/paper-questions/q1/match": () => jsonResponse({ id: "q1", matched_item_id: "i1" }),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /待匹配/ }));
    const popover = await screen.findByRole("dialog");
    fireEvent.click(within(popover).getByText(/数学书/));
    await waitFor(() =>
      expect(screen.getByText(/数学书 · 第3讲 · 1/)).toBeInTheDocument());
  });

  it("上传弹层:填表提交 multipart 后刷新列表并选中", async () => {
    let captured: FormData | null = null;
    let listCalls = 0;
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => {
        listCalls++;
        return jsonResponse({ papers: listCalls === 1 ? [] : [paper("processing")] });
      },
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
    });
    // 覆盖 POST /api/papers(fetchRouter 只按 URL 路由,method 区分需手写全局 fetch)
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/papers" && init?.method === "POST") {
        captured = init.body as FormData;
        return jsonResponse(paper("processing"), 201);
      }
      if (url === "/api/children") return jsonResponse(CHILDREN_RES);
      if (url === "/api/papers") return jsonResponse({ papers: [paper("processing")] });
      if (url === "/api/papers/p1") return jsonResponse(detail([Q1]));
      return new Response("404", { status: 404 });
    });
    render(<ReviewView />);
    fireEvent.click(screen.getByRole("button", { name: /上传试卷/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("孩子"), { target: { value: "c1" } });
    fireEvent.change(within(dialog).getByLabelText("标题"), { target: { value: "期中卷" } });
    fireEvent.change(within(dialog).getByLabelText("科目"), { target: { value: "数学" } });
    const file = new File([new Uint8Array([1])], "p1.png", { type: "image/png" });
    fireEvent.change(within(dialog).getByLabelText("文件"), { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "提交" }));
    await waitFor(() => expect(captured!.get("title")).toBe("期中卷"));
    // 列表刷新出现新卷(用队列项断言,避免与详情区《》标题歧义)
    await waitFor(() => expect(screen.getByRole("button", { name: /期中卷/ })).toBeInTheDocument());
  });

  it("failed 详情:展示已渲染页图 + 原件内嵌兜底", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("failed", { error: "VLM 超时" })] }),
      "/api/papers/p1": () => jsonResponse({ ...detail([], "failed"), error: "VLM 超时" }),
      "/api/papers/p1/pages": () => jsonResponse({ pages: [1] }),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText(/处理失败/)).toBeInTheDocument());
    // 有页图:页图 <img> 指向页图端点
    expect(screen.getByAltText(/第 1 页/)).toHaveAttribute(
      "src", "/api/papers/p1/pages/1/image");
    // 原件兜底:iframe 内嵌 source.pdf
    expect(screen.getByTitle("试卷原件")).toHaveAttribute("src", "/api/papers/p1/source.pdf");
  });

  it("ready_for_review 详情:提供查看整卷原件入口", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: "查看整卷原件" });
    expect(link).toHaveAttribute("href", "/api/papers/p1/source.pdf");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("队列按孩子过滤:切换下拉只显示该孩子的卷,队列项显示孩子名", async () => {
    const allPapers = [
      paper("ready_for_review", { id: "p1", child_name: "小宝" }),
      paper("ready_for_review", { id: "p2", title: "英语卷", subject: "英语", child_name: "二宝" }),
    ];
    const filtered = allPapers.filter((p) => p.id === "p1");
    let calls = 0;
    stub({
      "/api/children": () => jsonResponse({ children: [
        ...CHILDREN, { id: "c2", name: "二宝", grade: null, created_at: "2026-01-02" }] }),
      "/api/papers": () => { calls++; return jsonResponse({ papers: allPapers }); },
      "/api/papers?child_id=c1": () => { calls++; return jsonResponse({ papers: filtered }); },
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("英语卷")).toBeInTheDocument());
    // 队列项带孩子的名字(可能与下拉选项同名,用 getAllByText)
    expect(screen.getAllByText("小宝").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("孩子"), { target: { value: "c1" } });
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByText("英语卷")).not.toBeInTheDocument());
  });

  it("匹配浮层打开时按 1/2/3 不确认底层题", async () => {
    const confirms: unknown[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1, Q2])),
      "/api/paper-questions/q1/candidates": () => jsonResponse({ candidates: [] }),
      "/api/paper-questions/q1/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q1", paper_status: "ready_for_review" });
      },
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/待匹配/));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "选择题库条目" })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "1" });  // 浮层开着:不得确认底层题
    expect(confirms).toEqual([]);
  });

  it("确认失败给 UI 反馈(不再只有 console.error)", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/paper-questions/q1/confirm": () => jsonResponse({ error: "服务器开小差" }, 502),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /✗ 错/ }));
    await waitFor(() =>
      expect(screen.getByText(/确认失败/)).toBeInTheDocument());
  });
});

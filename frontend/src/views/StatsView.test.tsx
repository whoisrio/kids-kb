import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { StatsView } from "./StatsView";

const OVERVIEW = {
  hero: { weekWrong: 2, weekTotal: 3, weekRate: 1 / 3, lastWeekRate: 0, rateDelta: 1 / 3, corrected: 1, pending: 3 },
  causes: [{ cause: "粗心", count: 3 }, { cause: "概念不清", count: 1 }],
  weakTags: [{ tag: "计算类", count: 2 }, { tag: "口算", count: 1 }],
  trend: Array.from({ length: 8 }, (_, index) => ({
    weekStart: `2026-09-0${index + 1}`,
    total: 0,
    correct: 0,
    rate: null,
  })),
  pendingList: [
    { id: "i1", kind: "item" as const, content: "例 2 内容", source: "《口算书》 第 1 讲 · 例 2", errorCause: "粗心", lastAt: "2026-09-05T00:00:00Z" },
    { id: "pq1", kind: "paper" as const, content: "未挂题库的试卷题干", source: "《期中卷》", errorCause: null, lastAt: "2026-09-04T00:00:00Z" },
  ],
};

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/stats/overview?child_id=c1": () => jsonResponse({ ...OVERVIEW, ...over }),
    ...over,
  });
}

describe("StatsView", () => {
  it("无孩子：空态提示", () => {
    render(<StatsView childId={null} onToast={vi.fn()} />);
    expect(screen.getByText(/先在复核页上传试卷时添加孩子/)).toBeInTheDocument();
  });

  it("Hero 四卡 + 环比符号 + 错因条形 + 薄弱标签 + 趋势柱", async () => {
    render(<StatsView childId="c1" onToast={vi.fn()} fetchImpl={stub()} />);
    expect(await screen.findByText("2", { selector: ".hero-card[data-k=week-wrong] .num" })).toBeInTheDocument();
    expect(screen.getByText("1", { selector: ".hero-card[data-k=corrected] .num" })).toBeInTheDocument();
    expect(screen.getByText("3", { selector: ".hero-card[data-k=pending] .num" })).toBeInTheDocument();
    expect(screen.getByText(/33%/)).toBeInTheDocument();
    expect(screen.getByText(/\+33\.3pp/)).toBeInTheDocument();
    const bars = screen.getAllByTestId("cause-bar");
    expect(bars[0]).toHaveStyle({ width: "100%" });
    expect(bars[1]).toHaveStyle({ width: "33.33333333333333%" });
    expect(screen.getByText("粗心", { selector: ".bar-label" })).toBeInTheDocument();
    expect(screen.getByText("计算类")).toBeInTheDocument();
    expect(screen.getAllByTestId("trend-col")).toHaveLength(8);
  });

  it("待重练清单 + 已订正：item 题 POST /api/attempts；试卷题 PUT confirm；订正后刷新", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    let response = () => jsonResponse(OVERVIEW);
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/stats")) return response();
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({ id: "x" });
    };
    render(<StatsView childId="c1" onToast={vi.fn()} fetchImpl={fetchImpl} />);
    expect(await screen.findByText("例 2 内容")).toBeInTheDocument();
    expect(screen.getByText("未挂题库的试卷题干")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "已订正" })[0]);
    response = () => jsonResponse({ ...OVERVIEW, pendingList: OVERVIEW.pendingList.slice(1) });
    await waitFor(() => expect(calls).toContainEqual(
      { method: "POST", url: "/api/attempts", body: { child_id: "c1", item_id: "i1", result: "correct" } },
    ));
    await waitFor(() => expect(screen.queryByText("例 2 内容")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "已订正" })[0]);
    await waitFor(() => expect(calls).toContainEqual(
      { method: "PUT", url: "/api/paper-questions/pq1/confirm", body: { result: "correct" } },
    ));
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { StatsView } from "./StatsView";

const OVERVIEW = {
  hero: { weekWrong: 0, weekTotal: 0, weekRate: null, lastWeekRate: null, rateDelta: null, corrected: 0, pending: 0 },
  causes: [],
  weakTags: [{ tag: "计算类", count: 2 }],
  trend: [],
  pendingList: [],
};

function stub(over: {
  overview?: Partial<typeof OVERVIEW>;
  generate?: (init?: RequestInit) => Response;
}) {
  return fetchRouter({
    "/api/stats/overview?child_id=c1": () => jsonResponse({ ...OVERVIEW, ...over.overview }),
    "/api/quizzes/generate": over.generate ?? (() => jsonResponse({
      quiz: {
        id: "q1", child_id: "c1", title: "薄弱点专项练习", tags: ["计算类"],
        status: "pending", created_at: "2026-09-10T00:00:00Z", submitted_at: null,
        question_count: 3, total_points: 30, earned_points: null,
      },
    })),
  });
}

describe("StatsView 薄弱点出题入口", () => {
  it("薄弱知识点区块有「针对薄弱点出题」按钮；成功出题后 onNavigate 跳转", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const onNavigate = vi.fn();
    const fetchImpl = stub({
      generate: (init) => {
        calls.push({
          method: init?.method ?? "GET",
          url: "/api/quizzes/generate",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ quiz: { id: "q1" } });
      },
    });
    render(<StatsView childId="c1" onToast={vi.fn()} onNavigate={onNavigate} fetchImpl={fetchImpl} />);
    const btn = await screen.findByRole("button", { name: "针对薄弱点出题" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([
      { method: "POST", url: "/api/quizzes/generate", body: { child_id: "c1" } },
    ]);
  });

  it("409 no_weak_tags：toast 提示「还没有薄弱知识点记录」，不跳转", async () => {
    const onNavigate = vi.fn();
    const onToast = vi.fn();
    const fetchImpl = stub({
      generate: () => jsonResponse({ error: "no_weak_tags" }, 409),
    });
    render(<StatsView childId="c1" onToast={onToast} onNavigate={onNavigate} fetchImpl={fetchImpl} />);
    fireEvent.click(await screen.findByRole("button", { name: "针对薄弱点出题" }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith("还没有薄弱知识点记录"));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("无薄弱知识点时按钮禁用", async () => {
    const fetchImpl = stub({ overview: { weakTags: [] } });
    render(<StatsView childId="c1" onToast={vi.fn()} fetchImpl={fetchImpl} />);
    expect(await screen.findByText("暂无薄弱知识点")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "针对薄弱点出题" })).toBeDisabled();
  });
});

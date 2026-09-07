import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { DocTrajectory, PageTrajectory } from "./TrajectoryPanel";

const RUN = {
  run_id: "r1", started_at: "2026-09-07T01:00:00Z", ended_at: "2026-09-07T01:01:00Z",
  event_count: 2, error_count: 1, first_stage: "parse", actor: "pipeline",
  first_summary: "区块转录",
};
const EVENTS = [
  { id: 1, run_id: "r1", document_id: "d1", page_id: "p1", item_id: null,
    stage: "parse", event_type: "llm_call", summary: "transcribe qwen3:4b",
    model: "qwen3:4b", prompt_tokens: 10, completion_tokens: 5,
    duration_ms: 120, status: "ok", actor: "pipeline", created_at: "2026-09-07T01:00:01Z" },
  { id: 2, run_id: "r1", document_id: "d1", page_id: null, item_id: null,
    stage: "parse", event_type: "error", summary: "块转录失败",
    model: null, prompt_tokens: null, completion_tokens: null,
    duration_ms: null, status: "error", actor: "pipeline", created_at: "2026-09-07T01:00:02Z" },
];

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [k, v] of Object.entries(routes)) {
      if (url.includes(k)) {
        return { ok: true, json: async () => v } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as Response;
  }) as typeof fetch;
}

describe("DocTrajectory", () => {
  it("展示 run 列表，点击展开事件流，错误事件高亮", async () => {
    const f = fakeFetch({
      [`/api/documents/d1/trajectory?level=event&run_id=r1`]: { events: EVENTS },
      [`/api/documents/d1/trajectory`]: { runs: [RUN] },
    });
    render(<DocTrajectory docId="d1" fetchImpl={f} />);
    await waitFor(() => screen.getByText(/parse/));
    expect(screen.getByText(/2 事件/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /parse/ }));
    await waitFor(() => screen.getByText("transcribe qwen3:4b"));
    expect(screen.getByText("块转录失败").closest(".traj-event")?.className).toContain("error");
  });

  it("无日志时显示空态", async () => {
    const f = fakeFetch({ [`/api/documents/d1/trajectory`]: { runs: [] } });
    render(<DocTrajectory docId="d1" fetchImpl={f} />);
    await waitFor(() => screen.getByText("暂无处理日志"));
  });
});

describe("PageTrajectory", () => {
  it("展示本页事件", async () => {
    const f = fakeFetch({ [`/api/pages/p1/trajectory`]: { events: EVENTS.slice(0, 1) } });
    render(<PageTrajectory pageId="p1" fetchImpl={f} />);
    await waitFor(() => screen.getByText("transcribe qwen3:4b"));
  });
});

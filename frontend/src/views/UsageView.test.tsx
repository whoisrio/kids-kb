import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { UsageView } from "./UsageView";

const OVERVIEW = {
  hero: { promptTokens: 370, completionTokens: 195, totalTokens: 565, calls: 4, textTokens: 265, imageTokens: 300 },
  byPurpose: [
    { purpose: "chat", calls: 2, tokens: 250 },
    { purpose: "vlm", calls: 1, tokens: 300 },
  ],
  byModel: [{ model: "qwen3.5:4b", calls: 2, tokens: 250 }],
  recent: [
    { id: "1", created_at: "2026-09-05T01:00:00Z", purpose: "chat", model: "qwen3.5:4b", modality: "text", prompt_tokens: 100, completion_tokens: 50 },
    { id: "2", created_at: "2026-09-05T02:00:00Z", purpose: "vlm", model: "qwen3.8-27b", modality: "image", prompt_tokens: 200, completion_tokens: 100 },
  ],
};

describe("UsageView", () => {
  it("Hero 数字、分列表、聚合条、流水表（模态标签）", async () => {
    render(<UsageView fetchImpl={fetchRouter({
      "/api/usage/overview": () => jsonResponse(OVERVIEW),
    })} />);
    expect(await screen.findByText("565")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("265", { selector: ".hero-card:nth-child(2) .num" })).toBeInTheDocument();
    expect(screen.getByText("300", { selector: ".hero-card:nth-child(3) .num" })).toBeInTheDocument();
    expect(screen.getByText("chat", { selector: ".bar-label" })).toBeInTheDocument();
    expect(screen.getByText("qwen3.5:4b", { selector: ".bar-label" })).toBeInTheDocument();
    expect(screen.getByText("qwen3.8-27b", { selector: "td" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});

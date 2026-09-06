import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/support";
import { ItemDetail } from "./ItemDetail";

const ITEM = {
  id: "i1", content_type: "exercise", label: "例 1", chapter: "第 1 讲 加法",
  qc_status: "pending", content_md: "24+37=61", taxonomy: "计算类",
  tags: ["口算", "进位加"], doc_title: "口算天天练", source_model: "qwen3.8-27b",
  blocks: [
    { id: "b1", role: "stem", block_type: "text", content_md: "24+37=", source_model: null, crop_url: "/api/review/blocks/b1/crop" },
  ],
  reviews: [{ id: "r1", reason: "ungrounded:例 1 摘录", status: "pending" }],
};

describe("ItemDetail", () => {
  it("详情展示：内容/分类/标签/溯源块裁图/复核行", async () => {
    render(<ItemDetail item={ITEM} onReload={vi.fn()} onExit={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByText("24+37=61")).toBeInTheDocument();
    expect(screen.getByText(/计算类/)).toBeInTheDocument();
    expect(screen.getByText((content, element) =>
      element?.className === "meta" && content.includes("口算 / 进位加"),
    )).toBeInTheDocument();
    expect(screen.getByAltText("块 b1")).toHaveAttribute("src", "/api/review/blocks/b1/crop");
    expect(screen.getByText(/ungrounded/)).toBeInTheDocument();
  });

  it("编辑保存走 PATCH；确认走 approve（内部转发）；打回建行", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse({ id: "i1" });
    };
    const onExit = vi.fn();
    render(<ItemDetail item={ITEM} onReload={vi.fn()} onExit={onExit} onError={vi.fn()} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "✎ 编辑" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑条目" }), { target: { value: "24+37=61（改）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls).toContain("PATCH /api/review/items/i1"));
    fireEvent.click(screen.getByRole("button", { name: "✓ 确认" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/items/i1/approve"));
    fireEvent.click(screen.getByRole("button", { name: "✗ 打回" }));
    fireEvent.change(screen.getByRole("textbox", { name: "打回原因" }), { target: { value: "串章" } });
    fireEvent.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/items/i1/reject"));
  });
});

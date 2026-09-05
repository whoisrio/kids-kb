import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { PageDetail } from "./PageDetail";

const DETAIL = {
  id: "p1", page_no: 3, doc_title: "口算天天练", image_url: "/api/review/pages/p1/image",
  page_md: "整页稿", page_md_model: "qwen3", adopted_source: "blocks",
  blocks: [
    { id: "b1", block_type: "text", bbox: [100, 200, 500, 400], content_md: "24+37=61", source_model: null, pending: [] },
    { id: "b2", block_type: "text", bbox: null, content_md: null, source_model: null, pending: [{ id: "r1", reason: "empty" }] },
  ],
  page_pending: [{ id: "r9", reason: "版面歪斜" }],
};

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/review/pages/p1": () => jsonResponse(DETAIL),
    ...over,
  });
}

describe("PageDetail", () => {
  it("页图 + bbox 覆层按图片自然尺寸百分比定位；pending 块高亮", async () => {
    render(<PageDetail pageId="p1" fetchImpl={stub()} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    expect(screen.getByText("24+37=61")).toBeInTheDocument();
    expect(screen.getByText(/版面歪斜/)).toBeInTheDocument();
  });

  it("块编辑：点编辑变输入框，保存走 PATCH 后刷新详情", async () => {
    let patched = "";
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b1": () => { patched = "b1"; return jsonResponse({ id: "b1" }); },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getAllByRole("button", { name: "✎ 编辑" })[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "编辑转录" }), { target: { value: "24+37=61（改）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patched).toBe("b1"));
  });

  it("整页通过走 approve 并 onExit 刷新；打回建页级行", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/review/pages/p1") return jsonResponse(DETAIL);
      return jsonResponse({ resolved: 1 });
    };
    const onExit = vi.fn();
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={onExit} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    fireEvent.click(screen.getByRole("button", { name: "✓ 整页通过" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/pages/p1/approve"));
    await waitFor(() => expect(onExit).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "✗ 打回本页" }));
    fireEvent.change(screen.getByRole("textbox", { name: "打回原因" }), { target: { value: "缺题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/pages/p1/reject"));
  });

  it("整页解析（VLM）与采用版本切换按钮存在且可点", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/review/pages/p1") return jsonResponse(DETAIL);
      return jsonResponse({ page_md_len: 10 });
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    fireEvent.click(screen.getByRole("button", { name: /远端整页解析/ }));
    await waitFor(() => expect(calls).toContain("/api/review/pages/p1/page-vlm"));
    fireEvent.click(screen.getByRole("button", { name: "✓ 采用整页版" }));
    await waitFor(() => expect(calls).toContain("/api/review/pages/p1/adopt"));
  });
});

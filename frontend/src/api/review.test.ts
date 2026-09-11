import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import {
  adoptReviewPage, approveReviewItem, approveReviewPage, fetchReviewDocs, fetchReviewItems,
  commitBlockGeometry, createBlock, createBlockAnnotation, deleteBlock, deleteBlockAnnotation,
  fetchReviewPage, fetchReviewPages, mergeBlocks, pageVlm, previewBlockGeometry, splitBlock,
  rejectReviewPage, reviewSearch, updateBlockAnnotation, updateReviewBlock, updateReviewPage,
  updateReviewItem,
} from "./review";

describe("api/review", () => {
  it("读路径：docs/pages/items/page 详情与 query 拼装", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/docs": () => jsonResponse([{ id: "d1", title: "书", pending_pages: 2 }]),
      "/api/review/pages?status=pending&doc_id=d1": () => jsonResponse({ pages: [] }),
      "/api/review/items?doc_id=d1&status=pending": () => jsonResponse({ items: [] }),
      "/api/review/pages/p1": () => jsonResponse({ id: "p1", blocks: [] }),
    });
    expect((await fetchReviewDocs(fetchImpl))[0].pending_pages).toBe(2);
    expect(await fetchReviewPages("d1", "pending", fetchImpl)).toEqual({ pages: [] });
    expect(await fetchReviewItems("d1", "pending", fetchImpl)).toEqual({ items: [] });
    expect((await fetchReviewPage("p1", fetchImpl)).id).toBe("p1");
  });

  it("写路径：方法/路径/body 逐一对齐", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({});
    };
    await updateReviewBlock("b1", "改", fetchImpl);
    await updateReviewPage("p1", "新稿", fetchImpl);
    await createBlockAnnotation("b1", "页眉不进题", fetchImpl);
    await updateBlockAnnotation("a1", "改批注", fetchImpl);
    await deleteBlockAnnotation("a1", fetchImpl);
    await updateReviewItem("i1", "改", fetchImpl);
    await rejectReviewPage("p1", "缺题", fetchImpl);
    await adoptReviewPage("p1", "page_md", fetchImpl);
    await approveReviewPage("p1", fetchImpl);
    await approveReviewItem("i1", fetchImpl);
    await pageVlm("p1", fetchImpl);
    await mergeBlocks(["b2", "b1"], fetchImpl);
    await splitBlock("b1", 2, fetchImpl);
    await deleteBlock("b1", fetchImpl);
    await previewBlockGeometry("b1", [0, 0, 1, 1], fetchImpl);
    await commitBlockGeometry("b1", [0, 0, 1, 1], "staging.png", "新文本", "rapidocr", fetchImpl);
    await createBlock("p1", [0, 0, 1, 1], "text", fetchImpl);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /api/review/blocks/b1",
      "PATCH /api/review/pages/p1",
      "POST /api/review/blocks/b1/annotations",
      "PATCH /api/review/block-annotations/a1",
      "DELETE /api/review/block-annotations/a1",
      "PATCH /api/review/items/i1",
      "POST /api/review/pages/p1/reject",
      "POST /api/review/pages/p1/adopt",
      "POST /api/review/pages/p1/approve",
      "POST /api/review/items/i1/approve",
      "POST /api/review/pages/p1/page-vlm",
      "POST /api/review/blocks/merge",
      "POST /api/review/blocks/b1/split",
      "DELETE /api/review/blocks/b1",
      "POST /api/review/blocks/b1/geometry-preview",
      "POST /api/review/blocks/b1/geometry-commit",
      "POST /api/review/pages/p1/blocks",
    ]);
    expect(calls[0].body).toEqual({ content_md: "改" });
    expect(calls[6].body).toEqual({ reason: "缺题" });
    expect(calls[7].body).toEqual({ source: "page_md" });
    expect(calls[11].body).toEqual({ block_ids: ["b2", "b1"] });
    expect(calls[12].body).toEqual({ line_index: 2 });
    expect(calls[14].body).toEqual({ bbox: [0, 0, 1, 1] });
    expect(calls[15].body).toEqual({
      bbox: [0, 0, 1, 1], staging: "staging.png",
      adopted_text: "新文本", source_model: "rapidocr",
    });
    expect(calls[16].body).toEqual({ bbox: [0, 0, 1, 1], block_type: "text" });
  });

  it("reviewSearch：q/subject 拼装；空 q 由调用方拦", async () => {
    let seen = "";
    const fetchImpl = async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({ hits: [] });
    };
    await reviewSearch("竖式", "数学", fetchImpl);
    expect(seen).toBe("/api/review/search?q=" + encodeURIComponent("竖式") + "&subject=" + encodeURIComponent("数学"));
  });

  it("非 2xx 抛错（message 取 body.error）", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/pages/nope": () => jsonResponse({ error: "page 不存在" }, 404),
    });
    await expect(fetchReviewPage("nope", fetchImpl)).rejects.toThrow("page 不存在");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  fetchLibraryChunks, fetchLibraryDoc, fetchLibraryDocs, fetchLibrarySummary, setPageExclusion,
} from "./library.js";

const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("/api/library?")) {
    return Response.json({ documents: [{ id: "d1" }], pagination: { page: 2, pageSize: 10, total: 11, totalPages: 2 } });
  }
  if (url === "/api/library/summary") {
    return Response.json({
      total_docs: 3, by_subject: [{ subject: "数学", count: 2 }, { subject: "语文", count: 1 }],
      indexed_units: 42, pending_review_pages: 1,
    });
  }
  if (url === "/api/library/d1?page=1&pageSize=5") {
    return Response.json({ id: "d1", unit_type: "pages", pages: [], pagination: { page: 1, pageSize: 5, total: 0, totalPages: 0 } });
  }
  if (url === "/api/library/d1/chunks?page=1&pageSize=10") {
    return Response.json({ chunks: [{ id: "c1" }], pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 } });
  }
  if (url === "/api/library/pages/p1/exclusion" && init?.method === "POST") {
    return Response.json({ page_id: "p1", excluded: true, deleted_chunks: 2 });
  }
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

describe("library API", () => {
  it("fetchLibraryDocs sends pagination and filters", async () => {
    const data = await fetchLibraryDocs({
      page: 2, pageSize: 10, q: "数学", subject: "数学", fileType: "pdf", docType: "workbook",
      autoReview: "passed", reviewStatus: "unreviewed", indexStatus: "stale",
    }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/library?page=2&pageSize=10&q=%E6%95%B0%E5%AD%A6&subject=%E6%95%B0%E5%AD%A6&file_type=pdf&doc_type=workbook&auto_review=passed&review_status=unreviewed&index_status=stale",
      undefined,
    );
    expect(data.pagination.total).toBe(11);
  });

  it("fetchLibrarySummary hits the summary endpoint", async () => {
    const summary = await fetchLibrarySummary(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/library/summary", undefined);
    expect(summary.total_docs).toBe(3);
  });

  it("fetchLibraryDoc and chunks send paging", async () => {
    const detail = await fetchLibraryDoc("d1", { page: 1, pageSize: 5 }, fetchImpl);
    const chunks = await fetchLibraryChunks("d1", { page: 1, pageSize: 10 }, fetchImpl);
    expect(detail.unit_type).toBe("pages");
    expect(chunks.chunks[0].id).toBe("c1");
  });

  it("setPageExclusion posts to pipeline-backed API", async () => {
    const result = await setPageExclusion("p1", true, fetchImpl);
    expect(result.deleted_chunks).toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith("/api/library/pages/p1/exclusion", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded: true }),
    });
  });
});

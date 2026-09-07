import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { libraryRoutes } from "./library.js";

const DOC_ID = "11111111-1111-1111-1111-111111111111";

    const pool = {
      query: async (sql: string, _params?: unknown[]) => {
        if (sql.includes("WITH stats AS")) {
          return { rows: [{
            id: DOC_ID, title: "数学练习册", subject: "数学",
            file_type: "pdf", doc_type: "workbook", cover_url: "/api/review/pages/p1/image",
            parse_status: "parsed", review_status: "pending",
            uploaded_by: "rio", created_at: "2026-09-06T00:00:00Z",
            total_units: 10, total_pages: 10, total_chapters: 0,
            auto_pending: 2, auto_passed: 8, auto_needs_review: 0, auto_failed: 0,
            manual_unreviewed: 2, manual_approved: 8, manual_rejected: 0,
            index_indexed: 8, index_stale: 0, index_not_indexed: 2, index_excluded: 0,
            total_count: 1,
          }] };
    }
    if (sql.startsWith("DELETE FROM documents")) {
      return { rowCount: 1 };
    }
    return { rows: [] };
  },
} as never;

function app() {
  return new Hono().route("/api/library",
    libraryRoutes(pool, { pipelineUrl: "http://localhost:8766", search: async () => [] } as never, { storageRoot: "/tmp" } as never));
}

describe("GET /api/library", () => {
  it("返回文档列表含状态和索引统计", async () => {
    const res = await app().request("/api/library");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]).toMatchObject({
      title: "数学练习册", file_type: "pdf",
      doc_type: "workbook", cover_url: "/api/review/pages/p1/image",
      auto_review: { pending: 2, passed: 8 },
      index: { indexed: 8, not_indexed: 2 },
    });
  });
});

describe("GET /api/library doc_type filter", () => {
  it("passes doc_type to SQL params", async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const pool2 = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request("/api/library?doc_type=exam");
    expect(res.status).toBe(200);
    expect(calls[0]?.params).toContain("exam");
  });

  it("rejects invalid doc_type with 422", async () => {
    const res = await app().request("/api/library?doc_type=book");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("doc_type 非法");
  });
});

describe("GET /api/library/summary", () => {
  it("returns totals, subject breakdown and review queue counts", async () => {
    const pool2 = {
      query: async (sql: string) => {
        if (sql.includes("GROUP BY subject")) {
          return { rows: [
            { subject: "数学", count: 3 },
            { subject: null, count: 1 },
          ] };
        }
        if (sql.includes("GROUP BY doc_type")) {
          return { rows: [
            { doc_type: "workbook", count: 3 },
            { doc_type: "exam", count: 1 },
          ] };
        }
        if (sql.includes("total_docs")) {
          return { rows: [{ total_docs: 4, indexed_units: 25, pending_review_pages: 6 }] };
        }
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request("/api/library/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total_docs: 4,
      by_subject: [{ subject: "数学", count: 3 }, { subject: null, count: 1 }],
      by_doc_type: [{ doc_type: "workbook", count: 3 }, { doc_type: "exam", count: 1 }],
      indexed_units: 25,
      pending_review_pages: 6,
    });
  });
});

describe("GET /api/library sort", () => {
  function recordingApp() {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const pool2 = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } as never;
    const instance = new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never));
    return { instance, calls };
  }

  it("默认按 created_at DESC，name/units 走白名单 ORDER BY", async () => {
    const { instance, calls } = recordingApp();
    expect((await instance.request("/api/library")).status).toBe(200);
    expect(calls[0]?.sql).toContain("ORDER BY created_at DESC");
    calls.length = 0;
    await instance.request("/api/library?sort=name");
    expect(calls[0]?.sql).toContain("ORDER BY title ASC");
    calls.length = 0;
    await instance.request("/api/library?sort=units");
    expect(calls[0]?.sql).toContain("ORDER BY total_units DESC");
  });

  it("非法 sort 值 422，且不进 SQL", async () => {
    const { instance, calls } = recordingApp();
    const res = await instance.request("/api/library?sort=title;DROP TABLE documents");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("sort 非法");
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/library pagination", () => {
  it("passes pagination and normalized filters to SQL", async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const pool2 = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request(
      "/api/library?page=2&pageSize=10&q=数学&subject=数学&file_type=pdf" +
      "&auto_review=passed&review_status=unreviewed&index_status=stale",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      documents: [],
      pagination: { page: 2, pageSize: 10, total: 0, totalPages: 0 },
    });
    expect(calls[0]?.sql).toContain("LIMIT");
    expect(calls[0]?.sql).toContain("OFFSET");
    expect(calls[0]?.params).toContain(10);
    expect(calls[0]?.params).toContain("数学");
  });

  it("rejects invalid pagination", async () => {
    const res = await app().request("/api/library?page=0");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("page 须为正整数");
  });
});

describe("GET /api/library/search", () => {
  it("returns hits", async () => {
    const searchPool = {
      query: async () => ({ rows: [] }),
    } as never;
    const mockSearch = async () => [{ doc_id: DOC_ID, doc_title: "数学练习册", content_md: "24+37=" }];
    const app2 = new Hono().route("/api/library",
      libraryRoutes(searchPool, { pipelineUrl: "http://mock:8766", search: mockSearch } as never, { storageRoot: "/tmp" } as never));
    const res = await app2.request("/api/library/search?q=数学");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hits).toHaveLength(1);
    expect(data.hits[0].doc_title).toBe("数学练习册");
  });
});

describe("DELETE /api/library/:id", () => {
  it("级联删除文档", async () => {
    const res = await app().request(`/api/library/${DOC_ID}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

describe("POST /api/library/:id/reindex", () => {
  it("proxies to pipeline", async () => {
    const app2 = new Hono().route("/api/library",
      libraryRoutes({
        query: async () => ({ rows: [] }),
      } as never, {
        pipelineUrl: "http://127.0.0.1:9",
      } as never, { storageRoot: "/tmp" } as never));
    const res = await app2.request(`/api/library/${DOC_ID}/reindex`, {
      method: "POST", body: JSON.stringify({ type: "page", id: "p1" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(502);
  });
});

describe("GET /api/library/:id", () => {
  it("returns chapters with status for non-pdf doc", async () => {
    const pool2 = {
      query: async (sql: string) => {
        if (sql.includes("FROM documents d")) {
          return { rows: [{ id: DOC_ID, title: "英语教材", subject: "英语",
            parse_status: "parsed", review_status: "approved",
            uploaded_by: null, created_at: "2026-09-06", struct_mode: "toc", file_type: "md" }] };
        }
        if (sql.includes("FROM chapters")) {
          return { rows: [{ id: "ch1", chapter_no: 1, title: "第一章",
            content_md: "# 第一章", review_status: "auto_passed", index_status: "indexed" }] };
        }
        return { rows: [] };
      },
    } as never;
    const app2 = new Hono().route("/api/library",
      libraryRoutes(pool2, { pipelineUrl: "http://mock:8766" } as never, { storageRoot: "/tmp" } as never));
    const res = await app2.request(`/api/library/${DOC_ID}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chapters[0]).toMatchObject({
      title: "第一章", review_status: "auto_passed", index_status: "indexed",
    });
  });
});

describe("GET /api/library/:id pagination", () => {
  it("returns paginated PDF pages with block and chunk counts", async () => {
    const pool2 = {
      query: async (sql: string) => {
        if (sql.includes("FROM documents d")) {
          return { rows: [{ id: DOC_ID, title: "数学练习册", subject: "数学",
            parse_status: "parsed", struct_mode: "flat", file_type: "pdf",
            page_count: 2, total_pages: 2, auto_review_passed: 1,
            auto_review_pending: 1, auto_review_failed: 0,
            manual_review_unreviewed: 2, manual_review_approved: 0,
            manual_review_rejected: 0, index_indexed: 1, index_stale: 0,
            index_not_indexed: 0, index_excluded: 0 }] };
        }
        if (sql.includes("FROM pages p")) {
          return { rows: [{
            id: "p1", page_no: 1, parse_status: "parsed",
            auto_review_status: "passed", manual_review_status: "unreviewed",
            index_status: "indexed", excluded_from_index: false,
            block_count: 6, chunk_count: 3, thumbnail_url: "/api/review/pages/p1/image",
          }] };
        }
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request(`/api/library/${DOC_ID}?page=1&pageSize=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.unit_type).toBe("pages");
    expect(data.pages).toHaveLength(1);
    expect(data.pagination).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    expect(data.aggregates.index.indexed).toBe(1);
  });
});

describe("library index controls", () => {
  it("returns a paginated chunk ledger", async () => {
    const pool2 = {
      query: async (sql: string) => {
        if (sql.includes("FROM chunks c")) {
          return { rows: [{
            id: "chunk1", seq: 1, page_no: 17, content_preview: "例 1",
            source_block_ids: ["block2", "block3"], created_at: "2026-09-06T10:00:00Z",
            total_count: 1,
          }] };
        }
        return { rows: [] };
      },
    } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request(`/api/library/${DOC_ID}/chunks?page=1&pageSize=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chunks[0]).toMatchObject({ id: "chunk1", page_no: 17 });
    expect(data.pagination.totalPages).toBe(1);
  });

  it("posts page exclusion to pipeline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ page_id: "p1", excluded: true, deleted_chunks: 2, affected_units: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const pool2 = { query: async () => ({ rows: [] }) } as never;
    const res = await new Hono().route("/api/library", libraryRoutes(pool2, {
      pipelineUrl: "http://mock:8766", search: async () => [],
    } as never, { storageRoot: "/tmp" } as never)).request("/api/library/pages/p1/exclusion", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted_chunks: 2 });
    expect(fetchMock).toHaveBeenCalledWith("http://mock:8766/internal/page-exclusion", expect.anything());
    vi.unstubAllGlobals();
  });
});

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { libraryRoutes } from "./library.js";

const DOC_ID = "11111111-1111-1111-1111-111111111111";

const pool = {
  query: async (sql: string, _params?: unknown[]) => {
    if (sql.includes("SELECT d.id") && sql.includes("GROUP BY")) {
      return { rows: [{
        id: DOC_ID, title: "数学练习册", subject: "数学",
        file_type: "pdf", parse_status: "parsed", review_status: "pending",
        uploaded_by: "rio", created_at: "2026-09-06T00:00:00Z",
        pending_pages: 2, total_pages: 10, indexed_pages: 8,
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
      review_status: "pending", pending_pages: 2,
    });
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
        pipelineUrl: "http://mock:8766",
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

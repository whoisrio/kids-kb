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
    libraryRoutes(pool, { pipelineUrl: "http://localhost:8766" } as never, { storageRoot: "/tmp" } as never));
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

describe("DELETE /api/library/:id", () => {
  it("级联删除文档", async () => {
    const res = await app().request(`/api/library/${DOC_ID}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

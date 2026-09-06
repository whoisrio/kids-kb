import { describe, expect, it } from "vitest";
import { deleteLibraryDoc, fetchLibraryDocs } from "./library.js";

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).endsWith("/api/library") && !init?.method) {
    return new Response(JSON.stringify({
      documents: [{ id: "d1", title: "数学", subject: "数学", file_type: "pdf",
                    parse_status: "parsed", review_status: "pending",
                    uploaded_by: null, created_at: "2026-01-01",
                    pending_pages: 2, total_pages: 10, indexed_pages: 8 }],
    }), { status: 200 });
  }
  if (String(input).includes("/api/library/d1") && init?.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

describe("library API", () => {
  it("fetchLibraryDocs returns documents", async () => {
    const docs = await fetchLibraryDocs(fetchImpl);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("数学");
  });
  it("deleteLibraryDoc calls DELETE", async () => {
    await expect(deleteLibraryDoc("d1", fetchImpl)).resolves.toBeUndefined();
  });
});

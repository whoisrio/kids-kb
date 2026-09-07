import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchLibraryDoc, fetchLibraryChunks, approveLibraryDoc } = vi.hoisted(() => ({
  fetchLibraryDoc: vi.fn(),
  fetchLibraryChunks: vi.fn(),
  approveLibraryDoc: vi.fn(),
}));

vi.mock("../api/library", async () => {
  const actual = await vi.importActual("../api/library") as Record<string, unknown>;
  return { ...actual, fetchLibraryDoc, fetchLibraryChunks, approveLibraryDoc };
});

import { LibraryDetail } from "./LibraryDetail";

const detail = {
  id: "d1", title: "数学练习册", subject: "数学", file_type: "pdf",
  parse_status: "parsed", review_status: "pending", struct_mode: "flat",
  total_pages: 2, total_chapters: 0, total_units: 2, unit_type: "pages" as const,
  pages: [{ id: "p1", page_no: 1, parse_status: "parsed", auto_review_status: "passed",
    manual_review_status: "approved", index_status: "indexed", excluded_from_index: false,
    index_error: null, block_count: 1, chunk_count: 1, thumbnail_url: "/p1/image" }],
  chapters: [], aggregates: {
    auto_review: { pending: 0, passed: 2, needs_review: 0, failed: 0 },
    manual_review: { unreviewed: 0, approved: 2, rejected: 0 },
    index: { indexed: 2, stale: 0, not_indexed: 0, excluded: 0 },
  }, pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
};

describe("LibraryDetail whole-document ingestion", () => {
  beforeEach(() => {
    fetchLibraryDoc.mockResolvedValue(detail);
    fetchLibraryChunks.mockResolvedValue({
      chunks: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
    });
  });

  it("approves and reloads from the header", async () => {
    const user = userEvent.setup();
    approveLibraryDoc.mockResolvedValue({ approved: 2, embedded: 4 });
    render(<LibraryDetail docId="d1" onExit={() => {}} onError={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "数学练习册" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /整本入库/ }));

    await waitFor(() => expect(approveLibraryDoc).toHaveBeenCalledWith("d1", expect.anything()));
    await waitFor(() => expect(fetchLibraryDoc).toHaveBeenCalledTimes(2));
  });
});

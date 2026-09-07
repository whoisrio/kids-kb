import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchLibraryDocs, fetchLibraryDoc } = vi.hoisted(() => ({
  fetchLibraryDocs: vi.fn(),
  fetchLibraryDoc: vi.fn(),
}));

vi.mock("../api/library", async () => {
  const actual = await vi.importActual("../api/library") as Record<string, unknown>;
  return { ...actual, fetchLibraryDocs, fetchLibraryDoc };
});

import { LibraryView } from "./LibraryView";

const doc = {
  id: "d1", title: "数学练习册", subject: "数学", file_type: "pdf",
  parse_status: "parsed", review_status: "pending", created_at: "2026-01-01",
  total_units: 10, total_pages: 10, total_chapters: 0,
  auto_review: { pending: 2, passed: 8, needs_review: 0, failed: 0 },
  manual_review: { unreviewed: 2, approved: 8, rejected: 0 },
  index: { indexed: 8, stale: 1, not_indexed: 1, excluded: 1 },
};

describe("LibraryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchLibraryDocs.mockResolvedValue({ documents: [doc], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
    fetchLibraryDoc.mockResolvedValue({
      ...doc, unit_type: "pages", pages: [], aggregates: doc,
      pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
    });
  });

  it("renders the default table with explicit review and index counts", async () => {
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "自动审核" })).toBeInTheDocument();
    expect(screen.getAllByText("8 通过").length).toBeGreaterThan(0);
    expect(screen.getByText("8 已索引")).toBeInTheDocument();
    expect(screen.getByText("1 过期")).toBeInTheDocument();
  });

  it("sends normalized filters to the API", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.selectOptions(screen.getByLabelText("索引状态"), "stale");
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledWith(
      expect.objectContaining({ indexStatus: "stale", page: 1 }), expect.anything(),
    ));
  });

  it("switches to cards while retaining the index ratio", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "卡片" }));
    expect(screen.getByText("索引 8/10")).toBeInTheDocument();
  });

  it("opens paginated detail", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("查看")).toBeInTheDocument());
    await user.click(screen.getByText("查看"));
    await waitFor(() => expect(fetchLibraryDoc).toHaveBeenCalledWith("d1", { page: 1, pageSize: 10 }, expect.anything()));
    expect(await screen.findByText("页面表")).toBeInTheDocument();
  });
});

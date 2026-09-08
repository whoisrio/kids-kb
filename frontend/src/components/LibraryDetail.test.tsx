import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchLibraryContent, fetchLibraryDoc, fetchLibraryChunks, approveLibraryDoc } =
  vi.hoisted(() => ({
  fetchLibraryContent: vi.fn(),
  fetchLibraryDoc: vi.fn(),
  fetchLibraryChunks: vi.fn(),
  approveLibraryDoc: vi.fn(),
}));

vi.mock("./PageDetail", () => ({
  PageDetail: ({ pageId, onExit }: { pageId: string; onExit: () => void }) => (
    <div>
      <div>页详情 {pageId}</div>
      <button onClick={onExit}>返回详情</button>
    </div>
  ),
}));

vi.mock("../api/library", async () => {
  const actual = await vi.importActual("../api/library") as Record<string, unknown>;
  return { ...actual, fetchLibraryContent, fetchLibraryDoc, fetchLibraryChunks, approveLibraryDoc };
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
    fetchLibraryContent.mockResolvedValue({
      id: "d1", title: "数学练习册", unit_type: "pages",
      sections: [{ page_no: 1, content_md: "第一页全文" }],
    });
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

  it("shows pending and success feedback for whole-document ingestion", async () => {
    const user = userEvent.setup();
    let resolveApproval: (value: { embedded: number }) => void;
    approveLibraryDoc.mockReturnValue(new Promise((resolve) => {
      resolveApproval = resolve;
    }));
    render(<LibraryDetail docId="d1" onExit={() => {}} onError={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "数学练习册" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /整本入库/ }));
    expect(screen.getByRole("status")).toHaveTextContent("正在整本入库…");

    resolveApproval!({ embedded: 4 });
    await waitFor(() => expect(screen.getByRole("status"))
      .toHaveTextContent("整本入库完成，新增 4 条向量"));
  });

  it("shows ingestion errors inside the detail view", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    approveLibraryDoc.mockRejectedValue(new Error("pipeline 不可达"));
    render(<LibraryDetail docId="d1" onExit={() => {}} onError={onError} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "数学练习册" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /整本入库/ }));

    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent("整本入库失败：pipeline 不可达"));
    expect(onError).toHaveBeenCalledWith("pipeline 不可达");
    expect(screen.getByRole("button", { name: /整本入库/ })).toBeEnabled();
  });
});

describe("LibraryDetail three views", () => {
  beforeEach(() => {
    fetchLibraryContent.mockClear().mockResolvedValue({
      id: "d1", title: "数学练习册", unit_type: "pages",
      sections: [{ page_no: 1, content_md: "第一页全文" }],
    });
    fetchLibraryDoc.mockClear().mockResolvedValue(detail);
    fetchLibraryChunks.mockClear().mockResolvedValue({
      chunks: [], pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
    });
    approveLibraryDoc.mockClear();
  });

  it("renders full document content by default", async () => {
    render(<LibraryDetail docId="d1" onExit={() => {}} onError={() => {}} />);

    await waitFor(() => expect(screen.getByText("第一页全文")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "全文" }))
      .toHaveClass("btn-primary");
    expect(fetchLibraryContent).toHaveBeenCalledWith("d1", expect.any(Function));
  });

  it("opens page detail from the page table", async () => {
    const user = userEvent.setup();
    render(<LibraryDetail docId="d1" onExit={() => {}} onError={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "数学练习册" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "页面表" }));
    await user.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByText("页详情 p1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回详情" }));
    expect(screen.getByRole("heading", { name: "数学练习册" })).toBeInTheDocument();
  });

  it("opens page detail from a thumbnail", async () => {
    const user = userEvent.setup();
    render(<LibraryDetail docId="d1" onExit={() => {}} onError={() => {}} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "数学练习册" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "缩略图" }));
    await user.click(screen.getByAltText("第 1 页"));
    expect(screen.getByText("页详情 p1")).toBeInTheDocument();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchLibraryDocs, fetchLibraryDoc, fetchLibrarySummary, deleteLibraryDoc, approveLibraryDoc } = vi.hoisted(() => ({
  fetchLibraryDocs: vi.fn(),
  fetchLibraryDoc: vi.fn(),
  fetchLibrarySummary: vi.fn(),
  deleteLibraryDoc: vi.fn(),
  approveLibraryDoc: vi.fn(),
}));

vi.mock("../api/library", async () => {
  const actual = await vi.importActual("../api/library") as Record<string, unknown>;
  return { ...actual, fetchLibraryDocs, fetchLibraryDoc, fetchLibrarySummary, deleteLibraryDoc, approveLibraryDoc };
});

import { LibraryView } from "./LibraryView";

const doc = {
  id: "d1", title: "数学练习册", subject: "数学", file_type: "pdf",
  doc_type: "workbook", cover_url: "/api/review/pages/p1/image",
  parse_status: "parsed", review_status: "pending", created_at: "2026-01-01",
  total_units: 10, total_pages: 10, total_chapters: 0, pages_parsed: 10, pages_failed: 0,
  auto_review: { pending: 2, passed: 8, needs_review: 0, failed: 0 },
  manual_review: { unreviewed: 2, approved: 8, rejected: 0 },
  index: { indexed: 8, stale: 1, not_indexed: 1, excluded: 1 },
};

describe("LibraryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchLibraryDocs.mockResolvedValue({ documents: [doc], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
    fetchLibrarySummary.mockResolvedValue({
      total_docs: 3, by_subject: [{ subject: "数学", count: 2 }, { subject: "语文", count: 1 }],
      by_doc_type: [{ doc_type: "workbook", count: 2 }, { doc_type: "exam", count: 1 }],
      indexed_units: 42, pending_review_pages: 2,
    });
    fetchLibraryDoc.mockResolvedValue({
      ...doc, unit_type: "pages", pages: [], aggregates: doc,
      pagination: { page: 1, pageSize: 10, total: 0, totalPages: 0 },
    });
  });

  it("默认书架视图：页头、指标卡与封面卡片", async () => {
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "数字书架与资料库" })).toBeInTheDocument();
    // 指标卡三张，数据来自 /api/library/summary
    await waitFor(() => expect(screen.getByText("在库资料")).toBeInTheDocument());
    expect(screen.getByText("数学 2 · 语文 1")).toBeInTheDocument();
    expect(screen.getByText("已索引单元")).toBeInTheDocument();
    expect(screen.getByText("待复核页")).toBeInTheDocument();
    // 书架卡片：科目/类型徽章 + 待确认状态 + 索引进度 + 封面图
    expect(screen.getAllByText("同步教辅").length).toBeGreaterThan(0);
    expect(screen.getByText(/2 页待确认/)).toBeInTheDocument();
    expect(screen.getByText(/\/ 10 单元已索引/)).toBeInTheDocument();
    expect(screen.getByAltText("《数学练习册》封面")).toHaveAttribute("src", "/api/review/pages/p1/image");
    expect(document.querySelector(".shelf-grid")).not.toBeNull();
  });

  it("无封面时按科目色块兜底，图片加载失败也兜底", async () => {
    fetchLibraryDocs.mockResolvedValue({
      documents: [{ ...doc, id: "d2", title: "语文读本", subject: "语文", cover_url: null,
        auto_review: { pending: 0, passed: 4, needs_review: 0, failed: 0 } }],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("语文读本")).toBeInTheDocument());
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".sc-cover.subj-chinese")).not.toBeNull();
    expect(screen.getByText("全部就绪")).toBeInTheDocument();
  });

  it("doc_type tab 计数来自 summary.by_doc_type，切换携带过滤参数", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    // 计数是全量统计（summary），不随当前筛选/分页变化
    expect(screen.getByRole("button", { name: "全部资料 (3)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步教辅 (2)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "试卷 (1)" }));
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledWith(
      expect.objectContaining({ docType: "exam", page: 1 }), expect.anything(),
    ));
  });

  it("排序下拉走后端 sort 参数", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("排序"), "units");
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "units" }), expect.anything(),
    ));
    await user.selectOptions(screen.getByLabelText("排序"), "name");
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "name" }), expect.anything(),
    ));
  });

  it("有 onOpenReview 时「前往复核」跳入复核而非详情", async () => {
    const user = userEvent.setup();
    const onOpenReview = vi.fn();
    render(<LibraryView onOpenReview={onOpenReview} />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /前往复核 \(2\)/ }));
    expect(onOpenReview).toHaveBeenCalledWith("d1");
    expect(fetchLibraryDoc).not.toHaveBeenCalled();
  });

  it("无 onOpenReview 时「前往复核」维持打开详情", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /前往复核 \(2\)/ }));
    await waitFor(() => expect(fetchLibraryDoc).toHaveBeenCalledWith("d1", { page: 1, pageSize: 10 }, expect.anything()));
  });

  it("待复核指标卡点击后按 needs_review 过滤", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("待复核页")).toBeInTheDocument());
    await user.click(screen.getByText("待复核页").closest("button")!);
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledWith(
      expect.objectContaining({ autoReview: "needs_review" }), expect.anything(),
    ));
  });

  it("上传按钮打开资料上传弹窗", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.click(screen.getByRole("button", { name: /上传新教辅/ }));
    const dialog = screen.getByRole("dialog", { name: "上传资料" });
    // 资料库入库无「孩子」字段，有类型选择
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("类型")).toHaveValue("workbook");
  });

  it("检测中（parsing）显示进度徽标并轮询刷新，出检测态后停止", async () => {
    // shouldAdvanceTime：waitFor/userEvent 的内部计时器仍走真实时间，手动 advance 只驱动轮询
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const parsingDoc = {
        ...doc, id: "d2", title: "新教辅", parse_status: "parsing",
        total_pages: 8, pages_parsed: 3, pages_failed: 0,
        auto_review: { pending: 0, passed: 0, needs_review: 0, failed: 0 },
      };
      const parsedDoc = { ...parsingDoc, parse_status: "parsed", pages_parsed: 8 };
      let calls = 0;
      fetchLibraryDocs.mockImplementation(async () => {
        calls++;
        // 第一轮检测中，第二轮起检测完成
        return {
          documents: [calls === 1 ? parsingDoc : parsedDoc],
          pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        };
      });
      render(<LibraryView />);
      await waitFor(() => expect(screen.getByText("检测中 3/8 页")).toBeInTheDocument());
      // 检测态下原待确认/就绪徽标让位
      expect(screen.queryByText("全部就绪")).toBeNull();
      // 4s 后轮询触发一次 reload
      const before = calls;
      await vi.advanceTimersByTimeAsync(4000);
      expect(calls).toBe(before + 1);
      // 出检测态后不再轮询
      await waitFor(() => expect(screen.queryByText(/检测中/)).toBeNull());
      const settled = calls;
      await vi.advanceTimersByTimeAsync(8000);
      expect(calls).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("检测失败（failed）显示红徽标且不轮询；待检测（pending）灰徽标", async () => {
    fetchLibraryDocs.mockResolvedValue({
      documents: [
        { ...doc, id: "d3", title: "坏资料", parse_status: "failed",
          auto_review: { pending: 0, passed: 0, needs_review: 0, failed: 0 } },
        { ...doc, id: "d4", title: "排队资料", parse_status: "pending", cover_url: null,
          auto_review: { pending: 0, passed: 0, needs_review: 0, failed: 0 } },
      ],
      pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
    });
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("检测失败")).toBeInTheDocument());
    expect(screen.getByText("待检测")).toBeInTheDocument();
    expect(screen.queryByText("全部就绪")).toBeNull();
    expect(screen.queryByText(/页待确认/)).toBeNull();
  });

  it("切到明细表格视图：审核与索引计数、查看入口", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "明细表格" }));
    expect(document.querySelector(".library-table")).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "自动审核" })).toBeInTheDocument();
    expect(screen.getAllByText("8 通过").length).toBeGreaterThan(0);
    expect(screen.getByText("8 已索引")).toBeInTheDocument();
    expect(screen.getByText("1 过期")).toBeInTheDocument();
    expect(screen.getByText("数学 · 同步教辅 · PDF")).toBeInTheDocument();
  });

  it("sends normalized filters to the API", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await user.selectOptions(screen.getByLabelText("索引状态"), "stale");
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledWith(
      expect.objectContaining({ indexStatus: "stale", page: 1 }), expect.anything(),
    ));
  });

  it("表格视图打开分页详情", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "明细表格" }));
    await user.click(screen.getByText("查看"));
    await waitFor(() => expect(fetchLibraryDoc).toHaveBeenCalledWith("d1", { page: 1, pageSize: 10 }, expect.anything()));
    expect(await screen.findByText("页面表")).toBeInTheDocument();
  });

  it("书架卡片标题点击打开详情", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "数学练习册" }));
    await waitFor(() => expect(fetchLibraryDoc).toHaveBeenCalledWith("d1", { page: 1, pageSize: 10 }, expect.anything()));
  });

  it("更多菜单删除需二次确认", async () => {
    const user = userEvent.setup();
    deleteLibraryDoc.mockResolvedValue(undefined);
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "更多操作 数学练习册" }));
    await user.click(screen.getByRole("button", { name: /删除资料/ }));
    expect(screen.getByRole("dialog", { name: "删除资料" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(deleteLibraryDoc).toHaveBeenCalledWith("d1", expect.anything()));
  });

  it("整本入库后刷新资料状态", async () => {
    const user = userEvent.setup();
    approveLibraryDoc.mockResolvedValue({ approved: 2, embedded: 4 });
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "更多操作 数学练习册" }));
    await user.click(screen.getByRole("button", { name: /整本入库/ }));

    await waitFor(() => expect(approveLibraryDoc).toHaveBeenCalledWith("d1", expect.anything()));
    await waitFor(() => expect(fetchLibraryDocs).toHaveBeenCalledTimes(2));
  });

  it("shows card ingestion success feedback", async () => {
    const user = userEvent.setup();
    approveLibraryDoc.mockResolvedValue({ pages: 2, chunks: 4, resolved: 0 });
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "更多操作 数学练习册" }));
    await user.click(screen.getByRole("button", { name: /整本入库/ }));

    await waitFor(() => expect(screen.getByRole("status"))
      .toHaveTextContent("整本入库完成，新增 4 条向量"));
  });

  it("shows card ingestion error feedback", async () => {
    const user = userEvent.setup();
    approveLibraryDoc.mockRejectedValue(new Error("pipeline 不可达"));
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "更多操作 数学练习册" }));
    await user.click(screen.getByRole("button", { name: /整本入库/ }));

    await waitFor(() => expect(screen.getByRole("alert"))
      .toHaveTextContent("整本入库失败：pipeline 不可达"));
  });
});

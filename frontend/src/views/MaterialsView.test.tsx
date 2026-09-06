import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { MaterialsView } from "./MaterialsView";

const DOCS = [
  { id: "d1", title: "口算天天练", subject: "数学", doc_type: "workbook", status: "parsed", struct_mode: null, pending_pages: 2 },
  { id: "d2", title: "学霸提优", subject: "数学", doc_type: "exam", status: "parsed", struct_mode: "flat", pending_pages: 0 },
];

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/review/docs": () => jsonResponse(DOCS),
    "/api/review/pages?status=pending": () => jsonResponse({
      pages: [{ id: "p1", page_no: 3, doc_title: "口算天天练", pending_reasons: ["empty"] }],
    }),
    "/api/review/pages?status=approved": () => jsonResponse({ pages: [] }),
    "/api/review/items?status=pending": () => jsonResponse({
      items: [{ id: "i1", content_type: "exercise", label: "例 1", chapter: "第 1 讲", qc_status: "pending", doc_title: "口算天天练", pending_reasons: ["ungrounded:例 1"], content_md: "24+37", source_model: null }],
    }),
    ...over,
  });
}

describe("MaterialsView", () => {
  it("挂载加载文档下拉（含待复核徽标），默认待复核页块列出页卡", async () => {
    render(<MaterialsView fetchImpl={stub()} />);
    const select = await screen.findByRole("combobox", { name: "选择文档" });
    expect(select).toHaveValue("");
    expect(screen.getByRole("option", { name: /口算天天练/ })).toHaveTextContent("待复核 2 页");
    expect(await screen.findByText(/第 3 页/)).toBeInTheDocument();
    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("四块切换：已通过页/条目/试搜", async () => {
    render(<MaterialsView fetchImpl={stub()} />);
    await screen.findByText(/第 3 页/);
    fireEvent.click(screen.getByRole("button", { name: "已通过页" }));
    expect(await screen.findByText("没有已通过页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "条目" }));
    expect(await screen.findByText("例 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "试搜" }));
    expect(screen.getByPlaceholderText(/语义检索/)).toBeInTheDocument();
  });

  it("章节 tab：无页文本资料内容可见", async () => {
    render(<MaterialsView fetchImpl={stub({
      "/api/review/chapters": () => jsonResponse({
        chapters: [
          { id: "c1", document_id: "d3", doc_title: "英语语法测试", chapter_no: 1, title: "英语语法测试", content_md: "一、单项选择" },
        ],
      }),
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "章节" }));
    expect(await screen.findByText("一、单项选择")).toBeInTheDocument();
    expect(screen.getByText("英语语法测试")).toBeInTheDocument();
  });

  it("选中页卡进入页详情（PageDetail 挂载）", async () => {
    render(<MaterialsView fetchImpl={stub({
      "/api/review/pages/p1": () => jsonResponse({
        id: "p1", page_no: 3, doc_title: "口算天天练", image_url: "/api/review/pages/p1/image",
        page_md: null, page_md_model: null, adopted_source: "blocks",
        blocks: [], page_pending: [],
      }),
    })} />);
    fireEvent.click(await screen.findByText(/第 3 页/));
    await waitFor(() => expect(screen.getByRole("button", { name: "✓ 整页通过" })).toBeInTheDocument());
  });
});

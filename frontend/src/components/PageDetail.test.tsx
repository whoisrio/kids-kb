import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { PageDetail } from "./PageDetail";

const DETAIL = {
  id: "p1", page_no: 3, doc_title: "口算天天练", image_url: "/api/review/pages/p1/image",
  page_md: "整页稿", page_md_model: "qwen3", adopted_source: "blocks",
  blocks: [
    { id: "b1", block_type: "text", bbox: [100, 200, 500, 400], content_md: "24+37=61", source_model: null, pending: [] },
    { id: "b2", block_type: "text", bbox: null, content_md: null, source_model: null, pending: [{ id: "r1", reason: "empty" }] },
  ],
  page_pending: [{ id: "r9", reason: "版面歪斜" }],
};

function loadPageImage() {
  const image = screen.getByAltText("第 3 页");
  Object.defineProperty(image, "naturalWidth", { value: 600, configurable: true });
  Object.defineProperty(image, "naturalHeight", { value: 800, configurable: true });
  fireEvent.load(image);
}

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/review/pages/p1": () => jsonResponse(DETAIL),
    ...over,
  });
}

describe("PageDetail", () => {
  it("页图 + bbox 覆层按图片自然尺寸百分比定位；pending 块高亮", async () => {
    render(<PageDetail pageId="p1" fetchImpl={stub()} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    expect(screen.getByText("24+37=61")).toBeInTheDocument();
    expect(screen.getByText(/版面歪斜/)).toBeInTheDocument();
  });

  it("bbox 覆层与页图共用页图坐标系", async () => {
    render(<PageDetail pageId="p1" fetchImpl={stub()} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    loadPageImage();
    const image = screen.getByAltText("第 3 页");
    expect(image.closest(".img-frame")).not.toBeNull();
    const frame = image.closest(".img-frame")!;
    expect(frame).toHaveClass("img-frame");
    expect(frame.querySelectorAll(".bbox")).toHaveLength(1);
  });

  it("预览切分结果在右栏顶部展示序号与来源", async () => {
    render(<PageDetail pageId="p1" fetchImpl={stub({
      "/api/review/pages/p1/index-preview": () => jsonResponse({
        chunks: [
          { seq: 1, content_preview: "第一段", source_block_ids: ["b1"] },
          { seq: 2, content_preview: "第二段", source_block_ids: [] },
        ],
      }),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getByRole("button", { name: "预览切分" }));
    const preview = await screen.findByRole("region", { name: "切分预览" });
    expect(preview.querySelectorAll("li")).toHaveLength(2);
    expect(preview).toHaveTextContent("01");
    expect(preview).toHaveTextContent("B1");
    expect(preview).toHaveTextContent("整页");
    expect(preview.compareDocumentPosition(screen.getByText(/整页转录/)))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("本页日志可收起且不阻断视图切换", async () => {
    const detail = {
      ...DETAIL,
      questions: [{
        id: "i1", content_type: "exercise", label: "1", content_md: "24+37=61",
        qc_status: "pending", block_ids: ["b1"], block_crops: [],
        answer: { id: "a1", content_md: "解析：61", qc_status: "pending", block_ids: ["b2"], block_crops: [] },
      }],
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(detail),
      "/api/pages/p1/trajectory": () => jsonResponse({ events: [{ id: "e1", stage: "ocr", event_type: "parsed", status: "success", summary: "解析完成" }] }),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    const logButton = screen.getByRole("button", { name: "本页日志" });
    fireEvent.click(logButton);
    const log = await screen.findByRole("region", { name: "本页处理日志" });
    expect(log).toHaveTextContent("解析完成");

    fireEvent.click(screen.getByRole("button", { name: "题目视图" }));
    expect(document.querySelector(".pd-body")).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起本页日志" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "收起本页日志" }));
    expect(screen.queryByRole("region", { name: "本页处理日志" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "本页日志" })).toBeVisible();
  });

  it("题目视图聚合题干与解析", async () => {
    const detail = {
      ...DETAIL,
      questions: [
        {
          id: "q1", content_type: "exercise", label: "例 1", content_md: "题干 **24+37**",
          qc_status: "approved", block_ids: ["b1"], block_crops: [],
          answer: { id: "a1", content_md: "解析 $61$", qc_status: "pending", block_ids: ["b1"], block_crops: [] },
        },
        {
          id: "a2", content_type: "answer", label: "例 2", content_md: "未配对解析",
          qc_status: "rejected", block_ids: [], block_crops: [], answer: null,
        },
      ],
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(detail),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getByRole("button", { name: "题目视图" }));
    const card = screen.getByText("24+37").closest(".itemcard")!;
    expect(card).toHaveClass("approved");
    expect(card).toHaveTextContent("题目 · 例 1");
    const answerNode = card.querySelector(".question-answer");
    expect(answerNode).toHaveTextContent("解析");
    expect(answerNode).toHaveTextContent("61");
    expect(document.querySelector(".question-answer .katex")).not.toBeNull();
    const orphan = screen.getByText("未配对解析").closest(".itemcard")!;
    expect(orphan).toHaveClass("rejected");
    expect(orphan).toHaveTextContent("解析 · 例 2");
  });

  it("页图条目标签只在选中块显示", async () => {
    const detail = {
      ...DETAIL,
      blocks: [{ ...DETAIL.blocks[0], items: [{ id: "i1", label: "例 1", content_type: "exercise", role: "stem" }] }],
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(detail),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    expect(screen.queryByText("#例 1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("块 b1"));
    expect(screen.getByText("#例 1")).toBeInTheDocument();
  });

  it("块编辑：点编辑变输入框，保存走 PATCH 后刷新详情", async () => {
    let patched = "";
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b1": () => { patched = "b1"; return jsonResponse({ id: "b1" }); },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getAllByRole("button", { name: "✎ 编辑" })[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "编辑转录" }), { target: { value: "24+37=61（改）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patched).toBe("b1"));
  });

  it("选中左侧 bbox 后右侧块列表滚动联动", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<PageDetail pageId="p1" fetchImpl={stub()} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    fireEvent.click(screen.getByLabelText("块 b1"));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.getByText("24+37=61").closest(".blockitem")).toHaveClass("selected");
  });

  it("右侧块列表连续切换时覆层始终跟随当前块", async () => {
    const detail = {
      ...DETAIL,
      blocks: [
        { ...DETAIL.blocks[0], id: "b1", bbox: [100, 200, 500, 400] },
        { ...DETAIL.blocks[1], id: "b2", bbox: [300, 500, 400, 560], pending: [] },
      ],
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(detail),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    fireEvent.click(screen.getByText("24+37=61").closest(".blockitem")!);
    fireEvent.keyDown(screen.getByLabelText("块 b1"), { key: "ArrowLeft" });
    fireEvent.click(screen.getByText("（空）").closest(".blockitem")!);
    expect(screen.getByLabelText("块 b1")).toHaveStyle({ left: "16.666666666666664%" });
    expect(screen.getByLabelText("块 b2")).toHaveStyle({ left: "50%" });
  });

  it("整页通过走 approve 并 onExit 刷新；打回建页级行", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/review/pages/p1") return jsonResponse(DETAIL);
      return jsonResponse({ resolved: 1 });
    };
    const onExit = vi.fn();
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={onExit} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    fireEvent.click(screen.getByRole("button", { name: "✓ 整页通过" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/pages/p1/approve"));
    await waitFor(() => expect(onExit).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "✗ 打回本页" }));
    fireEvent.change(screen.getByRole("textbox", { name: "打回原因" }), { target: { value: "缺题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/pages/p1/reject"));
  });

  it("整页解析（VLM）与采用版本切换按钮存在且可点", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/review/pages/p1") return jsonResponse(DETAIL);
      return jsonResponse({ page_md_len: 10 });
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    fireEvent.click(screen.getByRole("button", { name: /远端整页解析/ }));
    await waitFor(() => expect(calls).toContain("/api/review/pages/p1/page-vlm"));
    fireEvent.click(screen.getByRole("button", { name: "✓ 采用整页版" }));
    await waitFor(() => expect(calls).toContain("/api/review/pages/p1/adopt"));
  });

  it("⌘点击多选两块后合并：调 merge API 并刷新", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/merge": (init) => {
        expect(JSON.parse(String(init?.body)).block_ids.sort()).toEqual(["b1", "b2"]);
        return jsonResponse({ id: "b3" });
      },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getByText("24+37=61"), { metaKey: true });
    fireEvent.click(screen.getByText("（空）"), { metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "合并选中块" }));
    await screen.findByText("合并 2 块成功");
  });

  it("文本框内光标在第 2 行点拆分：split API 收到 line_index=2", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b1/split": (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ line_index: 2 });
        return jsonResponse({ ids: ["b3", "b4"] });
      },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getAllByRole("button", { name: "✎ 编辑" })[0]);
    const textarea = screen.getByRole("textbox", { name: "编辑转录" });
    fireEvent.change(textarea, { target: { value: "第一行\n第二行" } });
    (textarea as HTMLTextAreaElement).setSelectionRange(8, 8);
    fireEvent.click(screen.getByRole("button", { name: "拆分块" }));
    await screen.findByText("已按光标行拆分");
  });

  it("manual 与 edited 块显示语义框和图例", async () => {
    const detail = {
      ...DETAIL,
      blocks: [
        { ...DETAIL.blocks[0], id: "b1", origin: "manual" },
        { ...DETAIL.blocks[1], id: "b2", bbox: [0, 0, 10, 10], geometry_revision: 2 },
        { ...DETAIL.blocks[1], id: "b3", bbox: [0, 0, 10, 10], origin: "merged" },
      ],
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(detail),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    loadPageImage();
    expect(screen.getByLabelText("块 b1")).toHaveClass("manual");
    expect(screen.getByLabelText("块 b2")).toHaveClass("edited");
    expect(screen.getByLabelText("块 b3")).toHaveClass("edited");
    expect(screen.getByText("聚焦")).toBeInTheDocument();
    expect(screen.getAllByText("补画")).toHaveLength(2);
    expect(document.querySelectorAll(".bbox.manual")).toHaveLength(1);
    expect(document.querySelectorAll(".bbox.edited")).toHaveLength(2);
  });

  it("键盘微调：只更新 geometryDraft，不自动调识别", async () => {
    const calls: unknown[] = [];
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b1/geometry-preview": (init) => {
        calls.push(JSON.parse(String(init?.body)).bbox);
        return jsonResponse({ text: "新", source_model: "rapidocr", crop_pad: [6, 4], staging: "s.png" });
      },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    fireEvent.click(screen.getByLabelText("块 b1"));
    fireEvent.keyDown(screen.getByLabelText("块 b1"), { key: "ArrowLeft" });
    expect(calls).toEqual([]);
    fireEvent.keyDown(screen.getByLabelText("块 b1"), { key: "ArrowRight", shiftKey: true });
    expect(calls).toEqual([]);
  });

  it("键盘微调后覆层跟随 geometryDraft", async () => {
    render(<PageDetail pageId="p1" fetchImpl={stub({
      "/api/review/blocks/b1/geometry-preview": () => jsonResponse({
        text: "新", source_model: "rapidocr", crop_pad: [6, 4], staging: "s.png",
      }),
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    fireEvent.click(screen.getByLabelText("块 b1"));
    fireEvent.keyDown(screen.getByLabelText("块 b1"), { key: "ArrowLeft" });
    expect(screen.getByLabelText("块 b1")).toHaveStyle({ left: "16.5%" });
  });

  it("8 控制点拖拽只更新 bbox，显式预览才触发识别", async () => {
    const calls: unknown[] = [];
    render(<PageDetail pageId="p1" fetchImpl={stub({
      "/api/review/blocks/b1/geometry-preview": (init) => {
        calls.push(JSON.parse(String(init?.body)).bbox);
        return jsonResponse({ text: "新", source_model: "rapidocr", crop_pad: [6, 4], staging: "s.png" });
      },
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    const box = screen.getByLabelText("块 b1");
    fireEvent.click(box);
    expect(box.querySelectorAll(".geometry-handle")).toHaveLength(8);
    const wrapper = screen.getByAltText("第 3 页").parentElement!;
    Object.defineProperty(wrapper, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 300, height: 400 }),
      configurable: true,
    });
    const handle = box.querySelector<HTMLElement>('[data-handle="left-top"]')!;
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 200 });
    fireEvent.pointerMove(wrapper, { clientX: 60, clientY: 200 });
    fireEvent.pointerUp(wrapper, { clientX: 60, clientY: 200 });
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "预览新框识别" }));
    await waitFor(() => expect(calls).toEqual([[20, 200, 500, 400]]));
  });

  it("角部控制点同时调整横纵坐标", async () => {
    const calls: unknown[] = [];
    render(<PageDetail pageId="p1" fetchImpl={stub({
      "/api/review/blocks/b1/geometry-preview": (init) => {
        calls.push(JSON.parse(String(init?.body)).bbox);
        return jsonResponse({ text: "新", source_model: "rapidocr", crop_pad: [6, 4], staging: "s.png" });
      },
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    const box = screen.getByLabelText("块 b1");
    fireEvent.click(box);
    const wrapper = screen.getByAltText("第 3 页").parentElement!;
    Object.defineProperty(wrapper, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 300, height: 400 }),
      configurable: true,
    });
    const handle = box.querySelector<HTMLElement>('[data-handle="right-bottom"]')!;
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 400 });
    fireEvent.pointerMove(wrapper, { clientX: 540, clientY: 430 });
    fireEvent.pointerUp(wrapper, { clientX: 540, clientY: 430 });
    expect(calls).toEqual([]);
  });

  it("拖到相邻块边界 4 显示像素内时吸附", async () => {
    const calls: unknown[] = [];
    const detail = {
      ...DETAIL,
      blocks: [
        { ...DETAIL.blocks[0], id: "b1", bbox: [100, 200, 500, 400] },
        { ...DETAIL.blocks[1], id: "b2", bbox: [100, 500, 200, 600], pending: [] },
      ],
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(detail),
      "/api/review/blocks/b1/geometry-preview": (init) => {
        calls.push(JSON.parse(String(init?.body)).bbox);
        return jsonResponse({ text: "新", source_model: "rapidocr", crop_pad: [6, 4], staging: "s.png" });
      },
    })} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    loadPageImage();
    const box = screen.getByLabelText("块 b1");
    fireEvent.click(box);
    const wrapper = screen.getByAltText("第 3 页").parentElement!;
    Object.defineProperty(wrapper, "getBoundingClientRect", {
      value: () => ({ left: 10, top: 20, width: 300, height: 400 }),
      configurable: true,
    });
    const handle = box.querySelector<HTMLElement>('[data-handle="left-top"]')!;
    fireEvent.pointerDown(handle, { clientX: 60, clientY: 120 });
    fireEvent.pointerMove(wrapper, { clientX: 57, clientY: 120 });
    fireEvent.pointerUp(wrapper, { clientX: 57, clientY: 120 });
    expect(calls).toEqual([]);
  });

  it("↑↓ 在非 bbox 焦点时切换聚焦块；⌘Enter 通过本页", async () => {
    const onExit = vi.fn();
    render(<PageDetail pageId="p1" fetchImpl={stub({
      "/api/review/pages/p1/approve": () => jsonResponse({ ok: true }),
    })} onExit={onExit} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.getAllByText("（空）")[0].closest(".blockitem")).toHaveClass("selected");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByText("24+37=61").closest(".blockitem")).toHaveClass("selected");
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onExit).toHaveBeenCalled());
  });

  it("拖拽后显式预览，确认后调 commit 并刷新", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b1/geometry-preview": () => jsonResponse({
        text: "新", source_model: "rapidocr", crop_pad: [6, 4], staging: "s.png",
      }),
      "/api/review/blocks/b1/geometry-commit": (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          bbox: [100, 200, 500, 400], staging: "s.png",
          adopted_text: "新", source_model: "rapidocr",
        });
        return jsonResponse({ ok: true });
      },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    loadPageImage();
    fireEvent.click(screen.getByLabelText("块 b1"));
    fireEvent.mouseDown(screen.getByLabelText("块 b1"), { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(screen.getByLabelText("块 b1"), { clientX: 11, clientY: 11 });
    fireEvent.click(screen.getByRole("button", { name: "预览新框识别" }));
    fireEvent.click(await screen.findByRole("button", { name: "采用新文本" }));
    await screen.findByText("已应用调框结果");
  });

  it("补画模式拖拽拉框 → createBlock，Esc 退出", async () => {
    const detail = {
      ...DETAIL,
      blocks: [
        ...DETAIL.blocks,
        { id: "b9", block_type: "text", bbox: [10, 10, 20, 20], content_md: "补画内容",
          source_model: "rapidocr", pending: [], annotations: [], origin: "manual" },
      ],
    };
    let created = false;
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(created ? detail : DETAIL),
      "/api/review/pages/p1/blocks": (init) => {
        expect(JSON.parse(String(init?.body)).bbox).toEqual([10, 10, 20, 20]);
        created = true;
        return jsonResponse({ block: { id: "b9", origin: "manual", content_md: "补画内容" } });
      },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    expect(screen.getByAltText("第 3 页")).toHaveAttribute("draggable", "false");
    loadPageImage();
    fireEvent.click(screen.getByLabelText("块 b1"));
    fireEvent.keyDown(screen.getByLabelText("块 b1"), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("button", { name: "补画新框" }));
    fireEvent.pointerDown(screen.getByAltText("第 3 页"), { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(screen.getByAltText("第 3 页"), { clientX: 20, clientY: 20 });
    expect(screen.getByTestId("creating-bbox")).toHaveStyle({
      left: "10px", top: "10px", width: "10px", height: "10px",
    });
    fireEvent.scroll(screen.getByAltText("第 3 页"));
    fireEvent.pointerUp(screen.getByAltText("第 3 页"), { clientX: 20, clientY: 20 });
    await screen.findByText("已补画新块");
    expect(created).toBe(true);
    expect(screen.getByLabelText("块 b9")).toHaveStyle({ left: "1.6666666666666667%" });
    expect(screen.getByRole("button", { name: "删除选中块" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "补画新框" }));
    fireEvent.keyDown(screen.getByAltText("第 3 页"), { key: "Escape" });
    expect(screen.getByAltText("第 3 页")).not.toHaveClass("creating");
  });

  it("删除块：有复核行被 409 阻止，无复核行删除后刷新", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b2": () => jsonResponse({ error: "该块有复核记录，先处理复核行再删" }, 409),
      "/api/review/blocks/b1": () => jsonResponse({ ok: true }),
    });
    const onError = vi.fn();
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={onError} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getAllByRole("button", { name: "删除块" })[1]);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("该块有复核记录，先处理复核行再删"));
    fireEvent.click(screen.getAllByRole("button", { name: "删除块" })[0]);
    await screen.findByText("块已删除");
  });
});

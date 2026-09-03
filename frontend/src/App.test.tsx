import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse, sseResponse } from "./test/support";
import { App } from "./App";

afterEach(() => {
  vi.unstubAllGlobals();
});

const MODELS = [
  { provider: "chat", id: "qwen3:4b", name: "qwen3:4b" },
  { provider: "chat", id: "deepseek-v3", name: "deepseek-v3" },
];

function stubFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal("fetch", fetchRouter(routes));
}

describe("App 集成（会话侧栏 + 模型下拉 + 聊天流）", () => {
  it("挂载加载会话列表与模型下拉；点击历史会话回看消息", async () => {
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () =>
        jsonResponse([{ id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 }]),
      "/api/sessions/s1": () =>
        jsonResponse({
          title: "口算题",
          currentModel: "qwen3:4b",
          messages: [
            { role: "user", content: "第一问" },
            { role: "assistant", content: "第一答" },
          ],
        }),
    });
    render(<App />);
    // 侧栏出现历史会话
    await waitFor(() => expect(screen.getByText("口算题")).toBeInTheDocument());
    // 模型下拉加载，默认选中首个
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue("qwen3:4b"),
    );
    // 点击回看
    fireEvent.click(screen.getByText("口算题"));
    await waitFor(() => expect(screen.getByText("第一问")).toBeInTheDocument());
    expect(screen.getByText("第一答")).toBeInTheDocument();
    // 当前会话高亮
    expect(screen.getByText("口算题").closest("button")).toHaveClass("active");
  });

  it("完整链路：发消息 → session 事件 → 流式回复 → 侧栏出现新会话", async () => {
    let sessions: unknown[] = [];
    let chatBody: unknown = null;
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse(sessions),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        sessions = [{ id: "s-new", title: "小宝最近计算错得多吗", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 }];
        return sseResponse([
          'event: session\ndata: "s-new"\n\n',
          'event: delta\ndata: "还好"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue("qwen3:4b"),
    );
    fireEvent.change(screen.getByLabelText("输入问题"), {
      target: { value: "小宝最近计算错得多吗" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    // 用户消息 + 流式回复
    await waitFor(() => expect(screen.getByText("还好")).toBeInTheDocument());
    expect(chatBody).toMatchObject({ model: "qwen3:4b" });
    // 侧栏刷新出现新会话（标题 = 首条用户消息前 20 字）
    const sidebar = screen.getByRole("complementary");
    await waitFor(() => expect(within(sidebar).getByText("小宝最近计算错得多吗")).toBeInTheDocument());
    expect(within(sidebar).getByText("小宝最近计算错得多吗").closest("button")).toHaveClass("active");
  });

  it("「新对话」清空消息流与当前会话标记", async () => {
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () =>
        jsonResponse([{ id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 }]),
      "/api/sessions/s1": () =>
        jsonResponse({
          title: "口算题",
          currentModel: "qwen3:4b",
          messages: [{ role: "user", content: "第一问" }],
        }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("口算题")).toBeInTheDocument());
    fireEvent.click(screen.getByText("口算题"));
    await waitFor(() => expect(screen.getByText("第一问")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "＋ 新对话" }));
    await waitFor(() => expect(screen.queryByText("第一问")).toBeNull());
    // 侧栏项仍在但不再是当前会话
    expect(screen.getByText("口算题").closest("button")).not.toHaveClass("active");
    expect(screen.getByText("还没有对话——问孩子学习情况，或找题、看讲解。")).toBeInTheDocument();
  });

  it("流式期间 chat-wrap 标记 data-streaming，收尾后复位", async () => {
    const enc = new TextEncoder();
    let push: (e: string) => void = () => {};
    const stream = new ReadableStream({
      start(controller) {
        push = (e) => controller.enqueue(enc.encode(e));
      },
    });
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([]),
      "/api/chat": () => new Response(stream),
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue("qwen3:4b"),
    );
    fireEvent.change(screen.getByLabelText("输入问题"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    // 用户消息已上屏、流挂起中：标记为 true
    await waitFor(() => expect(screen.getByText("hi")).toBeInTheDocument());
    expect(document.querySelector(".chat-wrap")).toHaveAttribute("data-streaming", "true");
    // 流收尾：标记复位
    push('event: session\ndata: "s1"\n\n');
    push('event: delta\ndata: "好"\n\n');
    push("event: done\ndata: \n\n");
    await waitFor(() =>
      expect(document.querySelector(".chat-wrap")).toHaveAttribute("data-streaming", "false"),
    );
    expect(screen.getByText("好")).toBeInTheDocument();
  });

  it("切换模型 → 下一条消息请求携带新模型", async () => {
    let chatBody: unknown = null;
    stubFetch({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([]),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse(['event: session\ndata: "s1"\n\n', "event: done\ndata: \n\n"]);
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue("qwen3:4b"),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), {
      target: { value: "deepseek-v3" },
    });
    fireEvent.change(screen.getByLabelText("输入问题"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(chatBody).toMatchObject({ model: "deepseek-v3" }));
  });
});

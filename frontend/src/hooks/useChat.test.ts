import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse, sseResponse } from "../test/support";
import { useChat } from "./useChat";

const MODELS = [
  { provider: "chat", id: "qwen3:4b", name: "qwen3:4b" },
  { provider: "chat", id: "deepseek-v3", name: "deepseek-v3" },
];

const S1 = { id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 };

describe("useChat", () => {
  it("挂载时加载模型列表与会话列表，默认模型取首个（后端默认）", async () => {
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.models).toHaveLength(2));
    expect(result.current.model).toBe("qwen3:4b");
    expect(result.current.sessions).toEqual([S1]);
    expect(result.current.messages).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
  });

  it("send：请求携带当前模型；session 事件记录新会话 id；delta 流入；完成后刷新会话列表", async () => {
    let chatBody: unknown = null;
    let listCalls = 0;
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse(listCalls++ === 0 ? [] : [{ ...S1, id: "s-new", title: "你好" }]),
      "/api/chat": (_init) => {
        chatBody = JSON.parse(String(_init?.body));
        return sseResponse([
          'event: session\ndata: "s-new"\n\n',
          'event: delta\ndata: "你"\n\n',
          'event: delta\ndata: "好"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    act(() => result.current.send("hi"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "你好" },
    ]);
    expect(chatBody).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
      model: "qwen3:4b",
    });
    expect((chatBody as { session_id?: string }).session_id).toBeUndefined();
    expect(result.current.activeSessionId).toBe("s-new");
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(["s-new"]));
  });

  it("selectSession：加载回看消息 + 同步 currentModel 到模型下拉", async () => {
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () =>
        jsonResponse({
          title: "口算题",
          currentModel: "deepseek-v3",
          messages: [
            { role: "user", content: "问题" },
            { role: "assistant", content: "回答" },
          ],
        }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => {
      await result.current.selectSession("s1");
    });
    expect(result.current.messages).toEqual([
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答" },
    ]);
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.model).toBe("deepseek-v3");
  });

  it("newChat：清空消息与 session_id，保留模型选择", async () => {
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () =>
        jsonResponse({ title: "t", currentModel: "qwen3:4b", messages: [{ role: "user", content: "问题" }] }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => {
      await result.current.selectSession("s1");
    });
    act(() => result.current.newChat());
    expect(result.current.messages).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.model).toBe("qwen3:4b");
  });

  it("切换模型后发消息：请求携带新模型与当前会话 id", async () => {
    let chatBody: unknown = null;
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () =>
        jsonResponse({ title: "口算题", currentModel: "qwen3:4b", messages: [] }),
      "/api/chat": (_init) => {
        chatBody = JSON.parse(String(_init?.body));
        return sseResponse(['event: session\ndata: "s1"\n\n', "event: done\ndata: \n\n"]);
      },
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => {
      await result.current.selectSession("s1");
    });
    act(() => result.current.selectModel("deepseek-v3"));
    act(() => result.current.send("hi"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({ session_id: "s1", model: "deepseek-v3" });
  });

  it("流失败：错误文案追加到助手气泡，streaming 复位", async () => {
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([]),
      "/api/chat": () => sseResponse(["event: error\ndata: 服务内部错误，请稍后再试\n\n"]),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    act(() => result.current.send("hi"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(result.current.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "（出错了：服务内部错误，请稍后再试）" },
    ]);
  });
});

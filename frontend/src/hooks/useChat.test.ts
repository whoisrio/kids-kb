import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse, sseResponse } from "../test/support";
import { useChat } from "./useChat";

const MODELS = [
  { provider: "chat", id: "qwen3:4b", name: "qwen3:4b" },
  { provider: "chat", id: "deepseek-v3", name: "deepseek-v3" },
];
const S1 = { id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 };
const MAIN_LANE = [{ id: "main", forkEntryId: null, fromLaneId: null }];

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

  it("send：请求携带当前模型；session 事件记录新会话 id；delta 流入；完成后刷新详情", async () => {
    let chatBody: unknown = null;
    let listCalls = 0;
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse(listCalls++ === 0 ? [] : [{ ...S1, id: "s-new", title: "你好" }]),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s-new","lane_id":"main"}\n\n',
          'event: delta\ndata: "你"\n\n',
          'event: delta\ndata: "好"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
      "/api/sessions/s-new?lane=main": () => jsonResponse({
        title: "你好",
        currentModel: "qwen3:4b",
        currentLane: "main",
        lanes: MAIN_LANE,
        messages: [
          { role: "user", content: "hi", entryId: "e0" },
          { role: "assistant", content: "你好", entryId: "e1" },
        ],
      }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    act(() => result.current.send("hi"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({
      messages: [{ role: "user", content: "hi" }],
      model: "qwen3:4b",
    });
    expect((chatBody as { session_id?: string }).session_id).toBeUndefined();
    await waitFor(() => expect(result.current.activeSessionId).toBe("s-new"));
    await waitFor(() => expect(result.current.currentLane).toBe("main"));
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(["s-new"]));
  });

  it("selectSession：加载回看消息 + 同步 currentModel 到模型下拉", async () => {
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse({
        title: "口算题",
        currentModel: "deepseek-v3",
        currentLane: "main",
        lanes: MAIN_LANE,
        messages: [
          { role: "user", content: "问题", entryId: "e0" },
          { role: "assistant", content: "回答", entryId: "e1" },
        ],
      }),
      "/api/sessions/s1?lane=main": () => jsonResponse({
        title: "口算题",
        currentModel: "deepseek-v3",
        currentLane: "main",
        lanes: MAIN_LANE,
        messages: [
          { role: "user", content: "问题", entryId: "e0" },
          { role: "assistant", content: "回答", entryId: "e1" },
        ],
      }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    expect(result.current.messages).toMatchObject([
      { role: "user", content: "问题", entryId: "e0" },
      { role: "assistant", content: "回答", entryId: "e1" },
    ]);
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.model).toBe("deepseek-v3");
  });

  it("newChat：清空消息与 session_id，保留模型选择", async () => {
    const detail = {
      title: "t", currentModel: "qwen3:4b", currentLane: "main", lanes: MAIN_LANE,
      messages: [{ role: "user", content: "问题", entryId: "e0" }],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.newChat());
    expect(result.current.messages).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.model).toBe("qwen3:4b");
  });

  it("切换模型后发消息：请求携带新模型与当前会话 id", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "口算题", currentModel: "qwen3:4b", currentLane: "main", lanes: MAIN_LANE,
      messages: [],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse(['event: session\ndata: {"session_id":"s1","lane_id":"main"}\n\n', "event: done\ndata: \n\n"]);
      },
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
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

  it("编辑消息：请求带 branch_at=前一条 entryId，本地截断到编辑点", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "t", currentModel: "qwen3:4b", currentLane: "br-1",
      lanes: [
        { id: "main", forkEntryId: null, fromLaneId: null },
        { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
      ],
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s1","lane_id":"br-2"}\n\n',
          'event: delta\ndata: "新答"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
      "/api/sessions/s1?lane=br-2": () => jsonResponse({
        ...detail, currentLane: "br-2",
        lanes: [...detail.lanes, { id: "br-2", forkEntryId: "e1", fromLaneId: "br-1" }],
        messages: [
          { role: "user", content: "q1", entryId: "e0" },
          { role: "assistant", content: "a1", entryId: "e1" },
          { role: "user", content: "q1-改", entryId: "e2" },
          { role: "assistant", content: "新答", entryId: "e3" },
        ],
      }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.editMessage(0, "q1-改"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({ session_id: "s1", branch_at: null });
    await waitFor(() => expect(result.current.messages.map((m) => m.content)).toEqual(["q1", "a1", "q1-改", "新答"]));
    expect(result.current.currentLane).toBe("br-2");
  });

  it("rewind：截断显示 + 下一次发送在目标消息处开叉", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "t", currentModel: "m", currentLane: "main", lanes: MAIN_LANE,
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
        { role: "user", content: "q2", entryId: "e2" },
        { role: "assistant", content: "a2", entryId: "e3" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse(['event: session\ndata: {"session_id":"s1","lane_id":"br-1"}\n\n', "event: done\ndata: \n\n"]);
      },
      "/api/sessions/s1?lane=br-1": () => jsonResponse({ ...detail, currentLane: "br-1" }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.setRewind(1));
    expect(result.current.rewindTo).toEqual({ index: 1, entryId: "e1" });
    act(() => result.current.send("q3"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({ session_id: "s1", branch_at: "e1" });
    expect(result.current.rewindTo).toBeNull();
  });

  it("regenerate：在末条 assistant 的前一条（user 消息）处开叉", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "t", currentModel: "m", currentLane: "main", lanes: MAIN_LANE,
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s1","lane_id":"br-1"}\n\n',
          'event: delta\ndata: "a1\'"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
      "/api/sessions/s1?lane=br-1": () => jsonResponse({ ...detail, currentLane: "br-1" }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.regenerate());
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({
      session_id: "s1", branch_at: "e0",
      messages: [{ role: "user", content: "q1" }],
    });
  });

  it("selectLane：按分支重载路径与 lanes", async () => {
    const mainDetail = {
      title: "t", currentModel: "m", currentLane: "main",
      lanes: [
        { id: "main", forkEntryId: null, fromLaneId: null },
        { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
      ],
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ],
    };
    const brDetail = {
      ...mainDetail, currentLane: "br-1",
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
        { role: "user", content: "q2'", entryId: "e2" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(mainDetail),
      "/api/sessions/s1?lane=main": () => jsonResponse(mainDetail),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(brDetail),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    await act(async () => { await result.current.selectLane("br-1"); });
    expect(result.current.currentLane).toBe("br-1");
    expect(result.current.messages.map((m) => m.content)).toEqual(["q1", "a1", "q2'"]);
  });

  it("deleteSession：删除当前会话后回到新会话态", async () => {
    const detail = {
      title: "t", currentModel: "m", currentLane: "main", lanes: MAIN_LANE,
      messages: [{ role: "user", content: "q1", entryId: "e0" }],
    };
    let listCalls = 0;
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse(listCalls++ === 0 ? [S1] : []),
      "/api/sessions/s1": (init) => init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(detail),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    await act(async () => { await result.current.deleteSession("s1"); });
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.currentLane).toBe("main");
  });
});

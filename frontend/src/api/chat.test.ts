import { describe, expect, it } from "vitest";
import { deleteSession, fetchModels, fetchSessionDetail, fetchSessions, streamChat, type ChatStreamOptions } from "./chat";

function sseResponse(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchRouter(routes: Record<string, (init?: RequestInit) => Response>) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`Unexpected URL: ${String(input)}`);
    return route(init);
  };
}

describe("streamChat", () => {
  it("携带 session_id 与 model 请求体，session 事件回调新会话 id", async () => {
    const events = [
      'event: session\ndata: {"session_id":"sess-new","lane_id":"main"}\n\n',
      'event: delta\ndata: "你"\n\n',
      "event: done\ndata: \n\n",
    ];
    let capturedUrl = "";
    let capturedBody = "";
    const sessions: unknown[] = [];
    await streamChat(
      [{ role: "user", content: "hi" }],
      {
        onDelta: () => {},
        onDone: () => {},
        onSession: (id, lane) => sessions.push([id, lane]),
      },
      async (url, init) => {
        capturedUrl = String(url);
        capturedBody = String(init?.body);
        return new Response(sseResponse(events));
      },
      undefined,
      { sessionId: "sess-old", model: "qwen3:4b" },
    );
    expect(capturedUrl).toBe("/api/chat");
    expect(JSON.parse(capturedBody)).toEqual({
      messages: [{ role: "user", content: "hi" }],
      session_id: "sess-old",
      model: "qwen3:4b",
    });
    expect(sessions).toEqual([["sess-new", "main"]]);
  });

  it("未传 options 时请求体只有 messages（兼容无会话调用）", async () => {
    let capturedBody = "";
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => {} },
      async (_url, init) => {
        capturedBody = String(init?.body);
        return new Response(sseResponse(["event: done\ndata: \n\n"]));
      },
    );
    expect(JSON.parse(capturedBody)).toEqual({ messages: [{ role: "user", content: "hi" }] });
  });

  it("session 事件对象解析：onSession 收 (id, lane)", async () => {
    const seen: unknown[] = [];
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => {}, onSession: (id, lane) => seen.push([id, lane]) },
      fetchRouter({ "/api/chat": () => new Response(sseResponse([
        'event: session\ndata: {"session_id":"s-9","lane_id":"br-1"}\n\n',
        "event: done\ndata: \n\n",
      ])) }),
    );
    expect(seen).toEqual([["s-9", "br-1"]]);
  });

  it("thinking 事件流经 onThinking；请求带 lane_id/branch_at", async () => {
    let body: unknown = null;
    const thinkings: string[] = [];
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => {}, onThinking: (text) => thinkings.push(text) },
      fetchRouter({ "/api/chat": (init) => {
        body = JSON.parse(String(init?.body));
        return new Response(sseResponse([
          'event: session\ndata: {"session_id":"s-1","lane_id":"br-1"}\n\n',
          'event: thinking\ndata: "想"\n\n',
          "event: done\ndata: \n\n",
        ]));
      } }),
      undefined,
      { sessionId: "s-1", laneId: "br-1", branchAt: null },
    );
    expect(thinkings).toEqual(["想"]);
    expect(body).toMatchObject({ session_id: "s-1", lane_id: "br-1", branch_at: null });
  });

  it("branchAt: 'e1' 透传；未给则不带字段", async () => {
    const bodies: unknown[] = [];
    const run = (options: ChatStreamOptions) => streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => {} },
      fetchRouter({ "/api/chat": (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(sseResponse(["event: done\ndata: \n\n"]));
      } }),
      undefined,
      options,
    );
    await run({ branchAt: "e1" });
    await run({});
    expect(bodies[0]).toMatchObject({ branch_at: "e1" });
    expect("branch_at" in (bodies[1] as object)).toBe(false);
  });

  it("解析 delta 事件并回调，done 收尾", async () => {
    const events = [
      'event: delta\ndata: "你"\n\n',
      'event: delta\ndata: "好"\n\n',
      "event: done\ndata: \n\n",
    ];
    const deltas: string[] = [];
    let done = false;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => (done = true) },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toBe(true);
  });

  it("流提前结束（无 done/error 帧）→ onError 恰好一次，onDone 未调", async () => {
    const events = ['event: delta\ndata: "你"\n\n'];
    const deltas: string[] = [];
    let done = 0;
    let err = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => done++, onError: () => err++ },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual(["你"]);
    expect(done).toBe(0);
    expect(err).toBe(1);
  });

  it("fetchImpl reject → onError 恰好一次", async () => {
    let done = 0;
    let err = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => done++, onError: () => err++ },
      async () => {
        throw new Error("network down");
      },
    );
    expect(done).toBe(0);
    expect(err).toBe(1);
  });

  it("畸形 delta（data 不是合法 JSON）→ onError，后续帧不再处理", async () => {
    const events = [
      "event: delta\ndata: {oops\n\n",
      'event: delta\ndata: "后"\n\n',
      "event: done\ndata: \n\n",
    ];
    const deltas: string[] = [];
    let done = 0;
    let err = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => done++, onError: () => err++ },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual([]);
    expect(done).toBe(0);
    expect(err).toBe(1);
  });

  it("abort 后不触发任何回调", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => calls++, onDone: () => calls++, onError: () => calls++ },
      async () => new Response(sseResponse(['event: delta\ndata: "你"\n\n'])),
      ac.signal,
    );
    expect(calls).toBe(0);
  });
});

describe("fetchSessions", () => {
  it("GET /api/sessions → 会话摘要列表（modifiedAt 倒序由后端保证）", async () => {
    const list = [
      { id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 },
      { id: "s2", title: "英语语法", model: "deepseek-v3", createdAt: 3, modifiedAt: 4 },
    ];
    let capturedUrl = "";
    const sessions = await fetchSessions(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(list));
    });
    expect(capturedUrl).toBe("/api/sessions");
    expect(sessions).toEqual(list);
  });

  it("非 2xx → 抛错", async () => {
    await expect(
      fetchSessions(async () => new Response("boom", { status: 500 })),
    ).rejects.toThrow("请求失败: 500");
  });
});

describe("fetchSessionDetail", () => {
  it("GET /api/sessions/:id → title + currentModel + 按序消息", async () => {
    const detail = {
      title: "口算题",
      currentModel: "deepseek-v3",
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
    };
    let capturedUrl = "";
    const got = await fetchSessionDetail("s1", async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(detail));
    });
    expect(capturedUrl).toBe("/api/sessions/s1");
    expect(got).toEqual(detail);
  });

  it("非 2xx → 抛错", async () => {
    await expect(
      fetchSessionDetail("missing", async () => new Response("{}", { status: 404 })),
    ).rejects.toThrow("请求失败: 404");
  });

  it("GET /api/sessions/:id?lane=main → 读指定分支", async () => {
    let capturedUrl = "";
    await fetchSessionDetail("s1", async (url) => {
      capturedUrl = String(url);
      return jsonResponse({});
    }, "main");
    expect(capturedUrl).toBe("/api/sessions/s1?lane=main");
  });
});

describe("fetchModels", () => {
  it("GET /api/models → 模型列表（首个为后端默认模型）", async () => {
    const list = [
      { provider: "chat", id: "qwen3:4b", name: "qwen3:4b" },
      { provider: "chat", id: "deepseek-v3", name: "deepseek-v3" },
    ];
    let capturedUrl = "";
    const models = await fetchModels(async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(list));
    });
    expect(capturedUrl).toBe("/api/models");
    expect(models).toEqual(list);
  });

  it("非 2xx → 抛错", async () => {
    await expect(
      fetchModels(async () => new Response("boom", { status: 502 })),
    ).rejects.toThrow("请求失败: 502");
  });
});

describe("deleteSession", () => {
  it("DELETE /api/sessions/:id；404 返回 false", async () => {
    const fetchImpl = fetchRouter({
      "/api/sessions/s1": () => new Response(null, { status: 204 }),
      "/api/sessions/ghost": () => jsonResponse({ error: "会话不存在" }, 404),
    });
    expect(await deleteSession("s1", fetchImpl)).toBe(true);
    expect(await deleteSession("ghost", fetchImpl)).toBe(false);
  });
});

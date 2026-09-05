/** GET /api/sessions 列表 + GET /api/sessions/:id?lane= 回看。 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sessionsRoutes } from "./sessions.js";
import type { SessionHandle, SessionStore } from "../agent/sessions.js";

function makeStore(opts: {
  list?: Awaited<ReturnType<SessionStore["list"]>>;
  sessions?: Record<string, {
    title?: string; model?: string;
    messages?: { role: "user" | "assistant"; content: string; entryId?: string; thinking?: string }[];
    lanes?: { id: string; forkEntryId: string | null; fromLaneId: string | null }[];
  }>;
}): SessionStore {
  return {
    create: async () => { throw new Error("未使用"); },
    open: async (id): Promise<SessionHandle | null> => {
      const data = opts.sessions?.[id];
      if (!data) return null;
      const written: { lane?: string }[] = [];
      return {
        id,
        title: data.title ?? "",
        currentModel: async () => data.model ?? "",
        messages: async () => data.messages ?? [],
        appendMessage: async (_m, lane) => { written.push({ lane }); },
        markModelChange: async () => {},
        lanes: async () => data.lanes ?? [{ id: "main", forkEntryId: null, fromLaneId: null }],
        latestLane: async () => data.lanes?.at(-1)?.id ?? "main",
        forkAt: async () => "br-fake",
        laneExists: async (lane) => lane === "main" || (data.lanes ?? []).some((l) => l.id === lane),
        entryExists: async () => true,
        delete: async () => false,
        ...({ written } as Record<string, never>),
      } as unknown as SessionHandle;
    },
    list: async () => opts.list ?? [],
    delete: async () => false,
  };
}

function app(store: SessionStore) {
  const a = new Hono();
  a.route("/api/sessions", sessionsRoutes(store));
  return a;
}

describe("/api/sessions", () => {
  it("GET / 返回会话摘要列表（裸路径 /api/sessions 也命中）", async () => {
    const store = makeStore({
      list: [{ id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 }],
    });
    const a = app(store);
    const resp = await a.request("/api/sessions");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual([
      { id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 },
    ]);
    expect((await a.request("/api/sessions")).status).toBe(200);
  });

  it("GET /:id 无 lane 参数：currentLane=最新分支，响应含 lanes 与消息 entryId/thinking", async () => {
    const store = makeStore({
      sessions: {
        s1: {
          title: "口算题",
          model: "deepseek-v3",
          lanes: [
            { id: "main", forkEntryId: null, fromLaneId: null },
            { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
          ],
          messages: [
            { role: "user", content: "问题", entryId: "e0" },
            { role: "assistant", content: "回答", entryId: "e2", thinking: "想了想" },
          ],
        },
      },
    });
    const resp = await app(store).request("/api/sessions/s1");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      title: "口算题",
      currentModel: "deepseek-v3",
      currentLane: "br-1",
      lanes: [
        { id: "main", forkEntryId: null, fromLaneId: null },
        { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
      ],
      messages: [
        { role: "user", content: "问题", entryId: "e0" },
        { role: "assistant", content: "回答", entryId: "e2", thinking: "想了想" },
      ],
    });
  });

  it("GET /:id?lane=main：读指定分支", async () => {
    const store = makeStore({
      sessions: { s1: { title: "t", model: "m", messages: [{ role: "user", content: "主分支", entryId: "e0" }] } },
    });
    const resp = await app(store).request("/api/sessions/s1?lane=main");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.currentLane).toBe("main");
    expect(body.messages).toEqual([{ role: "user", content: "主分支", entryId: "e0" }]);
  });

  it("GET /:id?lane=不存在 → 404；GET /:id 不存在 → 404", async () => {
    const a = app(makeStore({ sessions: { s1: {} } }));
    expect((await a.request("/api/sessions/s1?lane=br-nope")).status).toBe(404);
    expect((await app(makeStore({})).request("/api/sessions/ghost")).status).toBe(404);
  });
});

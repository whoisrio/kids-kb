/** GET /api/sessions 列表 + GET /api/sessions/:id 回看。 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sessionsRoutes } from "./sessions.js";
import type { SessionHandle, SessionStore } from "../agent/sessions.js";

function makeStore(opts: {
  list?: Awaited<ReturnType<SessionStore["list"]>>;
  sessions?: Record<string, { title?: string; model?: string; messages: { role: "user" | "assistant"; content: string; entryId: string }[] }>;
}): SessionStore {
  return {
    create: async () => {
      throw new Error("未使用");
    },
    open: async (id): Promise<SessionHandle | null> => {
      const data = opts.sessions?.[id];
      if (!data) return null;
      return {
        id,
        title: data.title ?? "",
        currentModel: async () => data.model ?? "",
        messages: async () => data.messages,
        appendMessage: async () => {},
        markModelChange: async () => {},
        lanes: async () => [],
        latestLane: async () => "main",
        forkAt: async () => {
          throw new Error("未使用");
        },
        laneExists: async () => false,
        entryExists: async () => false,
      };
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
    // 钉住：裸路径（无尾斜杠）必须 200
    expect((await a.request("/api/sessions")).status).toBe(200);
  });

  it("GET /:id 返回按序消息 + title + currentModel（最新 model_change 为准）", async () => {
    const store = makeStore({
      sessions: {
        s1: {
          title: "口算题",
          model: "deepseek-v3",
          messages: [
            { role: "user", content: "问题", entryId: "m1" },
            { role: "assistant", content: "回答", entryId: "m2" },
          ],
        },
      },
    });
    const resp = await app(store).request("/api/sessions/s1");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      title: "口算题",
      currentModel: "deepseek-v3",
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
    });
  });

  it("GET /:id 不存在 → 404", async () => {
    const resp = await app(makeStore({})).request("/api/sessions/ghost");
    expect(resp.status).toBe(404);
  });
});

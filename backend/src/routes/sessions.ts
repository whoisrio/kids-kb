/** 历史会话 API：列表 + 回看。 */
import { Hono } from "hono";
import type { SessionStore } from "../agent/sessions.js";

export function sessionsRoutes(store: SessionStore) {
  const app = new Hono();
  app.get("/", async (c) => c.json(await store.list()));
  app.get("/:id", async (c) => {
    const handle = await store.open(c.req.param("id"));
    if (!handle) return c.json({ error: "会话不存在" }, 404);
    return c.json({ messages: await handle.messages() });
  });
  return app;
}

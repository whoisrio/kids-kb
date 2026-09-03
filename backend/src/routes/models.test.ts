/** GET /api/models：可切换的聊天模型列表。 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { modelsRoutes } from "./models.js";

describe("/api/models", () => {
  it("返回 chat provider 下的模型列表（裸路径 /api/models 也命中）", async () => {
    const app = new Hono();
    app.route("/api/models", modelsRoutes(["qwen3:4b", "deepseek-v3"]));
    const resp = await app.request("/api/models");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual([
      { provider: "chat", id: "qwen3:4b", name: "qwen3:4b" },
      { provider: "chat", id: "deepseek-v3", name: "deepseek-v3" },
    ]);
    // 钉住：裸路径（无尾斜杠）必须 200
    expect((await app.request("/api/models")).status).toBe(200);
  });
});

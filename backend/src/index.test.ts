import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

/** createApp 可注入任务依赖(测试不打真 pipeline)。 */
it("createApp 挂载试卷路由(未挂载时是 404 not found,挂载后是业务错误)", async () => {
  const app = createApp({
    databaseUrl: "postgresql://rio@localhost/kb",
    chatBaseUrl: "http://x", chatApiKey: "k", chatModel: "m", chatModels: ["m"],
    embedBaseUrl: "http://x", embedModel: "e", pipelineUrl: "http://x",
    rerankProvider: "none", port: 8787,
    storageRoot: "/tmp", matchThreshold: 0.88,
  }, {
    paperJobs: {
      pipelineUrl: "http://x", matchThreshold: 0.88,
      embed: async () => { throw new Error("no"); }, rerank: null,
    },
  });
  const resp = await app.request("/api/papers");
  // 不带真库时列表查询会抛错;只要路由挂上了,错误就不是 404 "not found" 文本
  expect([500, 200]).toContain(resp.status);
});

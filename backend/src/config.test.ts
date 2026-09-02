import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("CHAT_* 留空时回落 DOC_OGNIZE_*，再回落 KB_VISION_*", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      DOC_OGNIZE_BASE_URL: "https://api.example.com/v1",
      DOC_OGNIZE_API_KEY: "sk-x",
      DOC_OGNIZE_MODEL: "qwen3-32b",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatBaseUrl).toBe("https://api.example.com/v1");
    expect(cfg.chatModel).toBe("qwen3-32b");
    expect(cfg.embedBaseUrl).toBe("http://localhost:11434");
    expect(cfg.pipelineUrl).toBe("http://127.0.0.1:8766");
    expect(cfg.rerankProvider).toBe("local");
  });

  it("CHAT_* 优先", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_BASE_URL: "https://chat.example.com/v1",
      CHAT_API_KEY: "sk-c",
      CHAT_MODEL: "deepseek-v3",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatModel).toBe("deepseek-v3");
  });

  it("缺 KB_DATABASE_URL 直接抛错", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/KB_DATABASE_URL/);
  });
});

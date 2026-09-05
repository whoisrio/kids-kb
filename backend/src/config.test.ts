import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
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
    expect(cfg.chatModels).toEqual(["qwen3-32b"]);
  });

  it("空字符串视同未设置，照常回落", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_BASE_URL: "",
      CHAT_API_KEY: "",
      CHAT_MODEL: "",
      DOC_OGNIZE_BASE_URL: "https://api.example.com/v1",
      DOC_OGNIZE_API_KEY: "sk-x",
      DOC_OGNIZE_MODEL: "qwen3-32b",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatBaseUrl).toBe("https://api.example.com/v1");
    expect(cfg.chatApiKey).toBe("sk-x");
    expect(cfg.chatModel).toBe("qwen3-32b");
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

  it("CHAT_MODELS 逗号分隔注册多模型，去空白去空项", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_MODEL: "qwen3:4b",
      CHAT_MODELS: "qwen3:4b, deepseek-v3 ,,qwen3-32b",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatModels).toEqual(["qwen3:4b", "deepseek-v3", "qwen3-32b"]);
  });

  it("CHAT_MODELS 为空串视同未设置，缺省 [chatModel]", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_MODEL: "deepseek-v3",
      CHAT_MODELS: "",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatModels).toEqual(["deepseek-v3"]);
  });

  it("chatModels 是 chatModel 与 CHAT_MODELS 的并集（chatModel 永远在内）", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_MODEL: "qwen3:4b",
      CHAT_MODELS: "deepseek-v3,qwen3-32b",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatModels).toEqual(["qwen3:4b", "deepseek-v3", "qwen3-32b"]);
  });

  it("chatModels 重叠去重", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "postgresql://localhost/kb_test",
      CHAT_MODEL: "qwen3:4b",
      CHAT_MODELS: "qwen3:4b,deepseek-v3,deepseek-v3",
    } as NodeJS.ProcessEnv);
    expect(cfg.chatModels).toEqual(["qwen3:4b", "deepseek-v3"]);
  });
});

describe("试卷配置", () => {
  it("storageRoot 缺省指向仓库 pipeline/storage(相对本文件解析,不依赖 cwd)", () => {
    const cfg = loadConfig({ KB_DATABASE_URL: "postgresql://localhost/kb" } as NodeJS.ProcessEnv);
    expect(cfg.storageRoot).toBe(
      fileURLToPath(new URL("../../pipeline/storage", import.meta.url)),
    );
  });
  it("KB_STORAGE_ROOT 覆盖;matchThreshold 缺省 0.88 可覆盖", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "x",
      KB_STORAGE_ROOT: "/tmp/papers-root",
      KB_MATCH_THRESHOLD: "0.9",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.storageRoot).toBe("/tmp/papers-root");
    expect(cfg.matchThreshold).toBe(0.9);
  });
  it("matchThreshold 非法值回落默认", () => {
    const cfg = loadConfig({
      KB_DATABASE_URL: "x", KB_MATCH_THRESHOLD: "abc",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.matchThreshold).toBe(0.88);
  });
});

describe("KB_CHAT_THINKING", () => {
  const base = { KB_DATABASE_URL: "postgresql://localhost/kb" };
  it("缺省 medium；合法值透传；off 关闭；非法值报错", () => {
    expect(loadConfig({ ...base }).chatThinking).toBe("medium");
    expect(loadConfig({ ...base, KB_CHAT_THINKING: "high" }).chatThinking).toBe("high");
    expect(loadConfig({ ...base, KB_CHAT_THINKING: "off" }).chatThinking).toBe("off");
    expect(() => loadConfig({ ...base, KB_CHAT_THINKING: "bogus" })).toThrow(/KB_CHAT_THINKING/);
  });
});

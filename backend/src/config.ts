/** 集中配置：全部走环境变量，与 pipeline 侧 .env 习惯一致。 */
import "dotenv/config";

export interface BackendConfig {
  databaseUrl: string;
  chatBaseUrl: string;
  chatApiKey: string;
  chatModel: string;
  embedBaseUrl: string;
  embedModel: string;
  pipelineUrl: string;
  rerankProvider: "local" | "none";
  port: number;
}

/** 取第一个非空值：dotenv 把 `KEY=` 解析为空串，空串视同未设置。 */
function pick(...vals: (string | undefined)[]): string | undefined {
  return vals.find((v) => v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const databaseUrl = env.KB_DATABASE_URL;
  if (!databaseUrl) throw new Error("缺少 KB_DATABASE_URL（如 postgresql://localhost/kb）");
  const visionBase = pick(env.KB_VISION_BASE_URL) ?? "http://localhost:11434/v1";
  return {
    databaseUrl,
    chatBaseUrl: pick(env.CHAT_BASE_URL, env.DOC_OGNIZE_BASE_URL) ?? visionBase,
    chatApiKey:
      pick(env.CHAT_API_KEY, env.DOC_OGNIZE_API_KEY, env.KB_VISION_API_KEY) ?? "ollama",
    chatModel: pick(env.CHAT_MODEL, env.DOC_OGNIZE_MODEL, env.KB_VISION_MODEL) ?? "qwen3:4b",
    embedBaseUrl: pick(env.KB_EMBED_BASE_URL) ?? "http://localhost:11434",
    embedModel: pick(env.KB_EMBED_MODEL) ?? "bge-m3",
    pipelineUrl: pick(env.PIPELINE_INTERNAL_URL) ?? "http://127.0.0.1:8766",
    rerankProvider: env.RERANK_PROVIDER === "none" ? "none" : "local",
    port: Number(pick(env.BACKEND_PORT) ?? 8787),
  };
}

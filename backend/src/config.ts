/** 集中配置：全部走环境变量，与 pipeline 侧 .env 习惯一致。 */
import "dotenv/config";
import { resolve as pathResolve } from "node:path";

export interface BackendConfig {
  databaseUrl: string;
  chatBaseUrl: string;
  chatApiKey: string;
  chatModel: string;
  /** 可切换的聊天模型列表（CHAT_MODELS 逗号分隔；缺省 [chatModel]）。 */
  chatModels: string[];
  embedBaseUrl: string;
  embedModel: string;
  pipelineUrl: string;
  rerankProvider: "local" | "none";
  port: number;
  /** pipeline 侧 storage 根(试卷页图/题图回传用)。 */
  storageRoot: string;
  /** 题库自动匹配阈值(余弦相似度)。 */
  matchThreshold: number;
}

/** 取第一个非空值：dotenv 把 `KEY=` 解析为空串，空串视同未设置。 */
function pick(...vals: (string | undefined)[]): string | undefined {
  return vals.find((v) => v);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  const databaseUrl = env.KB_DATABASE_URL;
  if (!databaseUrl) throw new Error("缺少 KB_DATABASE_URL（如 postgresql://localhost/kb）");
  const visionBase = pick(env.KB_VISION_BASE_URL) ?? "http://localhost:11434/v1";
  const chatModel = pick(env.CHAT_MODEL, env.DOC_OGNIZE_MODEL, env.KB_VISION_MODEL) ?? "qwen3:4b";
  const envModels = pick(env.CHAT_MODELS)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    databaseUrl,
    chatBaseUrl: pick(env.CHAT_BASE_URL, env.DOC_OGNIZE_BASE_URL) ?? visionBase,
    chatApiKey:
      pick(env.CHAT_API_KEY, env.DOC_OGNIZE_API_KEY, env.KB_VISION_API_KEY) ?? "ollama",
    chatModel,
    // chatModel 永远在可切换列表内（并集去重，chatModel 排首位）
    chatModels: [...new Set([chatModel, ...(envModels ?? [])])],
    embedBaseUrl: pick(env.KB_EMBED_BASE_URL) ?? "http://localhost:11434",
    embedModel: pick(env.KB_EMBED_MODEL) ?? "bge-m3",
    pipelineUrl: pick(env.PIPELINE_INTERNAL_URL) ?? "http://127.0.0.1:8766",
    rerankProvider: env.RERANK_PROVIDER === "none" ? "none" : "local",
    port: Number(pick(env.BACKEND_PORT) ?? 8787),
    // 试卷页图/题图在 pipeline/storage 下;默认同仓部署,可 env 覆盖
    storageRoot: pick(env.KB_STORAGE_ROOT) ?? pathResolve("../pipeline/storage"),
    matchThreshold: (() => {
      const v = Number(pick(env.KB_MATCH_THRESHOLD));
      return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.88;
    })(),
  };
}

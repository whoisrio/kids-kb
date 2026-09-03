/** /api/chat：pi-agent 驱动的 SSE 聊天。token 消耗写 llm_calls（modality='text'）。 */
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, type Model, type Usage } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type pg from "pg";
import type { BackendConfig } from "../config.js";
import { makeTools } from "./tools.js";
import type { SearchHit } from "../retrieval/search.js";
import type { SessionHandle, SessionStore } from "./sessions.js";

const SYSTEM_PROMPT = `你是家庭学习助手。家长会上传孩子的学习资料和试卷，你基于题库和孩子的做题记录回答问题。
规则：题目内容必须来自检索结果，引用时给出来源（书名·章节·题号）；不知道就说不知道，不要编题。
数学内容用 LaTeX（行内 $...$）。回答简洁、口语化，对家长说话。`;

/** 给客户端的错误统一用这句，内部细节（报错原文/堆栈/地址）只进服务端日志。 */
const CLIENT_ERROR_MSG = "服务内部错误，请稍后再试";

export interface AgentLike {
  subscribe: (fn: (event: any) => void | Promise<void>) => () => void;
  prompt: (text: string) => Promise<void>;
  abort?: () => void;
}
/** model 为裸 model id；缺省用配置默认模型。未知 id 抛错（路由层转 400）。 */
export type AgentFactory = (messages: { role: string; content: string }[], model?: string) => AgentLike;

/** 客户端历史消息 → AgentMessage：assistant 历史需补齐 pi-ai 完整字段。
    role 只认 user/assistant（路由层已校验，这里兜底防静默归一）。 */
function toAgentMessages(
  messages: { role: string; content: string }[],
  model: Model<"openai-completions">,
): AgentMessage[] {
  const zeroUsage: Usage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return messages.map((m): AgentMessage => {
    const timestamp = Date.now();
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage,
        stopReason: "stop",
        timestamp,
      };
    }
    if (m.role === "user") return { role: "user", content: m.content, timestamp };
    throw new Error(`不支持的消息角色: ${m.role}`);
  });
}

export function makeAgentFactory(
  cfg: BackendConfig,
  pool: pg.Pool,
  search: (q: string, f?: Record<string, string>) => Promise<SearchHit[]>,
): AgentFactory {
  const makeModel = (id: string): Model<"openai-completions"> => ({
    id,
    name: id,
    api: "openai-completions",
    provider: "chat",
    baseUrl: cfg.chatBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  });
  // 同一 provider 下注册全部可切换模型（cfg.chatModels）
  const byId = new Map(cfg.chatModels.map((id) => [id, makeModel(id)] as const));
  const models = createModels();
  models.setProvider(createProvider({
    id: "chat",
    name: "chat",
    baseUrl: cfg.chatBaseUrl,
    auth: { apiKey: { name: "chat", resolve: async () => ({ auth: { apiKey: cfg.chatApiKey } }) } },
    models: [...byId.values()],
    api: openAICompletionsApi(),
  }));
  const tools = makeTools({ pool, search });

  return (messages, modelId) => {
    const model = byId.get(modelId ?? cfg.chatModel);
    if (!model) throw new Error(`未知模型: ${modelId}`);
    return new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        tools,
        messages: toAgentMessages(messages, model),
      },
      streamFn: models.streamSimple.bind(models),
    });
  };
}

interface ChatMessage {
  role: string;
  content: string;
}

/** 入参校验：返回错误文案或 null。 */
function validateMessages(body: unknown): { messages: ChatMessage[] } | { error: string } {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { error: "messages 不能为空" };
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return { error: "messages 元素须为 { role: 'user' | 'assistant', content: string }" };
    }
  }
  if (messages[messages.length - 1].role !== "user") {
    return { error: "最后一条消息必须是 user" };
  }
  return { messages: messages as ChatMessage[] };
}

/** agent_end 的 messages 里末条 assistant 若 stopReason=error / 带 errorMessage，则本次 LLM 调用失败
    （pi-agent-core 的 runWithLifecycle 吞内部异常后照常发 agent_end，失败信息只在最终消息上）。 */
function findFailedAssistant(messages: any[]): any | undefined {
  if (!Array.isArray(messages)) return undefined;
  return [...messages].reverse().find(
    (m) => m?.role === "assistant" && (m.stopReason === "error" || m.errorMessage),
  );
}

export interface ChatDeps {
  /** 计量回调：usage + 本轮实际使用的模型 id。 */
  onUsage?: (usage: { input: number; output: number }, model: string) => Promise<void>;
  /** 会话持久化；缺省退化为无状态单次问答（旧行为）。 */
  store?: SessionStore;
  /** 默认模型 id（创建会话/计量的兜底）。 */
  defaultModel?: string;
}

export function chatRoute(
  factory: AgentFactory,
  deps: ChatDeps = {},
) {
  return async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是合法 JSON" }, 400);
    }
    const parsed = validateMessages(body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { messages } = parsed;
    const sessionIdRaw = (body as { session_id?: unknown }).session_id;
    if (sessionIdRaw !== undefined && typeof sessionIdRaw !== "string") {
      return c.json({ error: "session_id 须为字符串" }, 400);
    }
    const modelRaw = (body as { model?: unknown }).model;
    if (modelRaw !== undefined && (typeof modelRaw !== "string" || !modelRaw)) {
      return c.json({ error: "model 须为非空字符串" }, 400);
    }
    const last = messages[messages.length - 1];
    let history: ChatMessage[] = messages.slice(0, -1);
    let requestedModel = modelRaw as string | undefined;

    // 会话恢复/创建必须在 streamSSE 之前完成（404/校验前置，session 事件要是首帧）
    let handle: SessionHandle | null = null;
    if (deps.store) {
      try {
        if (sessionIdRaw) {
          handle = await deps.store.open(sessionIdRaw);
          if (!handle) return c.json({ error: "会话不存在" }, 404);
          // 服务端历史权威：忽略客户端夹带的旧消息
          history = await handle.messages();
          const current = await handle.currentModel();
          if (requestedModel && requestedModel !== current) {
            await handle.markModelChange(requestedModel);
          }
          requestedModel ??= current;
        } else {
          const firstUser = messages.find((m) => m.role === "user")!;
          const model = requestedModel ?? deps.defaultModel ?? "";
          handle = await deps.store.create({ title: firstUser.content.slice(0, 20), model });
          requestedModel ??= deps.defaultModel;
        }
      } catch (err) {
        console.error("会话存取失败", err);
        return c.json({ error: CLIENT_ERROR_MSG }, 500);
      }
    }

    let agent: AgentLike;
    try {
      agent = factory(history, requestedModel);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "未知模型" }, 400);
    }
    const usageModel = requestedModel ?? deps.defaultModel ?? "";

    return streamSSE(c, async (stream) => {
      if (handle) await stream.writeSSE({ event: "session", data: JSON.stringify(handle.id) });
      stream.onAbort(() => agent.abort?.());
      let usage = { input: 0, output: 0 };
      // done/error 只发一次（agent_end 可能因订阅者异常被重发；onUsage 失败不许反噬收尾）
      let settled = false;
      const settle = async (failed: boolean) => {
        if (settled) return;
        settled = true;
        if (deps.onUsage && (usage.input || usage.output)) {
          try {
            await deps.onUsage(usage, usageModel);
          } catch (err) {
            console.error("token 计量写入失败", err);
          }
        }
        await stream.writeSSE(failed
          ? { event: "error", data: CLIENT_ERROR_MSG }
          : { event: "done", data: "" });
      };
      agent.subscribe(async (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          await stream.writeSSE({ event: "delta", data: JSON.stringify(event.assistantMessageEvent.delta) });
        }
        if (event.type === "message_end") {
          const msg = event.message;
          // user 与 assistant 的最终消息都落盘（toolResult 不进会话历史）；落盘失败不反噬流
          if (handle && (msg?.role === "user" || msg?.role === "assistant")) {
            try {
              await handle.appendMessage(msg);
            } catch (err) {
              console.error("会话消息落盘失败", err);
            }
          }
          if (msg?.role === "assistant" && msg.usage) {
            usage.input += msg.usage.input ?? 0;
            usage.output += msg.usage.output ?? 0;
          }
        }
        if (event.type === "agent_end") {
          const failedMsg = findFailedAssistant(event.messages);
          if (failedMsg) console.error("LLM 调用失败", failedMsg.errorMessage ?? failedMsg.stopReason);
          await settle(Boolean(failedMsg));
        }
      });
      try {
        await agent.prompt(last.content);
      } catch (err) {
        console.error("agent.prompt 异常", err);
        await settle(true);
      }
    });
  };
}

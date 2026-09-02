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
export type AgentFactory = (messages: { role: string; content: string }[]) => AgentLike;

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
  const model: Model<"openai-completions"> = {
    id: cfg.chatModel,
    name: cfg.chatModel,
    api: "openai-completions",
    provider: "chat",
    baseUrl: cfg.chatBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };
  const models = createModels();
  models.setProvider(createProvider({
    id: "chat",
    name: "chat",
    baseUrl: cfg.chatBaseUrl,
    auth: { apiKey: { name: "chat", resolve: async () => ({ auth: { apiKey: cfg.chatApiKey } }) } },
    models: [model],
    api: openAICompletionsApi(),
  }));
  const tools = makeTools({ pool, search });

  return (messages) => new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages: toAgentMessages(messages, model),
    },
    streamFn: models.streamSimple.bind(models),
  });
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

export function chatRoute(
  factory: AgentFactory,
  onUsage?: (usage: { input: number; output: number }) => Promise<void>,
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
    const last = messages[messages.length - 1];
    const history = messages.slice(0, -1);
    const agent = factory(history);

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => agent.abort?.());
      let usage = { input: 0, output: 0 };
      // done/error 只发一次（agent_end 可能因订阅者异常被重发；onUsage 失败不许反噬收尾）
      let settled = false;
      const settle = async (failed: boolean) => {
        if (settled) return;
        settled = true;
        if (onUsage && (usage.input || usage.output)) {
          try {
            await onUsage(usage);
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
        if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
          usage.input += event.message.usage.input ?? 0;
          usage.output += event.message.usage.output ?? 0;
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

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

export interface AgentLike {
  subscribe: (fn: (event: any) => void | Promise<void>) => () => void;
  prompt: (text: string) => Promise<void>;
}
export type AgentFactory = (messages: { role: string; content: string }[]) => AgentLike;

/** 客户端历史消息 → AgentMessage：assistant 历史需补齐 pi-ai 完整字段。 */
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
    return { role: "user", content: m.content, timestamp };
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

export function chatRoute(
  factory: AgentFactory,
  onUsage?: (usage: { input: number; output: number }) => Promise<void>,
) {
  return (c: Context) => {
    return streamSSE(c, async (stream) => {
      const { messages } = await c.req.json();
      if (!Array.isArray(messages) || messages.length === 0) {
        await stream.writeSSE({ event: "error", data: "messages 不能为空" });
        return;
      }
      const last = messages[messages.length - 1];
      const history = messages.slice(0, -1);
      const agent = factory(history);
      let usage = { input: 0, output: 0 };
      agent.subscribe(async (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          await stream.writeSSE({ event: "delta", data: JSON.stringify(event.assistantMessageEvent.delta) });
        }
        if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
          usage.input += event.message.usage.input ?? 0;
          usage.output += event.message.usage.output ?? 0;
        }
        if (event.type === "agent_end") {
          if (onUsage && (usage.input || usage.output)) await onUsage(usage);
          await stream.writeSSE({ event: "done", data: "" });
        }
      });
      try {
        await agent.prompt(last.content);
      } catch (err) {
        await stream.writeSSE({ event: "error", data: String(err) });
      }
    });
  };
}

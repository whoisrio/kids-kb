/** 一次性非流式文本调用 helper：直接打 OpenAI 兼容的 chat/completions。
    模型默认 chatModels[0]；thinking 档位映射为 reasoning_effort（不支持的兼容端点会忽略）。 */
import type { BackendConfig } from "./config.js";

export interface CallTextArgs {
  system: string;
  user: string;
  model?: string;
}

export interface CallTextResult {
  text: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export type CallTextFn = (args: CallTextArgs) => Promise<CallTextResult>;

/** KB_CHAT_THINKING（off|minimal|...|max）→ OpenAI reasoning_effort。 */
function reasoningEffort(t: BackendConfig["chatThinking"]): string {
  if (t === "off") return "none";
  if (t === "max") return "xhigh";
  return t;
}

export function makeCallText(cfg: BackendConfig): CallTextFn {
  return async ({ system, user, model }) => {
    const useModel = model ?? cfg.chatModels[0] ?? cfg.chatModel;
    const resp = await fetch(`${cfg.chatBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.chatApiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        reasoning_effort: reasoningEffort(cfg.chatThinking),
      }),
    });
    if (!resp.ok) {
      throw new Error(`chat/completions 返回 ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("chat/completions 响应缺少 choices[0].message.content");
    }
    return {
      text,
      model: useModel,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
      },
    };
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  modifiedAt: number;
}

export interface SessionDetail {
  title: string;
  currentModel: string;
  messages: ChatMessage[];
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (message: string) => void;
  /** 首帧 session 事件：后端回传会话 id（新会话/既有会话均会发）。 */
  onSession?: (id: string) => void;
}

export interface ChatStreamOptions {
  /** 会话 id；缺省 = 新会话（由后端创建并经 session 事件回传）。 */
  sessionId?: string;
  /** 本轮使用的模型 id；缺省沿用会话当前模型/后端默认。 */
  model?: string;
}

type FetchLike = typeof fetch;

export async function streamChat(
  messages: ChatMessage[],
  handlers: ChatHandlers,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  options: ChatStreamOptions = {},
): Promise<void> {
  // 恰好一次收尾：正常收到 done → onDone；其余所有终止路径 → onError。
  let settled = false;
  const finishDone = () => {
    if (settled) return;
    settled = true;
    handlers.onDone();
  };
  const finishError = (message: string) => {
    if (settled) return;
    settled = true;
    handlers.onError?.(message);
  };

  try {
    const body: { messages: ChatMessage[]; session_id?: string; model?: string } = { messages };
    if (options.sessionId) body.session_id = options.sessionId;
    if (options.model) body.model = options.model;
    const resp = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
    if (!resp.ok || !resp.body) {
      finishError(`请求失败: ${resp.status}`);
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      // 调用方主动 abort：调用方自己知道，不触发任何回调
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.*)$/m)?.[1] ?? "";
        if (event === "session") {
          let id: string;
          try {
            id = JSON.parse(data);
          } catch {
            finishError("响应解析失败");
            return;
          }
          handlers.onSession?.(id);
        }
        if (event === "delta") {
          let text: string;
          try {
            text = JSON.parse(data);
          } catch {
            finishError("响应解析失败");
            return;
          }
          handlers.onDelta(text);
        }
        if (event === "done") {
          finishDone();
          return;
        }
        if (event === "error") {
          finishError(data);
          return;
        }
      }
    }
    // 流结束但没收到 done/error 帧：断网、代理重启等
    finishError("连接中断：流提前结束");
  } catch (err) {
    // abort 导致的 reject（AbortError）不算错误，静默结束
    if (signal?.aborted) return;
    finishError(err instanceof Error ? err.message : String(err));
  }
}

async function getJson<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
  return (await resp.json()) as T;
}

/** GET /api/sessions：历史会话摘要（modifiedAt 倒序）。 */
export function fetchSessions(fetchImpl: FetchLike = fetch): Promise<SessionSummary[]> {
  return getJson("/api/sessions", fetchImpl);
}

/** GET /api/sessions/:id：会话回看（title + 当前模型 + 按序消息）。 */
export function fetchSessionDetail(id: string, fetchImpl: FetchLike = fetch): Promise<SessionDetail> {
  return getJson(`/api/sessions/${encodeURIComponent(id)}`, fetchImpl);
}

/** GET /api/models：可切换模型列表（首个为后端默认模型）。 */
export function fetchModels(fetchImpl: FetchLike = fetch): Promise<ModelInfo[]> {
  return getJson("/api/models", fetchImpl);
}

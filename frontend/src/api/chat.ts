export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (message: string) => void;
}

type FetchLike = typeof fetch;

export async function streamChat(
  messages: ChatMessage[],
  handlers: ChatHandlers,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
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
    const resp = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
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

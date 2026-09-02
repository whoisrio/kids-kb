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
): Promise<void> {
  const resp = await fetchImpl("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!resp.ok || !resp.body) {
    handlers.onError?.(`请求失败: ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1] ?? "";
      if (event === "delta") handlers.onDelta(JSON.parse(data));
      if (event === "done") handlers.onDone();
      if (event === "error") handlers.onError?.(data);
    }
  }
}

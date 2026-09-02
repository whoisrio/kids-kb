import { useState } from "react";
import { streamChat, type ChatMessage } from "../api/chat";
import { Composer } from "../components/Composer";
import { MessageBubble } from "../components/MessageBubble";

const CHIPS = [
  "把本周错题整理成一张复习卷",
  "朵朵的英语语法错因分布",
  "《7星学霸》第 3 讲有哪些例题",
];

export function ChatView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);

  const appendToLast = (text: string) =>
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, content: last.content + text };
      return copy;
    });

  const send = () => {
    const content = input.trim();
    if (!content || streaming) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    void streamChat(next, {
      onDelta: appendToLast,
      onDone: () => setStreaming(false),
      onError: (message) => {
        appendToLast(`（出错了：${message}）`);
        setStreaming(false);
      },
    });
  };

  return (
    <>
      <div className="chat-wrap">
        <div className="chat-log">
          {messages.length === 0 && (
            <div className="chat-empty">还没有对话——问孩子学习情况，或找题、看讲解。</div>
          )}
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
        </div>
        <div className="chips">
          {CHIPS.map((c) => (
            <button key={c} onClick={() => setInput(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <Composer value={input} onChange={setInput} onSend={send} disabled={streaming} />
    </>
  );
}

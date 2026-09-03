import { useState } from "react";
import type { ChatMessage } from "../api/chat";
import { Composer } from "../components/Composer";
import { MessageBubble } from "../components/MessageBubble";

const CHIPS = [
  "把本周错题整理成一张复习卷",
  "朵朵的英语语法错因分布",
  "《7星学霸》第 3 讲有哪些例题",
];

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (content: string) => void;
}

export function ChatView({ messages, streaming, onSend }: ChatViewProps) {
  const [input, setInput] = useState("");

  const send = () => {
    const content = input.trim();
    if (!content || streaming) return;
    onSend(content);
    setInput("");
  };

  return (
    <>
      <div className="chat-wrap" data-streaming={streaming ? "true" : "false"}>
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

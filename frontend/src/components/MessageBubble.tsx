import type { ChatMessage } from "../api/chat";
import { renderRichText } from "../lib/katex";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`msg ${isUser ? "user" : "agent"}`}>
      <div className="avatar">{isUser ? "我" : "答"}</div>
      <div>
        <div className="who">{isUser ? "我" : "学习助手"}</div>
        {isUser ? (
          <div className="bubble">{message.content}</div>
        ) : (
          <div
            className="bubble"
            dangerouslySetInnerHTML={{ __html: renderRichText(message.content) }}
          />
        )}
      </div>
    </div>
  );
}

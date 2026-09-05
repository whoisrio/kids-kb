import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { ChatMessage } from "../api/chat";

export interface BubbleActions {
  onEdit?: (index: number, content: string) => void;
  onRewind?: (index: number) => void;
  onRegenerate?: () => void;
  onCopy?: (message: ChatMessage) => void;
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

interface MessageBubbleProps {
  message: ChatMessage;
  index: number;
  isLast: boolean;
  streaming: boolean;
  actions?: BubbleActions;
  switcher?: ReactNode;
}

export function MessageBubble({ message, index, isLast, streaming, actions, switcher }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const thinkingOpen = manualOpen ?? (isLast && streaming && message.content === "" && !!message.thinking);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const saveEdit = () => {
    setEditing(false);
    if (draft.trim() && draft !== message.content) actions?.onEdit?.(index, draft.trim());
  };

  return (
    <div className={`msg ${isUser ? "user" : "agent"}`}>
      <div className="avatar">{isUser ? "我" : "答"}</div>
      <div className="msg-main">
        <div className="who">
          {isUser ? "我" : "学习助手"}
          {switcher}
        </div>
        {message.thinking && (
          <div className={`thinking${thinkingOpen ? " open" : ""}`} data-thinking-open={thinkingOpen}>
            <button className="thinking-head" onClick={() => setManualOpen(!thinkingOpen)}>
              💭 思考过程
            </button>
            {thinkingOpen && <div className="thinking-body">{message.thinking}</div>}
          </div>
        )}
        {isUser ? (
          editing ? (
            <div className="edit-box">
              <textarea aria-label="编辑消息" value={draft} onChange={(event) => setDraft(event.target.value)} />
              <div className="edit-actions">
                <button className="primary" onClick={saveEdit}>保存</button>
                <button className="ghost" onClick={() => setEditing(false)}>取消</button>
              </div>
            </div>
          ) : (
            <div className="bubble">{message.content}</div>
          )
        ) : (
          <div className="bubble"><Markdown text={message.content} /></div>
        )}
        {message.entryId && !editing && (
          <div className="msg-actions">
            <button title="复制" onClick={() => actions?.onCopy?.(message)}>复制</button>
            {isUser && actions?.onEdit && <button onClick={startEdit}>编辑</button>}
            {actions?.onRewind && <button onClick={() => actions.onRewind!(index)}>回到这</button>}
            {actions?.onRegenerate && <button onClick={() => actions.onRegenerate!()}>重新生成</button>}
          </div>
        )}
      </div>
    </div>
  );
}

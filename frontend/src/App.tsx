import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./components/ModelPicker";
import { Rail } from "./components/Rail";
import { SessionsSidebar } from "./components/SessionsSidebar";
import { useChat } from "./hooks/useChat";
import { ChatView } from "./views/ChatView";
import { ReviewView } from "./views/ReviewView";
import { StatsView } from "./views/StatsView";
import { UsageView } from "./views/UsageView";
import type { ChatMessage } from "./api/chat";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function today(): string {
  const date = new Date();
  const ymd = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
  return `${ymd} ${WEEKDAYS[date.getDay()]}`;
}

function transcript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `## ${message.role === "user" ? "我" : "学习助手"}\n\n${message.content}`)
    .join("\n\n");
}

export function App() {
  const [view, setView] = useState<"chat" | "review" | "stats" | "usage">("chat");
  const [children, setChildren] = useState<{ id: string; name: string; grade: string | null }[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chat = useChat();

  useEffect(() => {
    fetch("/api/children")
      .then((response) => response.json())
      .then((data: { children?: { id: string; name: string; grade: string | null }[] }) => {
        const list = Array.isArray(data?.children) ? data.children : [];
        setChildren(list);
        setChildId((current) => current ?? list[0]?.id ?? null);
      })
      .catch(() => {});
  }, []);

  const selectedChild = children.find((child) => child.id === childId) ?? null;
  const kidSwitch = (
    <div className="kid-switch">
      {children.map((child) => (
        <button
          key={child.id}
          className={childId === child.id ? "on" : ""}
          onClick={() => setChildId(child.id)}
        >
          {child.name}
        </button>
      ))}
    </div>
  );

  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const copyAll = async () => {
    if (!chat.messages.length) return;
    try {
      await navigator.clipboard.writeText(transcript(chat.messages));
      showToast("已复制全文");
    } catch {
      showToast("复制失败");
    }
  };

  return (
    <div className="app">
      <Rail
        activeView={view}
        onSelect={setView}
        kidChip={selectedChild ? `${selectedChild.name} · ${selectedChild.grade ?? ""}` : undefined}
      />
      {view === "chat" && (
        <SessionsSidebar
          sessions={chat.sessions}
          activeId={chat.activeSessionId}
          onSelect={(id) => void chat.selectSession(id)}
          onNew={chat.newChat}
          onDelete={setConfirmDelete}
        />
      )}
      <main>
        <div className="topbar">
          <div>
            <span className="date">{today()}</span>
            <h1>{{
              chat: "聊天",
              review: "复核",
              stats: "统计",
              usage: "用量",
            }[view]}</h1>
          </div>
          {view === "chat" ? (
            <>
              <span className="hint">问孩子学习情况，或找题、看讲解</span>
              {chat.activeSessionId && (
                <button className="ghost" onClick={() => void copyAll()}>复制全文</button>
              )}
              <ModelPicker models={chat.models} value={chat.model} onChange={chat.selectModel} />
              {kidSwitch}
            </>
          ) : view === "stats" ? (
            <>
              <span className="hint">错题、错因与订正</span>
              {kidSwitch}
            </>
          ) : view === "usage" ? (
            <span className="hint">模型 token 消耗与调用流水</span>
          ) : (
            <span className="hint">确认试卷对错与题库匹配</span>
          )}
        </div>
        {view === "chat"
          ? <ChatView
              messages={chat.messages}
              streaming={chat.streaming}
              lanes={chat.lanes}
              currentLane={chat.currentLane}
              rewindTo={chat.rewindTo}
              onSend={chat.send}
              onEdit={chat.editMessage}
              onRewind={chat.setRewind}
              onCancelRewind={chat.cancelRewind}
              onRegenerate={chat.regenerate}
              onSwitchLane={(lane) => void chat.selectLane(lane)}
              onToast={showToast}
            />
          : view === "review"
            ? <ReviewView />
            : view === "stats"
              ? <StatsView childId={childId} onToast={showToast} />
              : <UsageView />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
      {confirmDelete && (
        <div className="dialog-mask" role="dialog" aria-label="删除会话">
          <div className="dialog">
            <p>删除这个会话？删除后不可恢复。</p>
            <div className="dialog-actions">
              <button className="danger" onClick={() => {
                void chat.deleteSession(confirmDelete);
                setConfirmDelete(null);
              }}>删除</button>
              <button className="ghost" onClick={() => setConfirmDelete(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

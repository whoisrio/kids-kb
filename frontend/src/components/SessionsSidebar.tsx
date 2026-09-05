import type { SessionSummary } from "../api/chat";

/** MM-DD HH:mm（本地时区；列表按天粒度足够，跨年也保留月日即可）。 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface SessionsSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function SessionsSidebar({ sessions, activeId, onSelect, onNew, onDelete }: SessionsSidebarProps) {
  return (
    <aside className="sessions">
      <div className="head">
        <span className="label">历史会话</span>
        <button className="new-btn" onClick={onNew}>
          ＋ 新对话
        </button>
      </div>
      <div className="list">
        {sessions.length === 0 && <div className="empty">还没有历史会话</div>}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`session-item${s.id === activeId ? " active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="t">{s.title || "（未命名）"}</span>
            <span className="m">
              <span className="model">{s.model}</span>
              <span>{formatTime(s.modifiedAt)}</span>
              <span
                className="del"
                role="button"
                aria-label={`删除会话 ${s.title}`}
                onClick={(event) => { event.stopPropagation(); onDelete(s.id); }}
              >🗑</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

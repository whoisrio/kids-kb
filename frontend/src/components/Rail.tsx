interface RailProps {
  activeView: "chat" | "review";
  onSelect: (view: "chat" | "review") => void;
}

export function Rail({ activeView, onSelect }: RailProps) {
  return (
    <nav className="rail">
      <div className="brand">
        <span className="logo">
          知
          <svg viewBox="0 0 48 48">
            <path
              d="M8 24 C8 12, 40 10, 41 23 C42 36, 12 40, 8 27"
              fill="none"
              stroke="#E03C28"
              strokeWidth="2.2"
              strokeLinecap="round"
              opacity=".9"
            />
          </svg>
        </span>
        <span>
          <div className="name">作业本</div>
          <div className="sub">家庭学习知识库</div>
        </span>
      </div>
      <div className="nav">
        <button className={activeView === "chat" ? "active" : ""} onClick={() => onSelect("chat")}>
          <span className="dot"></span>
          <span className="txt">聊天</span>
        </button>
        <button className={activeView === "review" ? "active" : ""} onClick={() => onSelect("review")}>
          <span className="dot"></span>
          <span className="txt">复核</span>
        </button>
        <button disabled>
          <span className="dot"></span>
          <span className="txt">统计</span>
          <span className="todo">待建设</span>
        </button>
        <button disabled>
          <span className="dot"></span>
          <span className="txt">资料库</span>
          <span className="todo">待建设</span>
        </button>
        <div className="sep">系统</div>
        <button disabled>
          <span className="dot"></span>
          <span className="txt">用量</span>
          <span className="todo">待建设</span>
        </button>
      </div>
      <div className="rail-foot">
        <span className="kid-chip">👦 小宝 · 四年级</span>
      </div>
    </nav>
  );
}

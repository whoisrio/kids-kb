interface RailProps {
  activeView: "chat" | "review" | "stats" | "usage";
  onSelect: (view: "chat" | "review" | "stats" | "usage") => void;
  kidChip?: string;
}

function nav(
  activeView: RailProps["activeView"],
  onSelect: RailProps["onSelect"],
  view: RailProps["activeView"],
  label: string,
) {
  return (
    <button className={activeView === view ? "active" : ""} onClick={() => onSelect(view)}>
      <span className="dot"></span>
      <span className="txt">{label}</span>
    </button>
  );
}

export function Rail({ activeView, onSelect, kidChip }: RailProps) {
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
        {nav(activeView, onSelect, "chat", "聊天")}
        {nav(activeView, onSelect, "review", "复核")}
        {nav(activeView, onSelect, "stats", "统计")}
        <button disabled>
          <span className="dot"></span>
          <span className="txt">资料库</span>
          <span className="todo">待建设</span>
        </button>
        <div className="sep">系统</div>
        {nav(activeView, onSelect, "usage", "用量")}
      </div>
      <div className="rail-foot">
        <span className="kid-chip">{kidChip ?? "未选择孩子"}</span>
      </div>
    </nav>
  );
}

import { Icon } from "./Icon";

interface RailProps {
  activeView: "chat" | "library" | "stats" | "usage";
  onSelect: (view: "chat" | "library" | "stats" | "usage") => void;
  kidChip?: string;
}

function nav(
  activeView: RailProps["activeView"],
  onSelect: RailProps["onSelect"],
  view: RailProps["activeView"],
  label: string,
  icon: string,
) {
  return (
    <button className={activeView === view ? "active" : ""} onClick={() => onSelect(view)}>
      <Icon name={icon} />
      <span className="txt">{label}</span>
    </button>
  );
}

export function Rail({ activeView, onSelect, kidChip }: RailProps) {
  return (
    <nav className="rail">
      <div className="brand">
        <span className="logo"><Icon name="school" /></span>
        <span>
          <div className="name">童学知库</div>
          <div className="sub">KidsKB AI Learning</div>
        </span>
      </div>
      <div className="nav">
        <div className="sep">学习工作区</div>
        {nav(activeView, onSelect, "chat", "聊天", "forum")}
        {nav(activeView, onSelect, "library", "资料库", "menu_book")}
        {nav(activeView, onSelect, "stats", "统计", "analytics")}
        <div className="sep">系统</div>
        {nav(activeView, onSelect, "usage", "用量", "monitoring")}
      </div>
      <div className="rail-foot">
        <span className="kid-chip">{kidChip ?? "未选择孩子"}</span>
      </div>
    </nav>
  );
}

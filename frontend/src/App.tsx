import { useState } from "react";
import { Rail } from "./components/Rail";
import { ChatView } from "./views/ChatView";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function today(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return `${ymd} ${WEEKDAYS[d.getDay()]}`;
}

export function App() {
  const [kid, setKid] = useState("小宝");
  return (
    <div className="app">
      <Rail />
      <main>
        <div className="topbar">
          <div>
            <span className="date">{today()}</span>
            <h1>聊天</h1>
          </div>
          <span className="hint">问孩子学习情况，或找题、看讲解</span>
          <div className="kid-switch">
            {["小宝", "朵朵"].map((k) => (
              <button key={k} className={kid === k ? "on" : ""} onClick={() => setKid(k)}>
                {k}
              </button>
            ))}
          </div>
        </div>
        <ChatView />
      </main>
    </div>
  );
}

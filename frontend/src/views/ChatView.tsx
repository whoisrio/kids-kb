import { useState } from "react";
import type { ChatMessage, LaneInfo } from "../api/chat";
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
  lanes: LaneInfo[];
  currentLane: string;
  rewindTo: { index: number; entryId: string } | null;
  onSend: (content: string) => void;
  onEdit: (index: number, content: string) => void;
  onRewind: (index: number) => void;
  onCancelRewind: () => void;
  onRegenerate: () => void;
  onSwitchLane: (laneId: string) => void;
  onToast: (text: string) => void;
}

function switcherOptions(
  index: number,
  messages: ChatMessage[],
  lanes: LaneInfo[],
  currentLane: string,
): { laneIds: string[]; current: number } | null {
  const forkEntryId = index === 0 ? null : messages[index - 1].entryId ?? null;
  if (forkEntryId === null) {
    const roots = lanes.filter((lane) => lane.forkEntryId === null);
    if (roots.length < 2) return null;
    const current = roots.findIndex((lane) => lane.id === currentLane);
    return { laneIds: roots.map((lane) => lane.id), current: current >= 0 ? current : 0 };
  }
  const forks = lanes.filter((lane) => lane.forkEntryId === forkEntryId);
  if (forks.length === 0) return null;
  const currentIsFork = forks.some((lane) => lane.id === currentLane);
  if (!currentIsFork) {
    return { laneIds: [currentLane, ...forks.map((fork) => fork.id)], current: 0 };
  }
  const originalLane = forks.find((fork) => fork.fromLaneId)?.fromLaneId ?? "main";
  return {
    laneIds: [originalLane, ...forks.map((fork) => fork.id)],
    current: 1 + forks.findIndex((fork) => fork.id === currentLane),
  };
}

function BranchSwitcher({ index, messages, lanes, currentLane, onSwitchLane }: {
  index: number; messages: ChatMessage[]; lanes: LaneInfo[]; currentLane: string;
  onSwitchLane: (laneId: string) => void;
}) {
  const options = switcherOptions(index, messages, lanes, currentLane);
  if (!options) return null;
  const count = options.laneIds.length;
  if (count < 2) return null;
  const go = (delta: number) => {
    const next = (options.current + delta + count) % count;
    if (next !== options.current) onSwitchLane(options.laneIds[next]);
  };
  return (
    <span className="branch-switch" aria-label={`分支 ${options.current + 1}/${count}`}>
      <button onClick={() => go(-1)} disabled={count < 2}>‹</button>
      <span>{options.current + 1}/{count}</span>
      <button onClick={() => go(1)} disabled={count < 2}>›</button>
    </span>
  );
}

export function ChatView(props: ChatViewProps) {
  const { messages, streaming, lanes, currentLane, rewindTo } = props;
  const [input, setInput] = useState("");
  const visible = rewindTo ? messages.slice(0, rewindTo.index + 1) : messages;

  const send = () => {
    const content = input.trim();
    if (!content || streaming) return;
    props.onSend(content);
    setInput("");
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      props.onToast("已复制");
    } catch {
      props.onToast("复制失败");
    }
  };

  return (
    <>
      <div className="chat-wrap" data-streaming={streaming ? "true" : "false"}>
        <div className="chat-log">
          {messages.length === 0 && (
            <div className="chat-empty">还没有对话——问孩子学习情况，或找题、看讲解。</div>
          )}
          {visible.map((message, index) => (
            <MessageBubble
              key={message.entryId ?? index}
              message={message}
              index={index}
              isLast={index === messages.length - 1}
              streaming={streaming}
              actions={{
                onEdit: props.onEdit,
                onRewind: props.onRewind,
                onRegenerate: !streaming && index === messages.length - 1 && message.role === "assistant"
                  ? props.onRegenerate : undefined,
                onCopy: (item) => void copyMessage(item),
              }}
              switcher={
                <BranchSwitcher
                  index={index} messages={messages} lanes={lanes}
                  currentLane={currentLane} onSwitchLane={props.onSwitchLane}
                />
              }
            />
          ))}
        </div>
        {rewindTo && (
          <div className="rewind-banner" role="status">
            已回到这条消息——后续内容保留在原分支，下一次发送将从这里开叉。
            <button className="ghost" onClick={props.onCancelRewind}>取消回退</button>
          </div>
        )}
        <div className="chips">
          {CHIPS.map((chip) => (
            <button key={chip} onClick={() => setInput(chip)}>{chip}</button>
          ))}
        </div>
      </div>
      <Composer value={input} onChange={setInput} onSend={send} disabled={streaming} />
    </>
  );
}

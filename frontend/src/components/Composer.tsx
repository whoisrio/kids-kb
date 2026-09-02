interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
}

export function Composer({ value, onChange, onSend, disabled }: ComposerProps) {
  return (
    <div className="composer">
      <div className="box">
        <input
          type="text"
          placeholder="问点什么，比如「小宝最近计算错得多吗」"
          aria-label="输入问题"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) onSend();
          }}
        />
        <button className="send" onClick={onSend} disabled={disabled || value.trim() === ""}>
          发送
        </button>
      </div>
    </div>
  );
}

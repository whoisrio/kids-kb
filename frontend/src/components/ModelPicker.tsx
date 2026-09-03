import type { ModelInfo } from "../api/chat";

interface ModelPickerProps {
  models: ModelInfo[];
  value: string;
  onChange: (id: string) => void;
}

/** 顶栏模型下拉：切换后随下一条消息请求携带（会话级粒度，由后端落 model_change）。 */
export function ModelPicker({ models, value, onChange }: ModelPickerProps) {
  if (models.length === 0) return null;
  return (
    <label className="model-select">
      <span className="tag">模型</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="选择模型">
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

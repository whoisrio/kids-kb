import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

function diffLines(oldText: string, newText: string) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lcs = Array.from({ length: oldLines.length + 1 }, () =>
    new Array(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lcs[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lcs[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
    }
  }
  const left: { text: string; kind: "same" | "removed" }[] = [];
  const right: { text: string; kind: "same" | "added" }[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      left.push({ text: oldLines[oldIndex], kind: "same" });
      right.push({ text: newLines[newIndex], kind: "same" });
      oldIndex += 1; newIndex += 1;
    } else if (lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1]) {
      left.push({ text: oldLines[oldIndex], kind: "removed" }); oldIndex += 1;
    } else {
      right.push({ text: newLines[newIndex], kind: "added" }); newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    left.push({ text: oldLines[oldIndex], kind: "removed" }); oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    right.push({ text: newLines[newIndex], kind: "added" }); newIndex += 1;
  }
  return { left };
}

export function BlockGeometryDiff({ oldText, newText, onConfirm, onCancel }: {
  oldText: string; newText: string;
  onConfirm: (text: string) => void; onCancel: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(newText);
  const { left } = diffLines(oldText, newText);
  return (
    <div className="dialog-mask">
      <div className="dialog block-geometry-diff">
        <div className="diff-header">
          <span>原文本</span><span>新识别</span>
        </div>
        <div className="diff-body">
          <div>
            {left.map((line, index) => (
              <div key={`${line.text}-${index}`} className={line.kind === "removed" ? "removed" : undefined}>
                {line.text || "\u00A0"}
              </div>
            ))}
          </div>
          <div>
            {editing ? (
              <textarea aria-label="手动改文本" value={draft}
                        onChange={(event) => setDraft(event.target.value)} />
            ) : (
              <div className="md block-geometry-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {newText}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>
        <div className="row">
          <button className="btn-primary" onClick={() => onConfirm(newText)}>采用新文本</button>
          <button className="btn-ghost" onClick={() => onConfirm(oldText)}>保留原文本</button>
          <button className="btn-ghost" onClick={() => setEditing(true)}>手动改</button>
          <button className="btn-primary" disabled={!editing} onClick={() => onConfirm(draft)}>确认提交</button>
          <button className="btn-ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}

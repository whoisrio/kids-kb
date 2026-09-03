import { useState } from "react";
import { uploadPaper, type PaperSummary } from "../api/papers";

interface UploadDialogProps {
  children: { id: string; name: string }[];
  onDone: (paper: PaperSummary) => void;
  onClose: () => void;
}

const SUBJECTS = ["语文", "数学", "英语", "其他"];

export function UploadDialog({ children: kids, onDone, onClose }: UploadDialogProps) {
  const [childId, setChildId] = useState(kids[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("数学");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!childId || !title.trim() || files.length === 0) {
      setError("孩子、标题、文件都必填");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onDone(await uploadPaper(
        { child_id: childId, title: title.trim(), subject, files }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="上传试卷" onClick={(e) => e.stopPropagation()}>
        <h2>上传试卷</h2>
        <label>
          孩子
          <select aria-label="孩子" value={childId} onChange={(e) => setChildId(e.target.value)}>
            {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
        <label>
          标题
          <input aria-label="标题" value={title} onChange={(e) => setTitle(e.target.value)}
                 placeholder="如：三年级数学期中卷" />
        </label>
        <label>
          科目
          <select aria-label="科目" value={subject} onChange={(e) => setSubject(e.target.value)}>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          文件（PDF/JPG/PNG，可多选）
          <input aria-label="文件" type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
                 onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </label>
        {files.length > 0 && <div className="file-list">{files.map((f) => f.name).join("、")}</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>提交</button>
        </div>
      </div>
    </div>
  );
}

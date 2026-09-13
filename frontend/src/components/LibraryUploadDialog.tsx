import { useRef, useState } from "react";
import { uploadLibraryDoc, type LibraryDoc } from "../api/library";

interface LibraryUploadDialogProps {
  onDone: (doc: LibraryDoc) => void;
  onClose: () => void;
  fetchImpl?: typeof fetch;
}

const SUBJECTS = ["语文", "数学", "英语", "其他"];
const DOC_TYPES: ["workbook" | "exam", string][] = [["workbook", "同步教辅"], ["exam", "试卷"]];

/** 资料库上传弹窗：单文件（PDF/DOCX/MD）→ POST /api/library/docs，
    上传后文档自动进入 parse（检测）流程，进度由列表页轮询呈现。
    标题在用户手改前默认取文件名（去扩展名）。 */
export function LibraryUploadDialog({ onDone, onClose, fetchImpl = fetch }: LibraryUploadDialogProps) {
  const [title, setTitle] = useState("");
  const titleTouched = useRef(false);
  const [subject, setSubject] = useState("数学");
  const [docType, setDocType] = useState<"workbook" | "exam">("workbook");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!file || !title.trim()) {
      setError("文件、标题都必填");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onDone(await uploadLibraryDoc(
        { file, title: title.trim(), subject, doc_type: docType }, fetchImpl));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="上传资料" onClick={(e) => e.stopPropagation()}>
        <h2>上传资料</h2>
        <label>
          文件（PDF/DOCX/MD，单选）
          <input aria-label="文件" type="file" accept=".pdf,.docx,.md"
                 onChange={(e) => {
                   const next = e.target.files?.[0] ?? null;
                   setFile(next);
                   // 标题未手改过才用文件名（去扩展名）做默认值
                   if (!titleTouched.current && next) setTitle(next.name.replace(/\.[^.]+$/, ""));
                 }} />
        </label>
        <label>
          标题
          <input aria-label="标题" value={title} placeholder="如：四年级数学学霸题中题"
                 onChange={(e) => { titleTouched.current = true; setTitle(e.target.value); }} />
        </label>
        <label>
          科目
          <select aria-label="科目" value={subject} onChange={(e) => setSubject(e.target.value)}>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          类型
          <select aria-label="类型" value={docType}
                  onChange={(e) => setDocType(e.target.value as "workbook" | "exam")}>
            {DOC_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {file && <div className="file-list">{file.name}</div>}
        {error && <div className="form-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy}>提交</button>
        </div>
      </div>
    </div>
  );
}

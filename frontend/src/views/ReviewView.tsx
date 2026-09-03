import { useCallback, useEffect, useState } from "react";
import {
  confirmQuestion, fetchPapers, fetchPaperDetail, retryPaper, reRecognizePaper,
  type PaperDetail, type PaperQuestion, type PaperSummary,
} from "../api/papers";
import { MatchPicker } from "../components/MatchPicker";
import { PaperQueue } from "../components/PaperQueue";
import { QuestionCard } from "../components/QuestionCard";
import { UploadDialog } from "../components/UploadDialog";

const CAUSES = ["粗心", "概念不清", "方法不会", "计算错"];

/** 复核视图:左列试卷队列 + 右侧当前题确认流(键盘 1/2/3 + Enter)。 */
export function ReviewView() {
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [kids, setKids] = useState<{ id: string; name: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaperDetail | null>(null);
  const [qIndex, setQIndex] = useState(0);
  const [cause, setCause] = useState("");
  const [note, setNote] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [matchOpen, setMatchOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadPapers = useCallback(async () => {
    try {
      const { papers: list } = await fetchPapers();
      setPapers(list);
    } catch (err) {
      console.error("试卷列表加载失败", err);
    }
  }, []);

  useEffect(() => {
    void loadPapers();
    fetch("/api/children").then((r) => r.json()).then((d: { children: { id: string; name: string }[] }) =>
      setKids(Array.isArray(d?.children) ? d.children : [])).catch(() => {});
  }, [loadPapers]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await fetchPaperDetail(id));
      setQIndex(0);
    } catch (err) {
      console.error("试卷详情加载失败", err);
    }
  }, []);

  // 有 processing 卷时轮询;选中卷处理完自动刷新详情
  useEffect(() => {
    if (!papers.some((p) => p.status === "processing")) return;
    const t = setInterval(() => void loadPapers(), 2000);
    return () => clearInterval(t);
  }, [papers, loadPapers]);
  useEffect(() => {
    const listed = papers.find((p) => p.id === selectedId);
    if (detail && detail.status === "processing" && listed && listed.status !== "processing") {
      void loadDetail(selectedId!);
    }
  }, [papers, loadDetail, detail, selectedId]);

  useEffect(() => {
    const q = detail?.questions[qIndex];
    setCause(q?.error_cause ?? "");
    setNote(q?.note ?? "");
  }, [qIndex, detail]);

  const current = detail?.questions[qIndex] ?? null;

  const doConfirm = useCallback(async (result: string) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      const body: { result: string; error_cause?: string; note?: string } = { result };
      if (cause) body.error_cause = cause;
      if (note.trim()) body.note = note.trim();
      const out = await confirmQuestion(current.id, body);
      setDetail((d) => d && ({
        ...d, status: out.paper_status,
        questions: d.questions.map((q, i) =>
          i === qIndex ? { ...q, confirmed_result: result as PaperQuestion["confirmed_result"],
            error_cause: cause || null, note: note.trim() || null } : q),
      }));
      if (qIndex < (detail?.questions.length ?? 0) - 1) setQIndex(qIndex + 1);
    } catch (err) {
      console.error("确认失败", err);
    } finally {
      setBusy(false);
    }
  }, [current, busy, cause, note, qIndex, detail]);

  // 键盘流转:1=错 2=对 3=半对,Enter=采纳预选;焦点在表单控件时不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在表单控件时不触发;window/document 无 closest,用 instanceof 拦截
      if (e.target instanceof HTMLElement &&
          e.target.closest("input, select, textarea, button")) return;
      if (!current || busy) return;
      if (e.key === "1") void doConfirm("wrong");
      if (e.key === "2") void doConfirm("correct");
      if (e.key === "3") void doConfirm("partial");
      if (e.key === "Enter" && current.recognized_result) void doConfirm(current.recognized_result);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, busy, doConfirm]);

  return (
    <div className="review-wrap">
      <PaperQueue
        papers={papers}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); void loadDetail(id); }}
        onUpload={() => setUploadOpen(true)}
      />
      <div className="review-detail">
        {!detail && <div className="chat-empty">左侧选择一份试卷,或上传新试卷。</div>}
        {detail?.status === "processing" && (
          <div className="chat-empty">处理中——渲染页图与 VLM 识别,共 {detail.page_count} 页……</div>
        )}
        {detail?.status === "failed" && (
          <div className="fail-box">
            <div>处理失败:{detail.error}</div>
            <button className="primary" onClick={() => {
              void retryPaper(detail.id).then(() => {
                setDetail({ ...detail, status: "processing", error: null });
                void loadPapers();
              });
            }}>重试</button>
          </div>
        )}
        {detail && current && detail.status !== "processing" && (
          <>
            <div className="rd-head">
              <span className="label">第 {current.seq} 题 · 共 {detail.questions.length} 题</span>
              <span className="src">《{detail.title}》第 {current.page_no} 页
                {current.recognized_result ? ` · VLM 预识别为「${
                  { wrong: "错", correct: "对", partial: "半对" }[current.recognized_result] }」` : ""}
                {current.confirmed_result ? " · 已确认" : ""}
              </span>
              {current.page_no <= detail.page_count && (
                <button className="ghost" onClick={() => {
                  void reRecognizePaper(detail.id, current.page_no).then(() => {
                    setDetail({ ...detail, status: "processing" });
                    void loadPapers();
                  });
                }}>重识别本页</button>
              )}
            </div>
            <div className="qnav">
              {detail.questions.map((q, i) => (
                <button key={q.id} className={i === qIndex ? "on" : ""}
                        data-confirmed={q.confirmed_result ?? ""}
                        onClick={(e) => { e.currentTarget.blur(); setQIndex(i); }}>{q.seq}</button>
              ))}
            </div>
            <QuestionCard question={current} />
            <div className="verdict">
              <span className="tip">这题</span>
              {/* blur：点击后焦点回到 body,键盘流转不被按钮拦截 */}
              <button className="w" onClick={(e) => { e.currentTarget.blur(); void doConfirm("wrong"); }} disabled={busy}>✗ 错</button>
              <button className="r" onClick={(e) => { e.currentTarget.blur(); void doConfirm("correct"); }} disabled={busy}>✓ 对</button>
              <button className="h" onClick={(e) => { e.currentTarget.blur(); void doConfirm("partial"); }} disabled={busy}>½ 半对</button>
              <select aria-label="错因" value={cause} onChange={(e) => setCause(e.target.value)}>
                <option value="">错因(可选)</option>
                {CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)}
                     placeholder="备注,如「竖式对位错」" />
              {!current.matched_item_id && (
                <button className="ghost" onClick={() => setMatchOpen(true)}>待匹配 · 选择题库条目</button>
              )}
            </div>
            <div className="keyhint">快捷键:1 做错 · 2 做对 · 3 半对 · Enter 采纳预选并下一条</div>
            {matchOpen && (
              <MatchPicker question={current} onMatched={(q) => {
                setDetail((d) => d && ({ ...d, questions: d.questions.map((x, i) => i === qIndex ? q : x) }));
                setMatchOpen(false);
              }} />
            )}
          </>
        )}
      </div>
      {uploadOpen && (
        <UploadDialog
          children={kids}
          onClose={() => setUploadOpen(false)}
          onDone={(p) => {
            setUploadOpen(false);
            setSelectedId(p.id);
            void loadPapers();
            void loadDetail(p.id);
          }}
        />
      )}
    </div>
  );
}

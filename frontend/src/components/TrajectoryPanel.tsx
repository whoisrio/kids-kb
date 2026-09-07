import { useEffect, useState } from "react";
import {
  fetchDocEvents, fetchDocRuns, fetchEventDetail, fetchPageEvents,
  type TrajectoryEvent, type TrajectoryRun,
} from "../api/trajectory";

type FetchLike = typeof fetch;

function EventRow({ ev, fetchImpl }: { ev: TrajectoryEvent; fetchImpl: FetchLike }) {
  return (
    <li className={`traj-event ${ev.status}`}>
      <span className="traj-stage">{ev.stage}</span>
      <span className="traj-type">{ev.event_type}</span>
      <span className="traj-summary">{ev.summary}</span>
      {ev.duration_ms != null && <span className="traj-meta">{ev.duration_ms}ms</span>}
      {ev.model && <span className="traj-meta">{ev.model}</span>}
      <details className="traj-payload" onToggle={async (e) => {
        const el = e.currentTarget;
        if (el.open && !el.dataset.loaded) {
          el.dataset.loaded = "1";
          const detail = await fetchEventDetail(ev.id, fetchImpl);
          const pre = el.querySelector("pre");
          if (pre) pre.textContent = detail.payload ? JSON.stringify(detail.payload, null, 2) : "（无详细记录，simple 级别只记摘要）";
        }
      }}>
        <summary>详情</summary>
        <pre>加载中…</pre>
      </details>
    </li>
  );
}

export function EventList({ events, fetchImpl }: { events: TrajectoryEvent[]; fetchImpl: FetchLike }) {
  if (events.length === 0) return <div className="chat-empty">暂无处理日志</div>;
  return (
    <ul className="traj-events">
      {events.map((ev) => <EventRow key={ev.id} ev={ev} fetchImpl={fetchImpl} />)}
    </ul>
  );
}

export function DocTrajectory({ docId, fetchImpl = fetch }: { docId: string; fetchImpl?: FetchLike }) {
  const [runs, setRuns] = useState<TrajectoryRun[] | null>(null);
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setRuns(null); setEvents(null); setActiveRun(null);
    fetchDocRuns(docId, fetchImpl).then((r) => setRuns(r.runs))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [docId, fetchImpl]);

  const openRun = async (runId: string) => {
    setActiveRun(runId);
    try { setEvents((await fetchDocEvents(docId, runId, fetchImpl)).events); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!runs) return <div className="chat-empty">加载中…</div>;
  if (runs.length === 0) return <div className="chat-empty">暂无处理日志</div>;
  return (
    <div className="traj-doc">
      <ul className="traj-runs">
        {runs.map((r) => (
          <li key={r.run_id}>
            <button className={activeRun === r.run_id ? "active" : ""}
                    onClick={() => void openRun(r.run_id)}>
              {r.first_stage} · {r.actor} · {r.event_count} 事件
              {r.error_count > 0 && <span className="badge error">{r.error_count} 错误</span>}
              <span className="traj-meta">{new Date(r.started_at).toLocaleString()}</span>
            </button>
          </li>
        ))}
      </ul>
      {events && <EventList events={events} fetchImpl={fetchImpl} />}
    </div>
  );
}

export function PageTrajectory({ pageId, fetchImpl = fetch }: { pageId: string; fetchImpl?: FetchLike }) {
  const [events, setEvents] = useState<TrajectoryEvent[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetchPageEvents(pageId, fetchImpl).then((r) => setEvents(r.events))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [pageId, fetchImpl]);
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!events) return <div className="chat-empty">加载中…</div>;
  return <EventList events={events} fetchImpl={fetchImpl} />;
}

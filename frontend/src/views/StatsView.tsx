import { useCallback, useEffect, useState } from "react";
import {
  fetchStatsOverview,
  recordCorrection,
  type PendingEntry,
  type StatsOverview,
} from "../api/stats";

const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const pp = (delta: number | null) =>
  delta === null ? "" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`;

export function StatsView({
  childId,
  onToast,
  fetchImpl = fetch,
}: {
  childId: string | null;
  onToast?: (text: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const [data, setData] = useState<StatsOverview | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!childId) return;
    setError("");
    try {
      setData(await fetchStatsOverview(childId, fetchImpl));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [childId, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  const correct = async (entry: PendingEntry) => {
    if (!childId || busyId) return;
    setBusyId(entry.id);
    try {
      await recordCorrection(entry, childId, fetchImpl);
      onToast?.("已记录订正");
      await load();
    } catch (cause) {
      onToast?.(cause instanceof Error ? cause.message : "记录失败");
    } finally {
      setBusyId(null);
    }
  };

  if (!childId) {
    return <div className="stats-empty chat-empty">还没有孩子档案——先在复核页上传试卷时添加孩子。</div>;
  }
  if (error) return <div className="form-error" role="alert">{error}</div>;
  if (!data) return <div className="chat-empty">加载中…</div>;

  const maxCause = Math.max(1, ...data.causes.map((item) => item.count));
  const maxTag = Math.max(1, ...data.weakTags.map((item) => item.count));
  const maxTrend = Math.max(1, ...data.trend.map((week) => week.total));

  return (
    <div className="stats">
      <div className="hero-cards">
        <div className="hero-card" data-k="week-wrong">
          <div className="num">{data.hero.weekWrong}</div>
          <div className="lbl">本周错题</div>
        </div>
        <div className="hero-card" data-k="rate">
          <div className="num">{pct(data.hero.weekRate)}</div>
          <div className="lbl">
            本周正确率
            {pp(data.hero.rateDelta) && (
              <span className={(data.hero.rateDelta ?? 0) >= 0 ? "up" : "down"}>
                {pp(data.hero.rateDelta)}
              </span>
            )}
          </div>
        </div>
        <div className="hero-card" data-k="corrected">
          <div className="num">{data.hero.corrected}</div>
          <div className="lbl">已订正</div>
        </div>
        <div className="hero-card" data-k="pending">
          <div className="num">{data.hero.pending}</div>
          <div className="lbl">待重练</div>
        </div>
      </div>

      <div className="stats-grid">
        <section className="panel">
          <h3>错因分布 <span className="sub">近 30 天</span></h3>
          {data.causes.length === 0 && <div className="hint">近 30 天没有错题</div>}
          <div className="bars">
            {data.causes.map((item) => (
              <div key={item.cause} className="bar-row">
                <span className="bar-label">{item.cause}</span>
                <div className="bar-track">
                  <div
                    data-testid="cause-bar"
                    className="bar-fill"
                    style={{ width: `${(item.count / maxCause) * 100}%` }}
                  />
                </div>
                <span className="bar-num">{item.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>薄弱知识点 <span className="sub">待重练的题</span></h3>
          {data.weakTags.length === 0 && <div className="hint">暂无薄弱知识点</div>}
          <div className="tag-cloud">
            {data.weakTags.map((item) => (
              <span
                key={item.tag}
                className="tag"
                style={{
                  fontSize: `${12 + (item.count / maxTag) * 10}px`,
                  opacity: 0.65 + (item.count / maxTag) * 0.35,
                }}
              >
                {item.tag}<sub>{item.count}</sub>
              </span>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>正确率趋势 <span className="sub">近 8 周</span></h3>
          <div className="trend">
            {data.trend.map((week) => (
              <div
                key={week.weekStart}
                data-testid="trend-col"
                className="trend-col"
                title={`${week.weekStart} · ${week.total} 次 · ${pct(week.rate)}`}
              >
                <div className="trend-bar" style={{ height: `${(week.total / maxTrend) * 100}%` }} />
                <span className="trend-rate">{pct(week.rate)}</span>
                <span className="trend-week">{week.weekStart.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>待重练清单 <span className="sub">{data.pendingList.length} 题</span></h3>
          {data.pendingList.length === 0 && <div className="hint">没有待重练的题</div>}
          <div className="pending-list">
            {data.pendingList.map((entry) => (
              <div key={entry.id} className="pending-card">
                <div className="pc-content">{entry.content}</div>
                <div className="pc-meta">
                  <span className="src">{entry.source}</span>
                  {entry.errorCause && <span className="badge">{entry.errorCause}</span>}
                  <button
                    className="primary"
                    disabled={busyId === entry.id}
                    onClick={() => void correct(entry)}
                  >
                    已订正
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

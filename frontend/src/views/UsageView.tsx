import { useEffect, useState } from "react";
import { fetchUsageOverview, type UsageOverview } from "../api/stats";

const fmt = (value: number) => value.toLocaleString("zh-CN");

export function UsageView({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchUsageOverview(fetchImpl)
      .then(setData)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [fetchImpl]);

  if (error) return <div className="usage"><div className="form-error" role="alert">{error}</div></div>;
  if (!data) return <div className="usage"><div className="chat-empty">加载中…</div></div>;

  const maxPurpose = Math.max(1, ...data.byPurpose.map((item) => item.tokens));
  const maxModel = Math.max(1, ...data.byModel.map((item) => item.tokens));

  return (
    <div className="usage">
      <div className="hero-cards">
        <div className="hero-card">
          <div className="num">{fmt(data.hero.totalTokens)}</div>
          <div className="lbl">本月 token 总量</div>
        </div>
        <div className="hero-card">
          <div className="num">{fmt(data.hero.textTokens)}</div>
          <div className="lbl">文本 token</div>
        </div>
        <div className="hero-card">
          <div className="num">{fmt(data.hero.imageTokens)}</div>
          <div className="lbl">图像 token</div>
        </div>
        <div className="hero-card">
          <div className="num">{fmt(data.hero.calls)}</div>
          <div className="lbl">本月调用次数</div>
        </div>
      </div>

      <div className="stats-grid">
        <section className="panel">
          <h3>按用途 <span className="sub">本月</span></h3>
          <div className="bars">
            {data.byPurpose.map((item) => (
              <div key={item.purpose} className="bar-row">
                <span className="bar-label">{item.purpose}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(item.tokens / maxPurpose) * 100}%` }} />
                </div>
                <span className="bar-num">{fmt(item.tokens)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h3>按模型 <span className="sub">本月</span></h3>
          <div className="bars">
            {data.byModel.map((item) => (
              <div key={item.model} className="bar-row">
                <span className="bar-label" title={item.model}>
                  {item.model.length > 10 ? `${item.model.slice(0, 10)}…` : item.model}
                </span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(item.tokens / maxModel) * 100}%` }} />
                </div>
                <span className="bar-num">{fmt(item.tokens)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" style={{ gridColumn: "1 / -1" }}>
          <h3>最近调用 <span className="sub">最新 50 条</span></h3>
          <table className="usage-table">
            <thead>
              <tr>
                <th>时间</th><th>用途</th><th>模型</th><th>模态</th>
                <th className="num">输入</th><th className="num">输出</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((item) => (
                <tr key={item.id}>
                  <td>
                    {new Date(item.created_at).toLocaleString("zh-CN", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>{item.purpose}</td>
                  <td>{item.model}</td>
                  <td>
                    <span className={`modality-tag ${item.modality}`}>
                      {item.modality === "image" ? "图像" : "文本"}
                    </span>
                  </td>
                  <td className="num">{fmt(item.prompt_tokens)}</td>
                  <td className="num">{fmt(item.completion_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

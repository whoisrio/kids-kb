/** reranker provider：local=调 pipeline /internal/rerank；none=不重排。
    后续接云重排（jina/cohere 等）在此加一个 provider 分支即可。 */
export type RerankFn = (query: string, docs: string[]) => Promise<number[]>;

export function makeReranker(provider: "local" | "none", pipelineUrl: string): RerankFn | null {
  if (provider === "none") return null;
  return async (query, docs) => {
    const resp = await fetch(`${pipelineUrl.replace(/\/$/, "")}/internal/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, docs }),
    });
    if (resp.status === 503) return docs.map(() => 0);  // 模型没装：降级为原顺序
    if (!resp.ok) throw new Error(`rerank 失败: ${resp.status}`);
    return ((await resp.json()) as { scores: number[] }).scores;
  };
}

/** query 向量化：直连 ollama 的 OpenAI 兼容端点（与 pipeline embed.py 同一渠道）。 */
export async function embedTexts(
  baseUrl: string,
  model: string,
  texts: string[],
): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {  // 逐条调用，与 Python 侧一致（批量接口各家不一致）
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ollama" },
      body: JSON.stringify({ model, input: t }),
    });
    if (!resp.ok) throw new Error(`embed 失败: ${resp.status} ${await resp.text()}`);
    const data = (await resp.json()) as { data: { embedding: number[] }[] };
    out.push(data.data[0].embedding);
  }
  return out;
}

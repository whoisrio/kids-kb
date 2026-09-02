/** BM25 词法检索：移植 pipeline/kb/lexical.py（分词：英数按词，CJK 二元组）。 */
const RUN_RE = /[a-z0-9]+|[一-鿿]+/g;
const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const m of (text ?? "").toLowerCase().matchAll(RUN_RE)) {
    const t = m[0];
    if (t.length === 1 || /^[a-z0-9]+$/.test(t)) tokens.push(t);
    else for (let i = 0; i < t.length - 1; i++) tokens.push(t.slice(i, i + 2));
  }
  return tokens;
}

export interface ScoredDoc {
  index: number;
  score: number;
}

export function bm25Score(query: string, docs: string[], topK = 20): ScoredDoc[] {
  if (docs.length === 0) return [];
  const tfs = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of tokenize(d)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const dls = tfs.map((tf) => [...tf.values()].reduce((a, b) => a + b, 0));
  const avgdl = dls.reduce((a, b) => a + b, 0) / docs.length;
  const df = new Map<string, number>();
  for (const tf of tfs) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const scored: ScoredDoc[] = tfs.map((tf, index) => {
    let score = 0;
    for (const t of tokenize(query)) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * dls[index]) / avgdl));
    }
    return { index, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

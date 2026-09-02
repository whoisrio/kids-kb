import katex from "katex";

// 原型同款：把 $...$ 行内公式替换为 KaTeX HTML（输入仅来自后端助手消息）。
export function renderRichText(text: string): string {
  return text.replace(/\$([^$]+)\$/g, (_, tex: string) => {
    try {
      return katex.renderToString(tex, { throwOnError: false });
    } catch {
      return tex;
    }
  });
}

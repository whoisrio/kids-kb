import katex from "katex";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 原型同款 $...$ 行内公式渲染，但先按数学段切分：普通段 HTML 转义（防反射型 XSS，
// 助手消息可能回显用户输入），数学段交给 katex.renderToString（throwOnError: false，
// 其输出安全可直接注入）。不能先整体转义再跑正则——数学内容里的字符会被转义污染。
export function renderRichText(text: string): string {
  const parts = text.split(/\$([^$]+)\$/g);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i % 2 === 0) {
      out += escapeHtml(part);
    } else {
      try {
        out += katex.renderToString(part, { throwOnError: false });
      } catch {
        out += escapeHtml(part);
      }
    }
  }
  return out;
}

/* 转录内容渲染：Markdown + LaTeX（KaTeX）。
 *
 * 数学公式必须在 markdown 解析【前】抽出为占位符，否则 \\ _ ^ * 等会被
 * marked 吞掉/转义，LaTeX 无法还原。流程：
 *   抽公式($$...$$ 与 $...$) -> marked.parse -> DOMPurify 消毒(浏览器侧)
 *   -> 占位符替换为 KaTeX 渲染结果。
 * UMD：浏览器挂 window.renderContent；node 下 require 供自测（无 DOMPurify 则跳过消毒）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/marked.min.js"),
                             require("./vendor/katex/katex.min.js"));
  } else {
    root.renderContent = factory(root.marked, root.katex);
  }
})(typeof self !== "undefined" ? self : this, function (marked, katex) {

  // 纯字母数字占位符，markdown 与 DOMPurify 都不会动它
  function ph(i) { return "zzMATH" + i + "zz"; }
  var PH_RE = /zzMATH(\d+)zz/g;

  function extractMath(src) {
    var math = [];
    var s = String(src == null ? "" : src);
    // 块级 $$...$$ 优先（可跨行）
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
      math.push({ tex: tex, display: true });
      return ph(math.length - 1);
    });
    // 行内 $...$（不跨行，避免把价格类文本误判跨段）
    s = s.replace(/\$([^$\n]+?)\$/g, function (_, tex) {
      math.push({ tex: tex, display: false });
      return ph(math.length - 1);
    });
    return { text: s, math: math };
  }

  function injectMath(html, math) {
    return html.replace(PH_RE, function (m, i) {
      var item = math[+i];
      if (!item) return m;
      try {
        return katex.renderToString(item.tex, {
          displayMode: item.display,
          throwOnError: false,
          strict: false,
          trust: false,
        });
      } catch (e) {
        return m; // 渲染失败保留原文占位符可见性问题不大：退回 $ 包裹
      }
    });
  }

  return function renderContent(raw) {
    var extracted = extractMath(raw);
    var html = marked.parse(extracted.text);
    // 消毒放在数学注入前：占位符是纯文本，KaTeX 输出不受消毒影响
    if (typeof DOMPurify !== "undefined" && DOMPurify.sanitize) {
      html = DOMPurify.sanitize(html);
    }
    return injectMath(html, extracted.math);
  };
});

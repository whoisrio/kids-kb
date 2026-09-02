/* render.js 的 node 自测：node render_selftest.js，失败退出码非 0。 */
var renderContent = require("./render.js");

var failures = [];
function check(name, cond) {
  if (cond) console.log("ok - " + name);
  else { failures.push(name); console.error("FAIL - " + name); }
}

// 1. markdown 语义
var md = renderContent("**乘除法竖式谜**\n\n- 第 1 条\n- 第 2 条");
check("bold 渲染", md.indexOf("<strong>乘除法竖式谜</strong>") !== -1);
check("列表渲染", md.indexOf("<li>第 1 条</li>") !== -1);

// 2. 行内 LaTeX：_ ^ 不被 markdown 吞，KaTeX 接管
var inline = renderContent("由 $a_1 + b^2 = 30$ 可得");
check("行内公式产出 katex", (md2 = inline.match(/class="katex"/g) || []).length >= 1);
check("下标保留给 katex", inline.indexOf("a_1") === -1 || inline.indexOf("katex") !== -1);
check("无残留 $ 定界符（katex 内部除外）", inline.indexOf(">由 <") !== -1);

// 3. 块级 LaTeX（竖式 array，含 \\ 换行）
var block = renderContent("$$\\begin{array}{cc}1 & 2\\\\3 & 4\\end{array}$$");
check("块级公式 katex-display", block.indexOf("katex-display") !== -1);
check("array 双反斜杠存活", block.indexOf("\\\\") !== -1 || block.indexOf("\\begin{array}") !== -1);

// 4. 混排：markdown 结构内含公式
var mixed = renderContent("**例题**：若 $6 \\times 5 = 30$，则末位为 $0$。");
var katexCount = (mixed.match(/class="katex"/g) || []).length;
check("混排两个行内公式", katexCount === 2);
check("markdown 与公式共存", mixed.indexOf("<strong>例题</strong>") !== -1);

// 5. 空值不炸
check("空内容返回空串", renderContent(null) === "" || renderContent("") === "");

if (failures.length) {
  console.error(failures.length + " 项失败");
  process.exit(1);
}
console.log("全部通过");

// 批量校验 LaTeX 可渲染性。stdin: ["x^2", "\\frac{1"] -> stdout: [true, false]
const katex = require("katex");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const formulas = JSON.parse(input);
  const out = formulas.map((tex) => {
    try {
      katex.renderToString(tex, { throwOnError: true, strict: false });
      return true;
    } catch (e) {
      return false;
    }
  });
  process.stdout.write(JSON.stringify(out));
});

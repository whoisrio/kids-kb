import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto("http://127.0.0.1:5200/");
await page.getByRole("button", { name: "复核", exact: true }).click();
await page.getByRole("button", { name: "资料", exact: true }).click();
const sel = page.getByRole("combobox", { name: "选择文档" });
const optVal = await sel.locator("option", { hasText: "学霸题中题" }).first().getAttribute("value");
await sel.selectOption(optVal);
await page.getByRole("button", { name: "待复核页", exact: true }).click();
await page.locator(".page-card", { hasText: "第 7 页" }).click();
await page.getByAltText("第 7 页").waitFor();
await page.waitForTimeout(1500);
const cards = page.locator(".blockitem").filter({ has: page.locator(".katex") });
const n = await cards.count();
console.log("含 KaTeX 渲染的块:", n);
for (let i = 0; i < Math.min(n, 4); i++) {
  await cards.nth(i).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await cards.nth(i).screenshot({ path: `/tmp/latex-block-${i}.png` });
}
// 含 array 源码但没渲染出 katex 的块（渲染失败会回退原文）
const rawMath = await page.locator(".blockitem", { hasText: "begin{array}" }).count();
console.log("含 array 源码的块:", rawMath);
await browser.close();

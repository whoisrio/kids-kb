#!/usr/bin/env node
/**
 * 一键启动三服务：pipeline（rerank 内部服务 :8766）+ backend（:8787）+ frontend（:5173）。
 * 用法：node scripts/start.mjs（Ctrl+C 全部停止）
 * 跨平台：Windows/macOS/Linux；npm 在 Windows 上自动用 npm.cmd。
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";

const services = [
  { name: "pipeline", color: 35, cwd: "pipeline", cmd: "uv", args: ["run", "python", "-m", "kb.cli", "serve-internal"] },
  { name: "backend", color: 34, cwd: "backend", cmd: npm, args: ["run", "dev"] },
  { name: "frontend", color: 36, cwd: "frontend", cmd: npm, args: ["run", "dev"] },
];

// 前置检查：依赖是否已安装
for (const s of services) {
  const dir = join(root, s.cwd);
  if (!existsSync(dir)) fail(`目录不存在: ${s.cwd}/`);
  if (s.cmd === npm && !existsSync(join(dir, "node_modules"))) {
    fail(`缺少依赖，先执行: cd ${s.cwd} && npm install`);
  }
}
if (!existsSync(join(root, "pipeline", ".venv"))) {
  fail("缺少 pipeline 虚拟环境，先执行: cd pipeline && uv sync --extra layout --extra rerank");
}

const children = [];

function fail(msg) {
  console.error(`[start] ${msg}`);
  process.exit(1);
}

function prefix(s, text) {
  const tag = `\x1b[${s.color}m[${s.name}]\x1b[0m `;
  return text.toString().split(/\r?\n/).filter(Boolean).map((l) => tag + l).join("\n") + "\n";
}

for (const s of services) {
  const child = spawn(s.cmd, s.args, {
    cwd: join(root, s.cwd),
    shell: isWin, // Windows 需要 shell 才能解析 .cmd
    detached: !isWin, // POSIX 下建进程组，便于整组杀掉
  });
  child.stdout.on("data", (d) => process.stdout.write(prefix(s, d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(s, d)));
  child.on("exit", (code) => {
    console.log(`\x1b[${s.color}m[${s.name}]\x1b[0m 退出（code ${code}），停止全部服务`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      if (isWin) execSync(`taskkill /pid ${c.pid} /t /f`, { stdio: "ignore" });
      else process.kill(-c.pid, "SIGTERM");
    } catch { /* 已退出 */ }
  }
  setTimeout(() => process.exit(code), 300);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("三服务启动中：pipeline :8766 · backend :8787 · frontend :5173");
console.log("打开 http://127.0.0.1:5173 ；Ctrl+C 停止全部\n");

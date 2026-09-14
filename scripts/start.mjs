#!/usr/bin/env node
/**
 * 一键启动三服务：pipeline（rerank 内部服务 :8766）+ backend（:8787）+ frontend（:5200）。
 * 用法：node scripts/start.mjs [--force]（Ctrl+C 停止本次拉起的服务）
 * 幂等：健康检查可达的服务默认跳过不重复启动；--force 先杀掉占端口进程再全部重启。
 * 跨平台：Windows/macOS/Linux；npm 在 Windows 上自动用 npm.cmd。
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const force = process.argv.includes("--force");

const services = [
  { name: "pipeline", color: 35, cwd: "pipeline", cmd: "uv", args: ["run", "python", "-m", "kb.cli", "serve-internal"],
    port: 8766, health: "http://127.0.0.1:8766/openapi.json" },
  { name: "backend", color: 34, cwd: "backend", cmd: npm, args: ["run", "dev"],
    port: 8787, health: "http://127.0.0.1:8787/api/health" },
  { name: "frontend", color: 36, cwd: "frontend", cmd: npm, args: ["run", "dev"],
    port: 5200, health: "http://127.0.0.1:5200/" },
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

function fail(msg) {
  console.error(`[start] ${msg}`);
  process.exit(1);
}

/** 健康检查：有 HTTP 响应即视为在运行（不可达/超时视为未运行）。 */
async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 杀掉占用指定端口的进程（--force 用）。 */
function killPort(port) {
  if (isWin) {
    let out = "";
    try { out = execSync("netstat -ano", { stdio: ["ignore", "pipe", "ignore"] }).toString(); }
    catch { return; }
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port}`) && line.includes("LISTENING")) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== "0") pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { execSync(`taskkill /pid ${pid} /t /f`, { stdio: "ignore" }); } catch { /* 已退出 */ }
    }
  } else {
    // 只杀 LISTEN 方：不加 -sTCP:LISTEN 会把持有到该端口出站连接的进程（如 backend 代理）一起误杀
    try { execSync(`lsof -ti tcp:${port} -sTCP:LISTEN | xargs kill`, { stdio: "ignore" }); } catch { /* 端口空闲 */ }
  }
}

const children = [];
const started = [];

for (const s of services) {
  if (await isUp(s.health)) {
    if (!force) {
      console.log(`\x1b[${s.color}m[${s.name}]\x1b[0m 已在运行（:${s.port}），跳过`);
      continue;
    }
    console.log(`\x1b[${s.color}m[${s.name}]\x1b[0m --force：先杀掉 :${s.port} 上的现有进程`);
    killPort(s.port);
  }
  const child = spawn(s.cmd, s.args, {
    cwd: join(root, s.cwd),
    shell: isWin, // Windows 需要 shell 才能解析 .cmd
    detached: !isWin, // POSIX 下建进程组，便于整组杀掉
  });
  child.stdout.on("data", (d) => process.stdout.write(prefix(s, d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(s, d)));
  child.on("exit", (code) => {
    console.log(`\x1b[${s.color}m[${s.name}]\x1b[0m 退出（code ${code}），停止本次拉起的服务`);
    shutdown(code ?? 0);
  });
  children.push(child);
  started.push(s.name);
}

function prefix(s, text) {
  const tag = `\x1b[${s.color}m[${s.name}]\x1b[0m `;
  return text.toString().split(/\r?\n/).filter(Boolean).map((l) => tag + l).join("\n") + "\n";
}

if (children.length === 0) {
  console.log("三服务都已在运行：pipeline :8766 · backend :8787 · frontend :5200");
  console.log("打开 http://127.0.0.1:5200 ；要重启请用 --force");
  process.exit(0);
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  // 只停本次拉起的子进程；已在运行被跳过的服务不受 Ctrl+C 影响
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

console.log(`本次拉起：${started.join(" · ")}（已在运行的未受影响）`);
console.log("打开 http://127.0.0.1:5200 ；Ctrl+C 停止本次拉起的服务\n");

#!/usr/bin/env node
/**
 * VPS Pilot · MCP stdio 转发入口
 *
 * 为什么需要这一层：
 *   有些 MCP 客户端（ZCode、部分 CLI 工具）只会「自己拉起一个本地进程，
 *   通过 stdin/stdout 通信」，不支持填 HTTP 地址。
 *   而真正干活的 MCP 服务跑在 VPS Pilot 应用进程里 —— 它必须在那里，
 *   因为 SSH 凭据是用 Electron 的 safeStorage（DPAPI / Keychain）加密的，
 *   纯 Node 进程解不开，就算拉起来也连不上服务器。
 *
 *   所以这里做一个**透明转发**：把 stdin 收到的每条 JSON-RPC
 *   转给本机已运行的 VPS Pilot HTTP 端点，把响应写回 stdout。
 *
 * 用法（客户端配置里写这个）：
 *   { "command": "node", "args": ["<绝对路径>/vps-pilot-mcp.js"] }
 *
 * 或带参数：
 *   node vps-pilot-mcp.js --port 39321 --token <token>
 *
 * 协议规矩：stdout 只走协议数据，所有日志一律 stderr。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 39321;

const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const kv = argv.find((a) => a.startsWith(`--${name}=`));
  return kv ? kv.slice(name.length + 3) : null;
}

const log = (msg) => process.stderr.write(`[vps-pilot-mcp] ${msg}\n`);

/** 读取应用配置文件，拿到端口与 Token */
function loadConfig() {
  const candidates = [
    process.env.VPSPILOT_STORE,
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'vps-pilot',
      'vpspilot-store.json'
    ),
    path.join(os.homedir(), 'Library', 'Application Support', 'vps-pilot', 'vpspilot-store.json'),
    path.join(os.homedir(), '.config', 'vps-pilot', 'vpspilot-store.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const mcp = raw?.settings?.mcp;
      if (mcp) return { port: mcp.httpPort || DEFAULT_PORT, token: mcp.token || '', source: p };
    } catch (e) {
      log(`读取配置失败 ${p}: ${e.message}`);
    }
  }
  return { port: DEFAULT_PORT, token: '', source: null };
}

const cfg = loadConfig();
const PORT = Number(argOf('port')) || cfg.port || DEFAULT_PORT;
const TOKEN = argOf('token') ?? cfg.token ?? '';

log(`目标端点 http://127.0.0.1:${PORT}/mcp`);
log(TOKEN ? `Token 已就绪（${String(TOKEN).length} 字符）` : '警告：未找到 Token，鉴权会失败');
if (cfg.source) log(`配置来源 ${cfg.source}`);

let sessionId = null;
let alive = true;

/** 把一条 JSON-RPC 消息 POST 给主应用 */
function forward(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'application/json, text/event-stream',
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers },
      (res) => {
        if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id'];

        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: out, contentType: res.headers['content-type'] || '' });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.write(body);
    req.end();
  });
}

const out = (obj) => {
  if (!alive) return;
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (e) {
    log(`写 stdout 失败：${e.message}`);
  }
};

/** 把上游响应解析成若干条 JSON-RPC 消息 */
function extractMessages(body, contentType) {
  const text = String(body || '').trim();
  if (!text) return [];

  // SSE 形式：每行 "data: {...}"
  if (contentType.includes('text/event-stream') || text.startsWith('event:') || text.includes('\ndata: ')) {
    const msgs = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const json = t.slice(5).trim();
      if (!json) continue;
      try {
        msgs.push(JSON.parse(json));
      } catch {
        /* 跳过 */
      }
    }
    return msgs;
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    log(`上游返回的不是合法 JSON：${text.slice(0, 200)}`);
    return [];
  }
}

let buffer = '';
let chain = Promise.resolve();

function handleLine(line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    // 解析失败也要按 JSON-RPC 规矩回错，客户端才知道发生了什么
    out({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return Promise.resolve();
  }

  const isNotification = payload && payload.id === undefined;

  return forward(payload).then((r) => {
    if (r.status === 0) {
      log(`无法连接 VPS Pilot（${r.error}）。请确认应用已启动且「设置 → MCP 服务」已开启。`);
      if (!isNotification) {
        out({
          jsonrpc: '2.0',
          id: payload.id ?? null,
          error: {
            code: -32603,
            message: `无法连接 VPS Pilot: ${r.error}。请在应用「设置 → MCP 服务」中确认总开关已打开。`,
          },
        });
      }
      return;
    }

    if (r.status !== 200) {
      if (!isNotification) {
        out({
          jsonrpc: '2.0',
          id: payload.id ?? null,
          error: { code: -32603, message: `上游返回 HTTP ${r.status}` },
        });
      }
      return;
    }

    // 通知没有响应体，无需回写
    for (const m of extractMessages(r.body, r.contentType)) out(m);
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  if (buffer.length > 8 * 1024 * 1024) {
    log('单行超过 8MB，丢弃缓冲');
    buffer = '';
    return;
  }

  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    // 串行转发：保证响应顺序与请求一致，也避免多个请求抢同一 session
    chain = chain.then(() => handleLine(line)).catch((e) => log(`处理失败：${e.message}`));
  }
});

function shutdown(reason) {
  if (!alive) return;
  alive = false;
  log(`退出：${reason}`);
  process.exit(0);
}

process.stdin.on('end', () => shutdown('stdin 关闭'));
process.stdin.on('error', (e) => shutdown(`stdin 错误 ${e.message}`));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// stdout 被客户端关闭（管道破裂）时安静退出
process.stdout.on('error', () => shutdown('stdout 关闭'));

log('stdio 转发通道已就绪');

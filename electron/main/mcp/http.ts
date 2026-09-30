/**
 * Streamable HTTP 传输
 *
 * 适用场景：豆包 / Kimi 这类客户端填一个 URL 即可连上，可以常驻被多个客户端
 * 同时使用（stdio 做不到）。
 *
 * 实现要点：
 *  1. 只监听 127.0.0.1。这个服务能控制本机 SSH 会话，绝不能暴露到局域网。
 *  2. Bearer Token 鉴权。比较用恒定时间算法，避免时序侧信道。
 *     Token 为空时跳过校验 —— 仅推荐在完全可信的本机环境这么用，界面会警告。
 *  3. POST /mcp 收 JSON-RPC，按 Accept 决定回 JSON 还是 SSE。
 *  4. GET /mcp 建立 SSE 长连接，用于服务端主动推送（审批请求等）。
 *  5. Mcp-Session-Id 头贯穿会话，客户端不带时服务端自动下发。
 *  6. 手写 CORS 头，让本地 web 版客户端也能连（Origin 含 localhost 才放行）。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { McpServer } from './server';
import { stringify, err, RPC_ERRORS } from './jsonrpc';

export interface HttpHandle {
  close: () => Promise<void>;
  readonly port: number;
  readonly listening: boolean;
  /** 向所有已连接的 SSE 客户端广播一条消息 */
  broadcast: (msg: any) => void;
  /** 当前 SSE 连接数 */
  readonly sseClients: number;
}

export interface HttpOptions {
  port: number;
  /** 访问令牌，空字符串表示不校验 */
  token: string;
  /** 日志口 */
  log?: (msg: string) => void;
  /** 仅用于测试：注入已有 server 实例 */
  host?: string;
}

/**
 * 恒定时间字符串比较。
 * 长度不同时也要走完整轮比较，避免通过耗时差推断 Token 长度。
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  const len = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  ab.copy(pa);
  bb.copy(pb);
  const same = crypto.timingSafeEqual(pa, pb);
  return same && ab.length === bb.length;
}

function extractToken(req: http.IncomingMessage): string {
  // 标准 Bearer；也兼容 X-MCP-Token / ?token= 这两种常见的客户端写法
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  const x = req.headers['x-mcp-token'];
  if (typeof x === 'string' && x) return x.trim();
  try {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const q = u.searchParams.get('token');
    if (q) return q;
  } catch {
    /* ignore */
  }
  return '';
}

function setCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    } catch {
      ok = false;
    }
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, X-MCP-Token, Accept, Last-Event-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '600');
}

function readBody(req: http.IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: any): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export async function startHttp(server: McpServer, opts: HttpOptions): Promise<HttpHandle> {
  const host = opts.host ?? '127.0.0.1';
  const log = opts.log ?? ((m: string) => process.stderr.write(`[mcp:http] ${m}\n`));
  const sseClients = new Set<http.ServerResponse>();

  const httpServer = http.createServer(async (req, res) => {
    setCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '/';
    }

    // 健康检查不需要鉴权，方便用户用浏览器确认端口通了
    if (pathname === '/health') {
      json(res, 200, { ok: true, server: 'vps-pilot', sessions: server.sessionCount });
      return;
    }

    if (pathname !== '/' && pathname !== '/mcp') {
      json(res, 404, { error: 'not found', hint: 'MCP 端点为 /mcp' });
      return;
    }

    // 鉴权
    if (opts.token) {
      const provided = extractToken(req);
      if (!provided || !safeEqual(provided, opts.token)) {
        json(res, 401, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32001,
            message: '未授权：请提供正确的 Bearer Token（见 VPS Pilot 设置 → MCP 服务）',
          },
        });
        return;
      }
    }

    /* ---------- GET：SSE 长连接 ---------- */
    if (req.method === 'GET') {
      const accept = String(req.headers.accept ?? '');
      if (!accept.includes('text/event-stream')) {
        json(res, 405, {
          error: 'GET 需要 Accept: text/event-stream',
          hint: '发送 JSON-RPC 请用 POST /mcp',
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      log(`SSE 客户端接入，当前 ${sseClients.size} 个`);

      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 25000);

      const cleanup = () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
        log(`SSE 客户端断开，剩余 ${sseClients.size} 个`);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    /* ---------- DELETE：显式结束会话 ---------- */
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] ?? '');
      if (sid) server.dropSession(sid);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- POST：JSON-RPC 主通道 ---------- */
    if (req.method !== 'POST') {
      json(res, 405, { error: '方法不允许，MCP 支持 GET / POST / DELETE' });
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (e: any) {
      json(res, 413, err(null, RPC_ERRORS.INVALID_REQUEST, e?.message ?? '读取请求体失败'));
      return;
    }

    // 会话：客户端带就用它的，不带就下发一个
    let sid = String(req.headers['mcp-session-id'] ?? '');
    let isNewSession = false;
    if (!sid) {
      sid = server.createSession();
      isNewSession = true;
    } else if (!server.getSession(sid)) {
      // 会话已过期 —— 新建一个，让客户端无感恢复
      sid = server.createSession();
      isNewSession = true;
    }
    res.setHeader('Mcp-Session-Id', sid);

    const accept = String(req.headers.accept ?? '');
    const wantsSse = accept.includes('text/event-stream');

    let result: any;
    try {
      result = await server.handleLine(body, sid);
    } catch (e: any) {
      json(res, 200, err(null, RPC_ERRORS.INTERNAL_ERROR, e?.message ?? String(e)));
      return;
    }

    if (!result.response) {
      // 纯通知：按规范回 202 且无正文
      res.writeHead(202);
      res.end();
      return;
    }

    const payload = Array.isArray(result.response)
      ? result.response
      : result.response;

    if (wantsSse) {
      // 客户端接受 SSE：用 data: 行回包，这符合 Streamable HTTP 的双模式约定
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) {
        res.write(`event: message\ndata: ${stringify(item)}\n\n`);
      }
      res.end();
      return;
    }

    json(res, 200, payload);
    const label = isNewSession ? '（新会话）' : '';
    log(`已处理 POST${label}`);
  });

  // 只绑定回环地址
  await new Promise<void>((resolve, reject) => {
    const onError = (e: any) => {
      httpServer.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(opts.port, host);
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  log(`HTTP 服务已监听 http://${host}:${actualPort}/mcp${opts.token ? '（需 Token）' : '（⚠ 未设 Token）'}`);

  return {
    port: actualPort,
    listening: true,
    get sseClients() {
      return sseClients.size;
    },
    broadcast(msg: any) {
      const line = `event: message\ndata: ${stringify(msg)}\n\n`;
      for (const c of sseClients) {
        try {
          c.write(line);
        } catch {
          sseClients.delete(c);
        }
      }
    },
    async close() {
      for (const c of sseClients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // 单连接不活跃时 close 可能挂住，兜底踢一脚
        setTimeout(resolve, 1500);
      });
      log('HTTP 服务已停止');
    },
  };
}

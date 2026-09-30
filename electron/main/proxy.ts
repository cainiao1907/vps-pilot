import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { ProxyConfig, ProxyTestResult } from '@shared/types';
import { decryptSecret } from './secure-store';

/**
 * 代理隧道
 *
 * 目标：让 SSH 流量能穿过本机代理软件（Clash / v2rayN / Shadowsocks 等）到达 VPS。
 *
 * 做法：
 *   1. 先和代理服务器建立一条普通 TCP 连接
 *   2. 在这条连接上按协议规约"请求转发到 <目标主机>:<目标端口>"
 *   3. 协商成功后，这条 TCP 连接就变成了一条到目标的透明管道
 *   4. 把它交给 ssh2 的 `ConnectConfig.sock`，SSH 握手就跑在这条管道里
 *
 * 之所以不直接依赖某个代理客户端，是因为 ssh2 原生不支持代理，
 * 但开放了 `sock` 参数 —— 只要我们能造出一条"看起来像 socket"的 Duplex 流即可。
 *
 * 支持两种协议：
 *   - SOCKS5（RFC 1928）：通用性最好，Clash / v2rayN / ss-local 都支持
 *   - HTTP CONNECT（RFC 7231 §4.3.6）：几乎所有 HTTP 代理都支持，包括企业网关
 */

/** 代理相关的可读错误 */
export class ProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyError';
  }
}

/** 把各种错误统一转成能给用户看的中文说明 */
function describeNetError(err: NodeJS.ErrnoException, proxy: ProxyConfig): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return `代理 ${proxy.host}:${proxy.port} 拒绝连接 —— 代理软件没有在运行，或端口填错了`;
    case 'ETIMEDOUT':
      return `连接代理 ${proxy.host}:${proxy.port} 超时 —— 端口可能被防火墙拦截`;
    case 'ENOTFOUND':
      return `找不到代理主机 ${proxy.host} —— 地址拼写可能有误`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `无法访问代理主机 ${proxy.host} —— 检查网络连接`;
    default:
      return `连接代理失败：${err.message}`;
  }
}

/** 状态行 / 响应行的读取上限，防止恶意/异常响应把内存吃爆 */
const MAX_HEADER_BYTES = 16 * 1024;

/**
 * 建立到代理服务器的 TCP 连接
 */
function dialProxy(proxy: ProxyConfig, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: proxy.host, port: proxy.port });

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };

    const onConnect = () => done();
    const onError = (err: NodeJS.ErrnoException) => done(new ProxyError(describeNetError(err, proxy)));

    socket.setTimeout(timeoutMs, () => {
      done(new ProxyError(`连接代理 ${proxy.host}:${proxy.port} 超时（${timeoutMs}ms）`));
    });
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

/* ============ SOCKS5 ============ */

const SOCKS_VERSION = 0x05;
const SOCKS_AUTH_NONE = 0x00;
const SOCKS_AUTH_USERPASS = 0x02;
const SOCKS_AUTH_UNACCEPTABLE = 0xff;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYP_IPV4 = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;

/** SOCKS5 回复码 -> 人话 */
const SOCKS_REPLY_TEXT: Record<number, string> = {
  0x01: '代理内部错误',
  0x02: '代理规则不允许连接该目标',
  0x03: '目标网络不可达',
  0x04: '目标主机不可达',
  0x05: '目标拒绝连接',
  0x06: 'TTL 超时',
  0x07: '代理不支持该命令',
  0x08: '代理不支持该地址类型',
};

/** 读满 n 字节 */
function readExactly(
  socket: net.Socket,
  n: number,
  holder: BufferSink,
  closedHint = '代理在协商过程中关闭了连接'
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      holder.push(chunk);
      if (holder.length >= n) {
        cleanup();
        resolve(holder.consume(n));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new ProxyError(closedHint));
    };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    // 已经有缓冲数据了，先看看够不够
    if (holder.length >= n) {
      cleanup();
      resolve(holder.consume(n));
    }
  });
}

/** 一个极简的字节缓冲器：把 socket 上收到的碎片拼成完整的协议帧 */
class BufferSink {
  private chunks: Buffer[] = [];
  private size = 0;

  get length(): number {
    return this.size;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > MAX_HEADER_BYTES) this.chunks = [Buffer.concat(this.chunks)];
  }

  /** 取出前 n 字节，剩余的留在缓冲里 */
  consume(n: number): Buffer {
    const all = Buffer.concat(this.chunks);
    this.chunks = all.length > n ? [all.subarray(n)] : [];
    this.size = all.length - n;
    return all.subarray(0, n);
  }

  /** 取出全部并清空 */
  drain(): Buffer {
    const all = Buffer.concat(this.chunks);
    this.chunks = [];
    this.size = 0;
    return all;
  }

  /** 看一眼全部内容但不清空 */
  peekAll(): Buffer {
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
  }
}

/** SOCKS5 完整流程：问候 -> 认证 -> CONNECT */
async function socks5Handshake(
  socket: net.Socket,
  target: { host: string; port: number },
  proxy: ProxyConfig
): Promise<void> {
  const sink = new BufferSink();
  const user = proxy.username ?? '';
  const pass = decryptSecret(proxy.encryptedPassword);
  const needAuth = !!user;

  // ---- 步骤 1：问候，声明我们支持的认证方式 ----
  const methods = needAuth ? [SOCKS_AUTH_NONE, SOCKS_AUTH_USERPASS] : [SOCKS_AUTH_NONE];
  socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));

  const greeting = await readExactly(
    socket,
    2,
    sink,
    '代理没有回应 SOCKS5 问候就断开了连接 —— 该端口上跑的可能不是 SOCKS5 代理。' +
      '若你的代理软件同时提供 HTTP 与 SOCKS 端口（例如 Clash 的 7890/7891），请确认协议类型选对了。'
  );
  if (greeting[0] !== SOCKS_VERSION) {
    throw new ProxyError(`代理返回的 SOCKS 版本是 ${greeting[0]}，不是 5 —— 端口上跑的可能不是 SOCKS5 代理`);
  }
  const method = greeting[1];
  if (method === SOCKS_AUTH_UNACCEPTABLE) {
    throw new ProxyError(
      needAuth
        ? '代理拒绝了所有认证方式 —— 请确认代理服务器的认证配置'
        : '代理要求用户名/密码认证，但你没有填写 —— 请补上代理用户名和密码'
    );
  }

  // ---- 步骤 2：用户名/密码认证（RFC 1929）----
  if (method === SOCKS_AUTH_USERPASS) {
    if (!needAuth) {
      throw new ProxyError('代理要求用户名/密码认证 —— 请填写代理用户名和密码');
    }
    const u = Buffer.from(user, 'utf8');
    const p = Buffer.from(pass, 'utf8');
    const req = Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]);
    socket.write(req);

    const resp = await readExactly(socket, 2, sink);
    if (resp[1] !== 0x00) {
      throw new ProxyError('代理用户名或密码不正确');
    }
  }

  // ---- 步骤 3：CONNECT 请求 ----
  const hostBuf = Buffer.from(target.host, 'utf8');
  // 优先用域名形式提交，让代理服务器自己解析 —— 这样能正确处理被代理端 DNS 污染的情况
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(target.host);
  const addrPart = isIpv4
    ? Buffer.concat([
        Buffer.from([SOCKS_ATYP_IPV4]),
        Buffer.from(target.host.split('.').map((x) => Number(x))),
      ])
    : Buffer.concat([Buffer.from([SOCKS_ATYP_DOMAIN, hostBuf.length]), hostBuf]);

  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(target.port, 0);

  socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, SOCKS_CMD_CONNECT, 0x00]), addrPart, portBuf]));

  // 先读 4 字节固定头，再按 ATYP 读变长的地址 + 2 字节端口
  const head = await readExactly(socket, 4, sink);
  if (head[1] !== 0x00) {
    const text = SOCKS_REPLY_TEXT[head[1]] ?? `未知错误码 0x${head[1].toString(16)}`;
    throw new ProxyError(`代理无法连接到 ${target.host}:${target.port} —— ${text}`);
  }

  const atyp = head[3];
  const addrLen = atyp === SOCKS_ATYP_IPV4 ? 4 : atyp === SOCKS_ATYP_DOMAIN ? null : atyp === 0x04 ? 16 : 0;
  if (addrLen === null) {
    const lenBuf = await readExactly(socket, 1, sink);
    await readExactly(socket, lenBuf[0] + 2, sink);
  } else if (addrLen > 0) {
    await readExactly(socket, addrLen + 2, sink);
  }

  // 把协商期间多读到的字节还回流里（理论上不会有，保险起见）
  const leftover = sink.drain();
  if (leftover.length) socket.unshift(leftover);
}

/* ============ HTTP CONNECT ============ */

/** HTTP CONNECT 流程 */
async function httpConnectHandshake(
  socket: net.Socket,
  target: { host: string; port: number },
  proxy: ProxyConfig
): Promise<void> {
  const sink = new BufferSink();
  const user = proxy.username ?? '';
  const pass = decryptSecret(proxy.encryptedPassword);

  // 目标用 IPv6 时方括号包起来
  const hostPart = target.host.includes(':') ? `[${target.host}]` : target.host;
  const lines = [
    `CONNECT ${hostPart}:${target.port} HTTP/1.1`,
    `Host: ${hostPart}:${target.port}`,
    'Proxy-Connection: Keep-Alive',
  ];
  if (user) {
    const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  lines.push('', '');

  socket.write(lines.join('\r\n'));

  // 逐块读到 \r\n\r\n 为止。
  // 注意：必须自己累积缓冲、不能在 socket 上反复挂 data 监听，
  // 否则先到的字节会被前一个监听器消耗掉（这里踩过一次坑）。
  await readUntil(socket, sink, (buf) => buf.indexOf('\r\n\r\n') >= 0, '代理返回的响应头过长，已放弃');

  const headerEnd = sink.peekAll().indexOf('\r\n\r\n');
  const headerBytes = sink.consume(headerEnd + 4);
  const headerText = headerBytes.subarray(0, headerEnd).toString('latin1');
  // 隧道数据紧随其后，还回去
  const payload = sink.drain();

  const statusLine = headerText.split('\r\n')[0] ?? '';
  const m = /^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/.exec(statusLine.trim());
  if (!m) {
    throw new ProxyError(
      `代理返回了无法识别的响应：${statusLine.slice(0, 120) || '(空)'} —— 端口上跑的可能不是 HTTP 代理`
    );
  }

  const code = Number(m[1]);
  if (code !== 200) {
    // 优先给出可操作的中文提示；代理自带的 reason phrase 附在后面作为补充
    const hint = httpStatusHint(code);
    const reason = m[2]?.trim();
    const detail = hint !== '未知原因' ? hint : reason || '未知原因';
    throw new ProxyError(`代理拒绝了 CONNECT 请求（HTTP ${code}）—— ${detail}`);
  }

  if (payload.length) socket.unshift(payload);
}

/**
 * 从 socket 持续累积数据，直到 predicate 满足
 */
function readUntil(
  socket: net.Socket,
  sink: BufferSink,
  predicate: (buf: Buffer) => boolean,
  overflowMsg: string,
  maxBytes = MAX_HEADER_BYTES
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      sink.push(chunk);
      if (predicate(sink.peekAll())) {
        cleanup();
        resolve();
        return;
      }
      if (sink.length > maxBytes) {
        cleanup();
        reject(new ProxyError(overflowMsg));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new ProxyError('代理在响应过程中关闭了连接'));
    };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    // 之前缓冲里可能已经够了
    if (predicate(sink.peekAll())) {
      cleanup();
      resolve();
    }
  });
}

function httpStatusHint(code: number): string {
  if (code === 407) return '需要代理认证 —— 请填写代理用户名和密码';
  if (code === 403) return '代理策略禁止访问该目标';
  if (code === 404) return '代理找不到目标';
  if (code === 502 || code === 503 || code === 504) return '代理无法连接到目标主机（代理侧出站不通或目标不可达）';
  return '未知原因';
}

/* ============ 对外接口 ============ */

export interface TunnelTarget {
  host: string;
  port: number;
}

/**
 * 通过代理建立一条到目标的隧道流
 *
 * 返回的 Duplex 可以直接塞进 ssh2 的 ConnectConfig.sock。
 */
export async function openProxyTunnel(
  proxy: ProxyConfig,
  target: TunnelTarget,
  timeoutMs = 20000
): Promise<Duplex> {
  const socket = await dialProxy(proxy, timeoutMs);

  // 协商阶段之后，socket 就不再需要超时了 —— SSH 自己有心跳
  socket.setTimeout(0);

  // 协商阶段总时限：dialProxy 只管到"TCP 建好"，握手本身也可能僵住
  // （典型场景：把 SOCKS5 客户端连到 HTTP 代理端口上，双方都在等对方先说话）
  const handshakeTimer = setTimeout(() => {
    socket.destroy();
  }, timeoutMs);

  try {
    if (proxy.type === 'socks5') {
      await socks5Handshake(socket, target, proxy);
    } else if (proxy.type === 'http') {
      await httpConnectHandshake(socket, target, proxy);
    } else {
      throw new ProxyError('代理类型未设置');
    }
  } catch (e) {
    clearTimeout(handshakeTimer);
    socket.destroy();
    throw e;
  }
  clearTimeout(handshakeTimer);

  socket.setNoDelay(true);
  return socket;
}

/**
 * 代理可用性测试
 *
 * 方式：通过代理连一个众所周知的公网 SSH 端口（GitHub:22），
 * 只要能完成"TCP + 代理协商"就说明代理本身能出网。
 * 不校验 SSH banner，因为不同代理的出口位置看到的响应可能不同，
 * 且这里的目的只是验证"代理能不能通"。
 */
export async function testProxy(proxy: ProxyConfig, timeoutMs = 8000): Promise<ProxyTestResult> {
  if (proxy.type === 'none') return { ok: true, message: '未启用代理（直连）' };
  if (!proxy.host?.trim()) return { ok: false, message: '代理地址为空' };
  if (!proxy.port) return { ok: false, message: '代理端口为空' };

  const started = Date.now();
  try {
    const stream = await openProxyTunnel(proxy, { host: 'github.com', port: 22 }, timeoutMs);
    const ms = Date.now() - started;
    stream.destroy();
    return {
      ok: true,
      ms,
      message: `代理可用（${proxy.type === 'socks5' ? 'SOCKS5' : 'HTTP'} → github.com:22，${ms}ms）`,
    };
  } catch (e: any) {
    return {
      ok: false,
      ms: Date.now() - started,
      message: e?.message ?? String(e),
    };
  }
}

/** 供诊断使用的导出（单元测试友好） */
export const __internals = { BufferSink, describeNetError };

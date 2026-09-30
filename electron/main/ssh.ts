import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import fs from 'node:fs';
import type { ExecResult, HostConfig, ProxyConfig, SftpEntry } from '@shared/types';
import { decryptSecret } from './secure-store';
import { getHost, getSettings } from './db';
import { openProxyTunnel } from './proxy';
import { resolveProxyForHost, proxyLabel, isProxyUsable } from './proxy-resolve';

/**
 * SSH 连接管理
 *
 * 一个 hostId 对应一个持久连接（含交互式 shell）
 * 命令执行复用同一连接开新 channel，避免频繁握手
 */

interface ManagedConn {
  hostId: string;
  client: Client;
  shell?: ClientChannel;
  status: 'connecting' | 'connected' | 'error';
  error?: string;
  connectedAt?: number;
}

const conns = new Map<string, ManagedConn>();

/** 根据主机配置构建 ssh2 连接参数 */
export function buildConnectConfig(host: HostConfig): ConnectConfig {
  const settings = getSettings();
  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: settings.connectTimeoutMs ?? 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 6,
  };

  if (host.authType === 'password') {
    cfg.password = decryptSecret(host.encryptedPassword);
  } else if (host.authType === 'privateKey') {
    if (host.privateKeyPath && fs.existsSync(host.privateKeyPath)) {
      cfg.privateKey = fs.readFileSync(host.privateKeyPath);
      const pass = decryptSecret(host.encryptedPassphrase);
      if (pass) cfg.passphrase = pass;
    }
  } else {
    // agent 转发
    if (process.env.SSH_AUTH_SOCK) {
      cfg.agent = process.env.SSH_AUTH_SOCK;
    }
  }

  return cfg;
}

/**
 * 建立代理隧道
 *
 * 返回一条已经打通到目标 SSH 端口的 Duplex 流，可直接赋给 ConnectConfig.sock。
 * 没配代理时返回 undefined。
 */
async function buildProxySock(
  host: HostConfig
): Promise<{ sock?: any; proxy?: ProxyConfig }> {
  const proxy = resolveProxyForHost(host);
  if (!isProxyUsable(proxy)) return {};

  const settings = getSettings();
  const timeout = Math.max(5000, Math.min(30000, settings.connectTimeoutMs ?? 20000));
  try {
    const sock = await openProxyTunnel(proxy, { host: host.host, port: host.port }, timeout);
    return { sock, proxy };
  } catch (e: any) {
    const err = new Error(`${proxyLabel(proxy)} 隧道建立失败：${e?.message ?? e}`);
    (err as any).proxyStage = true;
    throw err;
  }
}

/** 建立（或复用）到主机的连接，支持代理与跳板机 */
export async function connect(hostId: string): Promise<{ ok: boolean; error?: string }> {
  const existing = conns.get(hostId);
  if (existing && existing.status === 'connected') return { ok: true };

  const host = getHost(hostId);
  if (!host) return { ok: false, error: '主机不存在' };

  // 先建代理隧道（若有）—— SSH 握手将跑在这条隧道里
  let sock: any = undefined;
  try {
    const r = await buildProxySock(host);
    sock = r.sock;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }

  // 若配置了跳板机，在代理隧道之上再叠一层转发
  // 注意：出参 host 用目标地址，跳板机自身若也配了代理则由它自己的配置决定
  if (host.jumpHostId) {
    const jumpHost = getHost(host.jumpHostId);
    if (!jumpHost) return { ok: false, error: '跳板机配置不存在' };
    try {
      const jumpClient = new Client();
      let jumpSock: any = undefined;
      // 跳板机自己走不走代理，取决于跳板机那台主机的 proxyMode
      try {
        const jr = await buildProxySock(jumpHost);
        jumpSock = jr.sock;
      } catch (e: any) {
        return { ok: false, error: `跳板机的代理 ${e?.message ?? e}` };
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          try {
            jumpClient.end();
          } catch {
            /* ignore */
          }
          reject(err);
        };
        const timer = setTimeout(() => fail(new Error('跳板机连接超时')), 25000);
        jumpClient
          .on('ready', () => {
            jumpClient.forwardOut('127.0.0.1', 0, host.host, host.port, (err, stream) => {
              if (err) return fail(err);
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              sock = stream;
              resolve();
            });
          })
          .on('error', (err) => {
            clearTimeout(timer);
            fail(err);
          })
          .connect(jumpSock ? { ...buildConnectConfig(jumpHost), sock: jumpSock } : buildConnectConfig(jumpHost));
      });
    } catch (e: any) {
      return {
        ok: false,
        error: `跳板机连接失败：${e?.message ?? e}。提示：可先对跳板机执行「一键诊断」定位问题。`,
      };
    }
  }

  const client = new Client();
  const managed: ManagedConn = { hostId, client, status: 'connecting' };
  conns.set(hostId, managed);

  const cfg = buildConnectConfig(host);
  if (sock) cfg.sock = sock;

  // 隧道模式下 readyTimeout 从"TCP 建连"就开始了，给宽裕一点
  const hardTimeout = Math.max(25000, (getSettings().connectTimeoutMs ?? 20000) + 10000);

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时')), hardTimeout);
      client
        .on('ready', () => {
          clearTimeout(timer);
          resolve();
        })
        .on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        })
        .connect(cfg);
    });
    managed.status = 'connected';
    managed.connectedAt = Date.now();

    client.on('close', () => {
      managed.status = 'error';
      managed.error = '连接已断开';
      managed.shell = undefined;
    });

    return { ok: true };
  } catch (e: any) {
    managed.status = 'error';
    const raw = e?.message ?? String(e);
    // 把 ssh2 的英文报错翻成能指导行动的提示
    managed.error = /handshake|before handshake|Timed out while waiting/i.test(raw)
      ? `${raw} —— TCP 已建立但 SSH 握手未完成。常见原因：链路被中间设备干扰（可尝试启用代理），或服务器 SSH 端口被防火墙限速。建议对该主机执行「一键诊断」。`
      : raw;
    conns.delete(hostId);
    return { ok: false, error: managed.error };
  }
}

/** 断开连接 */
export function disconnect(hostId: string): void {
  const c = conns.get(hostId);
  if (!c) return;
  try {
    c.shell?.end();
    c.client.end();
  } catch {
    /* ignore */
  }
  conns.delete(hostId);
}

export function disconnectAll(): void {
  for (const id of Array.from(conns.keys())) disconnect(id);
}

export function getConn(hostId: string): ManagedConn | undefined {
  return conns.get(hostId);
}

/**
 * 打开交互式 shell，返回 channel
 * 数据流通过回调推给渲染进程
 */
export async function openShell(
  hostId: string,
  cols: number,
  rows: number,
  onData: (chunk: string) => void,
  onClose: (code?: number) => void
): Promise<ClientChannel> {
  const res = await connect(hostId);
  if (!res.ok) throw new Error(res.error ?? '连接失败');

  const managed = conns.get(hostId)!;
  const host = getHost(hostId);

  return new Promise<ClientChannel>((resolve, reject) => {
    managed.client.shell(
      {
        term: 'xterm-256color',
        cols,
        rows,
        width: cols * 8,
        height: rows * 17,
      },
      (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        managed.shell = stream;
        // 进入默认工作目录
        stream.on('data', (data: Buffer) => onData(data.toString('utf8')));
        stream.stderr?.on('data', (data: Buffer) => onData(data.toString('utf8')));
        stream.on('close', (code?: number) => {
          managed.shell = undefined;
          onClose(code);
        });
        resolve(stream);
      }
    );
  });
}

/** 向交互式 shell 写入（模拟键盘输入） */
export function writeShell(hostId: string, data: string): void {
  const c = conns.get(hostId);
  c?.shell?.write(data);
}

/** 调整终端大小 */
export function resizeShell(hostId: string, cols: number, rows: number): void {
  const c = conns.get(hostId);
  try {
    c?.shell?.setWindow(rows, cols, rows * 17, cols * 8);
  } catch {
    /* ignore */
  }
}

/**
 * 非交互执行命令（Agent 走这条路）
 * 使用 exec channel，会带起一个非登录 shell
 */
export async function exec(
  hostId: string,
  command: string,
  opts: { cwd?: string; timeoutSec?: number; maxChars?: number } = {}
): Promise<ExecResult> {
  const started = Date.now();
  const res = await connect(hostId);
  if (!res.ok) {
    return {
      ok: false,
      stdout: '',
      stderr: res.error ?? '连接失败',
      exitCode: null,
      durationMs: Date.now() - started,
    };
  }

  const managed = conns.get(hostId)!;
  const host = getHost(hostId);
  const cwd = opts.cwd || host?.defaultCwd || '';
  const maxChars = opts.maxChars ?? 200000;
  const timeoutSec = opts.timeoutSec ?? 120;

  // 包裹命令：切到工作目录 + 保留退出码
  const wrapped = cwd
    ? `cd ${shellQuote(cwd)} 2>/dev/null; ${command}`
    : command;

  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        stdout: '',
        stderr: `命令执行超时（${timeoutSec}s）`,
        exitCode: null,
        durationMs: Date.now() - started,
      });
    }, timeoutSec * 1000);

    managed.client.exec(wrapped, (err, stream) => {
      if (err) {
        finish({
          ok: false,
          stdout: '',
          stderr: err.message,
          exitCode: null,
          durationMs: Date.now() - started,
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;

      stream.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        if (stdout.length + s.length <= maxChars) stdout += s;
        else {
          stdout += s.slice(0, Math.max(0, maxChars - stdout.length));
          truncated = true;
        }
      });
      stream.stderr.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        if (stderr.length < 50000) stderr += s;
      });
      stream.on('close', (code: number | null) => {
        finish({
          ok: code === 0,
          stdout,
          stderr,
          exitCode: code,
          truncated,
          durationMs: Date.now() - started,
        });
      });
    });
  });
}

/** shell 单引号转义 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* ============ SFTP ============ */

export function withSftp<T>(hostId: string, fn: (sftp: any) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const managed = conns.get(hostId);
    if (!managed || managed.status !== 'connected') {
      reject(new Error('未连接到该主机'));
      return;
    }
    managed.client.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }
      fn(sftp)
        .then((r) => {
          try {
            sftp.end();
          } catch {
            /* ignore */
          }
          resolve(r);
        })
        .catch((e) => {
          try {
            sftp.end();
          } catch {
            /* ignore */
          }
          reject(e);
        });
    });
  });
}

/** 列出目录 */
export async function listDir(hostId: string, dir: string): Promise<SftpEntry[]> {
  return withSftp(hostId, (sftp) => {
    return new Promise<SftpEntry[]>((resolve, reject) => {
      sftp.readdir(dir, (err: any, list: any[]) => {
        if (err) {
          reject(err);
          return;
        }
        const entries: SftpEntry[] = list.map((item) => {
          const isDir = item.attrs.isDirectory();
          const isLink = item.attrs.isSymbolicLink();
          return {
            name: item.filename,
            path: dir === '/' ? `/${item.filename}` : `${dir.replace(/\/$/, '')}/${item.filename}`,
            type: isDir ? 'd' : isLink ? 'l' : 'f',
            size: item.attrs.size ?? 0,
            mtime: (item.attrs.mtime ?? 0) * 1000,
            mode: '0' + (item.attrs.mode & 0o777).toString(8),
          };
        });
        // 目录优先，然后按名称
        entries.sort((a, b) => {
          if (a.type === 'd' && b.type !== 'd') return -1;
          if (a.type !== 'd' && b.type === 'd') return 1;
          return a.name.localeCompare(b.name);
        });
        resolve(entries);
      });
    });
  });
}

/** 下载文件到本地 */
export async function downloadFile(hostId: string, remotePath: string, localPath: string): Promise<void> {
  return withSftp(hostId, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err: any) => (err ? reject(err) : resolve()));
    });
  });
}

/** 上传本地文件到远程 */
export async function uploadFile(hostId: string, localPath: string, remotePath: string): Promise<void> {
  return withSftp(hostId, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
  });
}

/** 用文本内容写入远程文件（用于部署配置） */
export async function writeRemoteFile(hostId: string, remotePath: string, content: string): Promise<void> {
  return withSftp(hostId, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => resolve());
      stream.on('error', (err: any) => reject(err));
      stream.end(Buffer.from(content, 'utf8'));
    });
  });
}

/** 读取远程文本文件（用于查看配置） */
export async function readRemoteFile(hostId: string, remotePath: string, maxBytes = 512000): Promise<string> {
  return withSftp(hostId, (sftp) => {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = sftp.createReadStream(remotePath, { start: 0, end: maxBytes });
      stream.on('data', (d: Buffer) => {
        chunks.push(d);
        total += d.length;
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', (err: any) => reject(err));
    });
  });
}

/** 删除远程文件或目录 */
export async function removeRemote(hostId: string, remotePath: string, isDir: boolean): Promise<void> {
  return withSftp(hostId, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      const cb = (err: any) => (err ? reject(err) : resolve());
      if (isDir) sftp.rmdir(remotePath, cb);
      else sftp.unlink(remotePath, cb);
    });
  });
}

/** 重命名 */
export async function renameRemote(hostId: string, from: string, to: string): Promise<void> {
  return withSftp(hostId, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err: any) => (err ? reject(err) : resolve()));
    });
  });
}

/** 创建目录 */
export async function mkdirRemote(hostId: string, remotePath: string): Promise<void> {
  return withSftp(hostId, (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
  });
}

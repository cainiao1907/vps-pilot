/**
 * stdio 传输
 *
 * 适用场景：WorkBuddy / ZCode / Kimi 这类支持「客户端自己拉起一个本地进程，
 * 通过 stdin/stdout 通信」的 MCP 客户端。
 *
 * 协议规矩（踩过坑的几点）：
 *  1. stdout 是协议通道，绝不能被日志污染。所有日志一律走 stderr。
 *  2. 一条消息一行（NDJSON），可能被拆成多个 chunk 到达，必须自己攒行。
 *  3. 收到 EOF（客户端关闭管道）时安静退出，不要报错。
 */

import type { McpServer } from './server';
import { stringify } from './jsonrpc';

export interface StdioHandle {
  close: () => void;
  /** 是否还在监听 */
  readonly alive: boolean;
}

export interface StdioOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** 日志输出口，默认 stderr */
  log?: (msg: string) => void;
}

export function startStdio(server: McpServer, opts: StdioOptions = {}): StdioHandle {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const log = opts.log ?? ((m: string) => process.stderr.write(`[mcp:stdio] ${m}\n`));

  let buffer = '';
  let alive = true;
  let chain: Promise<void> = Promise.resolve();

  const write = (msg: any) => {
    if (!alive) return;
    try {
      output.write(stringify(msg) + '\n');
    } catch (e: any) {
      log(`写响应失败：${e?.message ?? e}`);
    }
  };

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString('utf8');

    // 防止恶意/异常的超长行把内存吃光
    if (buffer.length > 8 * 1024 * 1024) {
      log('单行超过 8MB，丢弃缓冲');
      buffer = '';
      return;
    }

    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 串行处理：保证响应顺序与请求顺序一致，也避免并发改同一份运行状态
      chain = chain
        .then(async () => {
          const r = await server.handleLine(trimmed);
          if (r.response) {
            if (Array.isArray(r.response)) {
              for (const item of r.response) write(item);
            } else {
              write(r.response);
            }
          }
          if (r.shouldShutdown) {
            log('收到 shutdown，准备退出');
            cleanup();
          }
        })
        .catch((e: any) => {
          log(`处理请求失败：${e?.message ?? e}`);
        });
    }
  };

  const onEnd = () => {
    log('stdin 关闭，stdio 通道结束');
    cleanup();
  };

  const cleanup = () => {
    if (!alive) return;
    alive = false;
    try {
      (input as any).off?.('data', onData);
      (input as any).off?.('end', onEnd);
      (input as any).off?.('error', onEnd);
    } catch {
      /* ignore */
    }
  };

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', (e: any) => {
    log(`stdin 错误：${e?.message ?? e}`);
    cleanup();
  });

  log('stdio 通道已就绪');

  return {
    close: cleanup,
    get alive() {
      return alive;
    },
  };
}

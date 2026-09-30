/**
 * MCP 服务统一入口
 *
 * 对外只暴露 start / stop / reload / applySettings / getState 几个函数，
 * 其余细节（stdio、HTTP、会话、工具）都收在内部。
 *
 * 生命周期挂钩：
 *  - 应用启动（app.whenReady）→ 若设置里 enabled 则 start
 *  - 设置变更（settings:set）→ applySettings：开关/端口/Token 变化时热重载
 *  - 应用退出（before-quit / window-all-closed）→ stop，释放端口
 */

import type { McpSettings, McpStatus, McpClientSnippet } from '@shared/types';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { McpServer } from './server';
import { startStdio, type StdioHandle } from './stdio';
import { startHttp, type HttpHandle } from './http';
import * as handlers from './handlers';
import { listToolsFor } from './tools';
import { DEFAULT_MCP_PORT } from '@shared/presets';

let server: McpServer | null = null;
let stdioHandle: StdioHandle | null = null;
let httpHandle: HttpHandle | null = null;
let detachSink: (() => void) | null = null;
let activeSettings: McpSettings | null = null;
let lastError: string | null = null;
let startedAt: number | null = null;
let started = false;

type Broadcaster = (e: any) => void;
let broadcastFn: Broadcaster = () => {};

export function setBroadcaster(fn: Broadcaster): void {
  broadcastFn = fn;
  handlers.setBroadcaster(fn);
}

/** 当前 MCP 服务状态快照 */
export function getState(): McpStatus {
  const settings = activeSettings;
  return {
    enabled: !!settings?.enabled,
    stdioReady: !!stdioHandle?.alive,
    httpListening: !!httpHandle?.listening,
    httpPort: httpHandle?.port ?? null,
    lastError,
    startedAt,
    sessions: server?.sessionCount ?? 0,
    toolCount: server?.availableToolCount() ?? 0,
    callCount: handlers.getStatus().status.callCount,
    pendingApprovals: handlers.getStatus().status.pendingApprovals,
  };
}

function emitStatus(): void {
  try {
    broadcastFn({ type: 'mcp_status', status: getState() });
  } catch {
    /* ignore */
  }
}

/**
 * 启动 MCP 服务。
 *
 * `settings.enabled === false` 时什么都不做并返回 null。
 * 启动失败（比如端口被占用）不抛异常 —— 记录错误后返回 null，
 * 让应用照常运行，用户可以在设置页看到错误原因并改端口。
 */
export async function start(settings: McpSettings): Promise<McpStatus> {
  activeSettings = settings;
  lastError = null;

  if (!settings.enabled) {
    handlers.updateRuntimeStatus({ enabled: false });
    emitStatus();
    return getState();
  }

  if (started) {
    // 已启动：只做设置同步
    await applySettings(settings);
    return getState();
  }

  server = new McpServer(() => activeSettings ?? settings, {
    onCall: (info) => {
      try {
        broadcastFn({ type: 'mcp_call', ...info, ts: Date.now() });
      } catch {
        /* ignore */
      }
    },
  });

  // stdio：接管 stdin/stdout。仅在明确需要时启用（默认开，成本极低）。
  try {
    stdioHandle = startStdio(server);
  } catch (e: any) {
    lastError = `stdio 启动失败：${e?.message ?? e}`;
    console.error('[mcp]', lastError);
  }

  // HTTP
  if (settings.httpEnabled) {
    try {
      httpHandle = await startHttp(server, {
        port: settings.httpPort || DEFAULT_MCP_PORT,
        token: settings.token || '',
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      lastError =
        (e as any)?.code === 'EADDRINUSE'
          ? `端口 ${settings.httpPort} 已被占用，请换一个端口或关闭占用它的程序`
          : `HTTP 服务启动失败：${msg}`;
      console.error('[mcp]', lastError);
      httpHandle = null;
    }
  }

  detachSink = handlers.attachAgentEventSink();
  handlers.updateRuntimeStatus({
    enabled: true,
    stdioReady: !!stdioHandle?.alive,
    httpListening: !!httpHandle?.listening,
    httpPort: httpHandle?.port ?? null,
    toolCount: server.availableToolCount(),
    startedAt: Date.now(),
    lastError,
  });

  started = true;
  startedAt = Date.now();
  emitStatus();
  return getState();
}

/** 停止服务并释放端口 */
export async function stop(reason = '服务已关闭'): Promise<void> {
  handlers.releaseAllPending(reason);
  detachSink?.();
  detachSink = null;

  stdioHandle?.close();
  stdioHandle = null;

  if (httpHandle) {
    try {
      await httpHandle.close();
    } catch (e: any) {
      console.error('[mcp] 关闭 HTTP 失败', e);
    }
    httpHandle = null;
  }

  server?.clearSessions();
  server = null;
  started = false;
  startedAt = null;
  handlers.updateRuntimeStatus({
    enabled: false,
    stdioReady: false,
    httpListening: false,
    httpPort: null,
    startedAt: null,
  });
  emitStatus();
}

/**
 * 设置变更后的应用。
 *
 * 判断「需不需要重启」：端口、Token、HTTP 开关变化必须重启才能生效；
 * 只改审批策略 / 权限开关的话，工具门控每次调用都会读最新设置，无需重启。
 */
export async function applySettings(next: McpSettings): Promise<McpStatus> {
  const prev = activeSettings;
  activeSettings = next;

  const wasEnabled = !!prev?.enabled;
  if (!next.enabled) {
    if (wasEnabled) await stop('MCP 服务已被关闭');
    handlers.updateRuntimeStatus({ enabled: false });
    emitStatus();
    return getState();
  }

  const needsRestart =
    !wasEnabled ||
    !started ||
    (prev?.httpEnabled ?? false) !== next.httpEnabled ||
    (prev?.httpPort ?? 0) !== next.httpPort ||
    (prev?.token ?? '') !== next.token;

  if (needsRestart) {
    if (started) await stop('设置变更，重启中');
    return start(next);
  }

  handlers.updateRuntimeStatus({ enabled: true, toolCount: server?.availableToolCount() ?? 0 });
  emitStatus();
  return getState();
}

/** 供测试与状态查询：直接拿到 server 实例 */
export function getServer(): McpServer | null {
  return server;
}

/** 只读查询：状态 + 当前设置 */
export function status() {
  return { status: getState(), settings: activeSettings };
}

export function setActiveSettings(s: McpSettings): void {
  activeSettings = s;
}

/**
 * 解析 stdio 转发脚本的真实绝对路径。
 *
 * 客户端配置里必须写绝对路径 —— stdio 客户端是在自己的进程里
 * 直接 exec 这个命令，没有「包管理器自动找包」这回事。
 */
export function stdioScriptPath(): string | null {
  const candidates: string[] = [];

  // 打包态：extraResources 把脚本放在 resources/scripts/ 下
  try {
    candidates.push(path.join(process.resourcesPath, 'scripts', 'vps-pilot-mcp.js'));
  } catch {
    /* 纯 Node 环境下没有 process.resourcesPath */
  }

  // 应用目录（开发态仓库根 / 安装后的 app 目录）
  try {
    candidates.push(path.join(app.getAppPath(), 'scripts', 'vps-pilot-mcp.js'));
  } catch {
    /* ignore */
  }

  // 可执行文件旁边的 scripts/
  try {
    candidates.push(path.join(path.dirname(app.getPath('exe')), 'scripts', 'vps-pilot-mcp.js'));
  } catch {
    /* ignore */
  }

  // 兜底：从当前工作目录往上找。
  // 不用 __dirname 是因为这个模块会被纯 Node 的 ESM 测试直接加载，
  // 那里没有 CommonJS 的 __dirname。
  try {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
      const p = path.join(dir, 'scripts', 'vps-pilot-mcp.js');
      if (fs.existsSync(p)) {
        candidates.push(p);
        break;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* ignore */
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 生成各客户端的接入配置片段。
 * 直接给用户可粘贴的文本，省掉他们查文档的功夫。
 */
export function clientSnippets(settings: McpSettings): McpClientSnippet[] {
  const port = settings.httpPort || DEFAULT_MCP_PORT;
  const token = settings.token || '（未设置 Token）';
  const url = `http://127.0.0.1:${port}/mcp`;

  // stdio 方式指向本机真实存在的转发脚本，而不是一个并不存在的 npm 包。
  // 早先这里写的是 `npx -y vps-pilot-mcp`，照抄必然失败 —— 那个包从未发布。
  const script = stdioScriptPath();
  const stdioArgs = script
    ? [`"${script.replace(/\\/g, '/')}"`]
    : ['<vps-pilot 安装目录>/scripts/vps-pilot-mcp.js'];
  const stdioCmd = {
    command: 'node',
    args: stdioArgs,
  };
  const stdioCmdBash = `node ${stdioArgs.join(' ')}`;

  return [
    {
      key: 'workbuddy',
      label: 'WorkBuddy',
      hint: '在自定义连接器 / MCP 配置里加入下面这段（推荐 HTTP，可同时被多个工具使用）',
      lang: 'json',
      config: JSON.stringify(
        {
          mcpServers: {
            'vps-pilot': {
              type: 'http',
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2
      ),
    },
    {
      key: 'zcode',
      label: 'ZCode',
      hint: 'ZCode 直接拉起本地进程，用 stdio 最省事（脚本会自己找到端口和 Token）',
      lang: 'json',
      config: JSON.stringify(
        {
          mcpServers: {
            'vps-pilot': {
              command: stdioCmd.command,
              args: stdioCmd.args,
            },
          },
        },
        null,
        2
      ),
    },
    {
      key: 'kimi',
      label: 'Kimi',
      hint: '填 HTTP 地址与 Token 即可；若客户端不支持自定义 Header，可把 Token 拼在 URL 上',
      lang: 'json',
      config: JSON.stringify(
        {
          mcpServers: {
            'vps-pilot': {
              type: 'streamable-http',
              url: `${url}?token=${settings.token ? encodeURIComponent(settings.token) : ''}`,
            },
          },
        },
        null,
        2
      ),
    },
    {
      key: 'doubao',
      label: '豆包',
      hint: '豆包 MCP 接入通常走 HTTP。若配置项里没有 Token 输入框，请用上面的 URL 带参形式',
      lang: 'json',
      config: JSON.stringify(
        {
          mcpServers: [
            {
              name: 'vps-pilot',
              transport: 'http',
              endpoint: url,
              auth: { type: 'bearer', token },
            },
          ],
        },
        null,
        2
      ),
    },
    {
      key: 'claude-code',
      label: 'Claude Code / 通用 CLI',
      hint: '一行命令即可注册，适合任何支持 `claude mcp add` 风格的客户端',
      lang: 'bash',
      config:
        `# HTTP 方式（推荐，多个工具可共用）\n` +
        `claude mcp add --transport http vps-pilot ${url} \\\n` +
        `  --header "Authorization: Bearer ${settings.token || '<token>'}"\n\n` +
        `# 或 stdio 方式（客户端自己拉起转发进程）\n` +
        `claude mcp add vps-pilot -- ${stdioCmdBash}`,
    },
  ];
}

/** 生成一个新的随机 Token */
export function generateToken(): string {
  // 32 字节随机 → 64 位十六进制，足够抗暴力破解
  return crypto.randomBytes(32).toString('hex');
}

/** 是否已启动（供外部快速判断） */
export function isStarted(): boolean {
  return started;
}

/** 界面上的审批按钮回调：直接裁决一条待审批请求 */
export function decideApproval(id: string, approve: boolean): { ok: boolean; message?: string } {
  return handlers.decideApproval(id, approve);
}

/** 当前待审批列表（界面展示用） */
export function listPendingApprovals() {
  return handlers.listPendingApprovals();
}

/** 工具清单（界面预览用，按当前设置过滤） */
export function availableTools(settings: McpSettings) {
  return listToolsFor(settings);
}

/**
 * MCP 工具实现
 *
 * 所有会碰 SSH / Agent 的动作都在这里。三条硬规矩：
 *
 *  1. 写操作必过风险评估。`assessRisk` 的结果是唯一裁判，MCP 不能绕过。
 *     - `blocked`（critical）→ 直接拒绝，任何设置都放不出这个口子。
 *     - 其余按 `approvalPolicy` 决定是自动放行还是挂起等人在界面点确认。
 *  2. 审计来源记 `source='mcp'`，并额外记下是谁批的（人 / 客户端策略）。
 *  3. 审批挂起时，事件同时推给渲染进程，让用户在界面上看得见、点得到。
 *
 * 为了能在纯 Node 测试环境跑，这里不直接 import electron；需要窗口广播的
 * 地方走一个可替换的 `broadcaster`（由 mcp/index.ts 在启动时注入）。
 */

import type {
  McpApprovalPolicy,
  McpPendingApproval,
  McpSettings,
  RiskLevel,
} from '@shared/types';
import { assessRisk } from '@shared/risk';
import * as db from '../db';
import * as ssh from '../ssh';
import * as agent from '../agent';
import * as registry from '../registry';
import { terminalBuffer } from '../terminal-buffer';
import { ToolParamError, type ToolContext } from './tools';
import { shortId } from '../secure-store';

/* ============ 依赖注入点 ============ */

type Broadcaster = (e: any) => void;
let broadcastFn: Broadcaster = () => {};
/** 取当前设置；默认走 db，测试可替换 */
let settingsFn: () => any = () => db.getSettings();

export function setBroadcaster(fn: Broadcaster): void {
  broadcastFn = fn;
}

export function setSettingsProvider(fn: () => any): void {
  settingsFn = fn;
}

function getSettings(): any {
  return settingsFn();
}

function mcpSettings(): McpSettings {
  const s = getSettings();
  return s.mcp;
}

/* ============ 参数与格式化 ============ */

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…（已截断，原长 ${s.length} 字符）`;
}

/**
 * 把 MCP 传来的输入文本里的转义还原成真实控制字符。
 *
 * 外部 Agent 通过 JSON 传字符串时，`\r` 会被 JSON 解析成真实回车，
 * 但 `\\r`（双反斜杠）或字面量 `\r`（两个字符）也很常见 —— 模型经常
 * 写不清楚。这里统一把字面量转义序列还原，避免发出去的是一串字符。
 */
export function unescapeInput(raw: string): string {
  return raw
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function describePolicy(p: McpApprovalPolicy): string {
  switch (p) {
    case 'always':
      return '每次都需人工审批';
    case 'risky':
      return '仅高风险需人工审批';
    case 'never':
      return '免审批（高危命令仍会硬拦截）';
    default:
      return String(p);
  }
}

/* ============ 状态与查询 ============ */

let runtimeStatus: {
  enabled: boolean;
  stdioReady: boolean;
  httpListening: boolean;
  httpPort: number | null;
  lastError: string | null;
  startedAt: number | null;
  sessions: number;
  toolCount: number;
  callCount: number;
} = {
  enabled: false,
  stdioReady: false,
  httpListening: false,
  httpPort: null,
  lastError: null,
  startedAt: null,
  sessions: 0,
  toolCount: 0,
  callCount: 0,
};

export function updateRuntimeStatus(patch: Partial<typeof runtimeStatus>): void {
  runtimeStatus = { ...runtimeStatus, ...patch };
}

export function bumpCallCount(): void {
  runtimeStatus.callCount += 1;
}

export function getStatus() {
  const settings = mcpSettings();
  return {
    status: {
      ...runtimeStatus,
      enabled: settings.enabled,
      pendingApprovals: pendingApprovals.size,
    },
    settings,
  };
}

export function listHosts() {
  const hosts = db.listHosts();
  return hosts.map((h) => {
    const conn = ssh.getConn(h.id);
    return {
      id: h.id,
      name: h.name,
      host: h.host,
      port: h.port,
      username: h.username,
      tags: h.tags ?? [],
      note: h.note ?? '',
      status: conn?.status ?? 'disconnected',
      shellOpen: !!conn?.shell,
      bufferedLines: terminalBuffer.has(h.id) ? terminalBuffer.list().find((x) => x.hostId === h.id)?.lines ?? 0 : 0,
    };
  });
}

export function listSessions() {
  const out: Array<any> = [];
  for (const info of terminalBuffer.list()) {
    const host = db.getHost(info.hostId);
    const conn = ssh.getConn(info.hostId);
    out.push({
      hostId: info.hostId,
      hostName: host?.name ?? info.hostId,
      connected: conn?.status === 'connected',
      shellOpen: !!conn?.shell,
      bufferedLines: info.lines,
      lastSeq: info.lastSeq,
      droppedLines: info.droppedLines,
      closed: info.closed,
      lastAt: info.lastAt,
    });
  }
  return out;
}

export function listExperts() {
  return registry.listExperts(db.listCustomExperts()).map((e: any) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    category: e.category,
    builtin: !!e.builtin,
  }));
}

export function listSkills() {
  return registry.listSkills(db.listCustomSkills()).map((s: any) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    builtin: !!s.builtin,
  }));
}

/* ============ 连接管理 ============ */

export async function connectHost(
  hostId: string,
  opts: { openShell: boolean; cols: number; rows: number }
) {
  const host = db.getHost(hostId);
  if (!host) throw new ToolParamError(`主机不存在：${hostId}`);

  const settings = mcpSettings();
  if (!settings.autoConnect) {
    const existing = ssh.getConn(hostId);
    if (!existing || existing.status !== 'connected') {
      throw new ToolParamError(
        'MCP 自动连接已在设置中关闭，请先在界面上手动连接该主机'
      );
    }
  }

  const res = await ssh.connect(hostId);
  if (!res.ok) {
    return {
      ok: false,
      isError: true,
      message: `连接失败：${res.error ?? '未知错误'}`,
      hostId,
    };
  }

  let shellReady = false;
  if (opts.openShell) {
    const conn = ssh.getConn(hostId);
    if (!conn?.shell) {
      await ssh.openShell(
        hostId,
        opts.cols,
        opts.rows,
        (chunk) => {
          try {
            terminalBuffer.append(hostId, chunk);
          } catch (e) {
            console.error('[mcp:term:buffer]', e);
          }
          // 继续转发给界面，用户能实时看到 MCP 在做什么
          broadcastFn({ type: 'term_data', hostId, chunk });
        },
        () => {
          terminalBuffer.close(hostId);
          broadcastFn({ type: 'term_close', hostId });
        }
      );
    }
    shellReady = true;
  }

  return {
    ok: true,
    hostId,
    hostName: host.name,
    address: `${host.username}@${host.host}:${host.port}`,
    shellOpen: shellReady,
    message: shellReady
      ? `已连接 ${host.name}（${host.username}@${host.host}:${host.port}）并开启交互式 shell`
      : `已连接 ${host.name}（${host.username}@${host.host}:${host.port}）`,
  };
}

export function disconnectHost(hostId: string) {
  const host = db.getHost(hostId);
  ssh.disconnect(hostId);
  terminalBuffer.drop(hostId);
  return {
    ok: true,
    hostId,
    message: `已断开 ${host?.name ?? hostId}，并释放其终端缓冲`,
  };
}

/* ============ 审批闸门 ============ */

interface PendingRecord {
  pending: McpPendingApproval;
  resolve: (approved: boolean) => void;
}

const pendingApprovals = new Map<string, PendingRecord>();

export function listPendingApprovals(): McpPendingApproval[] {
  return Array.from(pendingApprovals.values()).map((p) => p.pending);
}

/**
 * 安全闸门：决定一次写操作是放行、拒绝，还是挂起等审批。
 *
 * 返回 `{ allow: true }` 表示可以继续；
 * 返回 `{ allow: false, message }` 表示不应执行（含被拒 / 拦截）。
 */
async function gateOperation(
  opts: {
    hostId: string;
    hostName: string;
    tool: string;
    command: string;
    /** 展示给用户看的动作描述 */
    action: string;
  },
  ctx: ToolContext
): Promise<{ allow: boolean; message?: string; risk: ReturnType<typeof assessRisk>; approvedBy: 'user' | 'mcp' | null }> {
  const settings = getSettings();
  const mcp = settings.mcp;
  const risk = assessRisk(opts.command, settings.extraDangerPatterns);

  // 第一道：critical 硬拦截，与审批策略无关
  if (risk.blocked) {
    logMcpAudit({
      hostId: opts.hostId,
      hostName: opts.hostName,
      command: opts.command,
      action: opts.action,
      exitCode: null,
      risk: risk.level,
      approved: false,
      approvedBy: 'mcp',
      durationMs: 0,
      output: `安全策略拦截：${risk.reasons.join('；')}`,
    });
    return {
      allow: false,
      message: `已被安全策略拦截，无法执行。原因：${risk.reasons.join('；')}`,
      risk,
      approvedBy: null,
    };
  }

  // 用户显式关掉了高危放行时，high 及以上也会被拦
  if (!mcp.allowDangerous && risk.level === 'high') {
    return {
      allow: false,
      message:
        '该操作风险等级为「高」，当前设置不允许 MCP 执行高危操作。' +
        '如需放行，请在「设置 → MCP 服务」中开启「允许高危命令」。' +
        `风险原因：${risk.reasons.join('；')}`,
      risk,
      approvedBy: null,
    };
  }

  // 第二道：按审批策略决定
  const needApproval =
    mcp.approvalPolicy === 'always' ||
    (mcp.approvalPolicy === 'risky' && (risk.level === 'high' || risk.requiresApproval));

  if (!needApproval) {
    return { allow: true, risk, approvedBy: 'mcp' };
  }

  // 挂起等人在界面审批
  const id = shortId('apv_');
  const pending: McpPendingApproval = {
    id,
    hostId: opts.hostId,
    hostName: opts.hostName,
    tool: opts.tool,
    command: opts.command,
    risk: risk.level,
    reasons: risk.reasons,
    ts: Date.now(),
    client: ctx.client,
  };

  const approved = await new Promise<boolean>((resolve) => {
    pendingApprovals.set(id, { pending, resolve });
    broadcastFn({ type: 'mcp_approval', pending });
    // 同时推给 Agent 面板之外的通用审批提示位
    broadcastFn({ type: 'approval', pending });
  });

  pendingApprovals.delete(id);
  broadcastFn({ type: 'approval_done', id, approved });

  if (!approved) {
    logMcpAudit({
      hostId: opts.hostId,
      hostName: opts.hostName,
      command: opts.command,
      action: opts.action,
      exitCode: null,
      risk: risk.level,
      approved: false,
      approvedBy: 'user',
      durationMs: 0,
      output: '用户拒绝执行',
    });
    return { allow: false, message: '用户拒绝了这次操作。', risk, approvedBy: 'user' };
  }

  return { allow: true, risk, approvedBy: 'user' };
}

/** 供外部（界面 / MCP 工具）裁决一条待审批 */
export function decideApproval(id: string, approve: boolean, _ctx?: ToolContext) {
  const rec = pendingApprovals.get(id);
  if (!rec) {
    return { ok: false, isError: true, message: `待审批请求不存在或已处理：${id}` };
  }
  pendingApprovals.delete(id);
  rec.resolve(approve);
  broadcastFn({ type: 'approval_done', id, approved: approve });
  return {
    ok: true,
    message: approve ? `已批准 ${id}，操作将继续执行` : `已拒绝 ${id}`,
  };
}

function logMcpAudit(opts: {
  hostId: string | null;
  hostName: string | null;
  command: string;
  action: string;
  exitCode: number | null;
  risk: RiskLevel;
  approved: boolean | null;
  approvedBy: 'user' | 'mcp' | null;
  durationMs: number;
  output: string;
  client?: string;
}): void {
  const settings = getSettings();
  if (!settings.auditEnabled || !settings.mcp?.auditEnabled) return;
  try {
    db.insertAudit({
      ts: Date.now(),
      hostId: opts.hostId,
      hostName: opts.hostName,
      source: 'mcp',
      action: opts.action,
      command: opts.command,
      exitCode: opts.exitCode,
      risk: opts.risk,
      approved: opts.approved,
      approvedBy: opts.approvedBy ?? undefined,
      client: opts.client,
      outputSummary: truncate(opts.output, 4000),
      durationMs: opts.durationMs,
    });
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/* ============ 终端读写 ============ */

export function readTerminalOutput(
  hostId: string,
  opts: { sinceSeq?: number; tailLines?: number; maxChars?: number; stripAnsi?: boolean }
) {
  const host = db.getHost(hostId);
  if (!host) throw new ToolParamError(`主机不存在：${hostId}`);

  const mcp = mcpSettings();
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : mcp.maxReadChars;

  if (!terminalBuffer.has(hostId)) {
    const conn = ssh.getConn(hostId);
    return {
      hostId,
      text: '',
      lines: [],
      fromSeq: 0,
      toSeq: 0,
      nextSeq: 0,
      oldestSeq: 1,
      droppedLines: 0,
      closed: false,
      truncated: false,
      hint: conn?.shell
        ? '该会话的缓冲刚刚被重置，暂时还没有输出。稍等片刻再读。'
        : '该主机尚未开启交互式终端，请先调用 connect_host（openShell=true）或 exec_command。',
    };
  }

  const r = terminalBuffer.read(hostId, {
    sinceSeq: opts.sinceSeq,
    tailLines: opts.tailLines,
    maxChars,
    stripAnsi: opts.stripAnsi !== false,
  });

  return {
    ...r,
    hint: r.lines.length === 0 ? '自 sinceSeq 以来没有新的输出。' : undefined,
  };
}

export async function sendTerminalInput(
  hostId: string,
  input: string,
  opts: { appendEnter: boolean; waitMs: number },
  ctx: ToolContext
) {
  const host = db.getHost(hostId);
  if (!host) throw new ToolParamError(`主机不存在：${hostId}`);

  const conn = ssh.getConn(hostId);
  if (!conn || conn.status !== 'connected') {
    throw new ToolParamError('该主机当前未连接，请先调用 connect_host');
  }
  if (!conn.shell) {
    throw new ToolParamError('该主机尚未开启交互式终端，请先调用 connect_host（openShell=true）');
  }

  const text = unescapeInput(input);
  const withEnter = opts.appendEnter && !/[\r\n]$/.test(text) ? text + '\r' : text;

  // 用可读形式展示给审批人（\r 显示成可见标记）
  const display = withEnter.replace(/\r/g, '⏎').replace(/\n/g, '⏎\\n');
  const since = terminalBuffer.has(hostId)
    ? terminalBuffer.list().find((x) => x.hostId === hostId)?.lastSeq ?? 0
    : 0;

  const gate = await gateOperation(
    {
      hostId,
      hostName: host.name,
      tool: 'send_terminal_input',
      command: withEnter,
      action: '向终端发送输入',
    },
    ctx
  );

  if (!gate.allow) {
    return {
      ok: false,
      // 必须显式标记 isError：否则 tools/call 会把它当成成功结果，
      // 外部 Agent 会误以为输入已经发出去了。
      isError: true,
      approved: false,
      message: gate.message ?? '操作被拒绝',
      risk: gate.risk,
    };
  }

  const started = Date.now();
  ssh.writeShell(hostId, withEnter);

  if (opts.waitMs > 0) {
    await new Promise((r) => setTimeout(r, Math.min(opts.waitMs, 30000)));
  }

  const after = readTerminalOutput(hostId, { sinceSeq: since, stripAnsi: true });

  logMcpAudit({
    hostId,
    hostName: host.name,
    command: withEnter,
    action: '向终端发送输入',
    exitCode: null,
    risk: gate.risk.level,
    approved: true,
    approvedBy: gate.approvedBy,
    durationMs: Date.now() - started,
    output: after.text,
    client: ctx.client,
  });

  return {
    ok: true,
    approved: true,
    approvedBy: gate.approvedBy,
    risk: gate.risk.level,
    sent: withEnter,
    display,
    nextSeq: after.nextSeq,
    output: after.text,
    message:
      `已发送：${display}\n` +
      (after.text ? `\n截至当前的输出：\n${after.text}` : '\n（暂无新输出，可用 read_terminal_output 继续读取）'),
  };
}

/* ============ 命令执行 ============ */

export async function execCommand(
  hostId: string,
  command: string,
  opts: { cwd?: string; timeoutSec?: number; maxChars?: number },
  ctx: ToolContext
) {
  const host = db.getHost(hostId);
  if (!host) throw new ToolParamError(`主机不存在：${hostId}`);

  const mcp = mcpSettings();

  const gate = await gateOperation(
    { hostId, hostName: host.name, tool: 'exec_command', command, action: '执行命令' },
    ctx
  );
  if (!gate.allow) {
    return {
      ok: false,
      // 同上：被安全闸门拒绝的调用必须让外部 Agent 明确知道没执行
      isError: true,
      approved: false,
      message: gate.message ?? '操作被拒绝',
      risk: gate.risk,
      stdout: '',
      stderr: '',
      exitCode: null,
    };
  }

  const timeoutSec = opts.timeoutSec && opts.timeoutSec > 0 ? opts.timeoutSec : mcp.commandTimeoutSec;

  const started = Date.now();
  const result = await ssh.exec(hostId, command, {
    cwd: opts.cwd,
    timeoutSec,
    maxChars: opts.maxChars && opts.maxChars > 0 ? opts.maxChars : mcp.maxReadChars * 4,
  });
  const durationMs = Date.now() - started;

  logMcpAudit({
    hostId,
    hostName: host.name,
    command,
    action: '执行命令',
    exitCode: result.exitCode,
    risk: gate.risk.level,
    approved: true,
    approvedBy: gate.approvedBy,
    durationMs,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
    client: ctx.client,
  });

  const parts = [
    `退出码：${result.exitCode ?? 'null'}　耗时：${durationMs}ms` +
      (result.truncated ? '　（输出已截断）' : ''),
  ];
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`);
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
  if (!result.stdout && !result.stderr) parts.push('（无输出）');

  return {
    ok: result.ok,
    approved: true,
    approvedBy: gate.approvedBy,
    risk: gate.risk.level,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
    truncated: !!result.truncated,
    message: parts.join('\n'),
  };
}

/* ============ 高层：委派内置 Agent ============ */

interface TrackedStep {
  id: string;
  description: string;
  command: string;
  status: string;
  exitCode: number | null;
}

interface RunTracker {
  runId: string;
  hostId: string;
  hostName: string;
  task: string;
  startedAt: number;
  /** 最近收到的阶段 */
  phase: string;
  /** 计划步骤表（来自 plan 事件），以及执行结果 */
  steps: TrackedStep[];
  summary: string;
  error: string | null;
  /** 等待人工审批的步骤 id */
  waitingStepId: string | null;
  finished: boolean;
  abort: () => void;
}

const trackedRuns = new Map<string, RunTracker>();

/** 进度阶段的中文名，给外部 Agent 看 */
function phaseLabel(p: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    planning: '规划中',
    awaiting_approval: '等待审批',
    executing: '执行中',
    summarizing: '汇总中',
    done: '已完成',
    error: '出错',
    aborted: '已中止',
  };
  return map[p] ?? p;
}

/**
 * 订阅内置 Agent 的事件流，把 MCP 发起的任务进度收集到本地跟踪表。
 * 返回取消订阅函数 —— 服务停止时调用，避免累积订阅者。
 */
export function attachAgentEventSink(): () => void {
  return agent.setEventSink((ev: any) => {
    const t = trackedRuns.get(ev?.runId);
    if (!t) return;
    switch (ev.type) {
      case 'phase':
        t.phase = ev.phase;
        if (ev.phase === 'awaiting_approval') {
          // 具体是哪一步，等 plan 事件刷新后由 step 状态判断
          const pending = t.steps.find((s) => s.status === 'pending');
          t.waitingStepId = pending?.id ?? null;
        } else {
          t.waitingStepId = null;
        }
        if (ev.phase === 'done' || ev.phase === 'aborted' || ev.phase === 'error') {
          t.finished = true;
          if (ev.phase === 'error') t.error = t.error ?? '执行出错';
          t.waitingStepId = null;
        }
        break;
      case 'plan':
        if (Array.isArray(ev.steps)) {
          // plan 事件是全量快照（含重规划后的新步骤），直接用最新的覆盖
          t.steps = ev.steps.map((s: any) => {
            const prev = t.steps.find((x) => x.id === s.id);
            return {
              id: s.id,
              description: s.description ?? '',
              command: s.command ?? '',
              status: s.status ?? 'pending',
              exitCode: prev?.exitCode ?? null,
            };
          });
        }
        break;
      case 'step_start': {
        const s = t.steps.find((x) => x.id === ev.stepId);
        if (s) s.status = 'running';
        break;
      }
      case 'step_done': {
        const s = t.steps.find((x) => x.id === ev.stepId);
        if (s) {
          s.status = ev.status ?? 'done';
          s.exitCode = ev.exitCode ?? null;
        }
        break;
      }
      case 'summary':
        t.summary = ev.summary ?? '';
        break;
      case 'error':
        t.error = ev.error ?? '未知错误';
        break;
    }
  });
}

export async function runAgentTask(
  hostId: string,
  task: string,
  opts: {
    expertId?: string;
    skillIds?: string[];
    approvalMode?: 'auto_readonly' | 'manual' | 'auto_all';
    wait: boolean;
    waitTimeoutSec?: number;
  },
  ctx: ToolContext
) {
  const host = db.getHost(hostId);
  if (!host) throw new ToolParamError(`主机不存在：${hostId}`);

  const conn = ssh.getConn(hostId);
  if (!conn || conn.status !== 'connected') {
    const mcp = mcpSettings();
    if (mcp.autoConnect) {
      await connectHost(hostId, { openShell: false, cols: 120, rows: 32 });
    } else {
      throw new ToolParamError('该主机当前未连接，请先调用 connect_host');
    }
  }

  const res = await agent.startRun({
    hostId,
    task,
    approvalMode: opts.approvalMode as any,
    expertId: opts.expertId ?? null,
    skills: (opts.skillIds ?? []).map((id) => ({ skillId: id, values: {} })),
  });

  if (!res.ok || !res.runId) {
    return { ok: false, isError: true, message: res.error ?? '任务启动失败', runId: null };
  }

  const runId = res.runId;
  const tracker: RunTracker = {
    runId,
    hostId,
    hostName: host.name,
    task,
    startedAt: Date.now(),
    phase: 'planning',
    steps: [],
    summary: '',
    error: null,
    waitingStepId: null,
    finished: false,
    abort: () => agent.abortRun(runId),
  };
  trackedRuns.set(runId, tracker);

  logMcpAudit({
    hostId,
    hostName: host.name,
    command: task,
    action: '委派 Agent 任务',
    exitCode: null,
    risk: 'low',
    approved: true,
    approvedBy: 'mcp',
    durationMs: 0,
    output: '',
    client: ctx.client,
  });

  if (!opts.wait) {
    return {
      ok: true,
      runId,
      status: tracker.phase,
      message:
        `任务已启动，runId=${runId}。\n` +
        '这是异步执行：请用 get_agent_run_status 轮询进度，' +
        '任务完成后会在 summary 里给出结论。',
    };
  }

  const timeoutSec = opts.waitTimeoutSec && opts.waitTimeoutSec > 0 ? opts.waitTimeoutSec : 300;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (tracker.finished) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const status = getAgentRunStatus(runId);
  return {
    ok: true,
    runId,
    status: tracker.phase,
    timedOut: !tracker.finished,
    ...status.data,
    message: tracker.finished
      ? status.message
      : `等待超过 ${timeoutSec} 秒任务仍未结束，当前阶段：${tracker.phase}。可用 get_agent_run_status 继续查询。`,
  };
}

export function getAgentRunStatus(runId: string) {
  const t = trackedRuns.get(runId);
  if (!t) {
    return {
      ok: false,
      isError: true,
      runId,
      message: `未找到任务 ${runId}。注意：只有通过 MCP 的 run_agent_task 发起的任务才能在这里查到。`,
      data: null,
    };
  }
  const stepText = t.steps.length
    ? t.steps
        .map(
          (s, i) =>
            `${i + 1}. [${s.status}] ${s.description}\n   $ ${s.command}` +
            (s.exitCode !== null ? `\n   退出码 ${s.exitCode}` : '')
        )
        .join('\n')
    : '（尚无步骤信息）';

  const waitingDesc = t.waitingStepId
    ? t.steps.find((s) => s.id === t.waitingStepId)?.description ?? t.waitingStepId
    : null;

  const lines = [
    `任务：${t.task}`,
    `主机：${t.hostName}`,
    `当前阶段：${phaseLabel(t.phase)}${t.finished ? '（已结束）' : ''}`,
    waitingDesc ? `⚠ 正在等待人工审批：${waitingDesc}` : '',
    t.error ? `错误：${t.error}` : '',
    '',
    '步骤：',
    stepText,
  ].filter((x) => x !== '' || true) as string[];

  if (t.summary) lines.push('', '总结：', t.summary);

  return {
    ok: true,
    runId,
    data: {
      runId,
      phase: t.phase,
      phaseLabel: phaseLabel(t.phase),
      finished: t.finished,
      waitingStepId: t.waitingStepId,
      steps: t.steps,
      summary: t.summary,
      error: t.error,
      startedAt: t.startedAt,
    },
    message: lines.filter(Boolean).join('\n'),
  };
}

export function abortAgentTask(runId: string) {
  const t = trackedRuns.get(runId);
  if (!t) return { ok: false, isError: true, message: `未找到任务 ${runId}` };
  t.abort();
  t.finished = true;
  t.phase = 'aborted';
  return { ok: true, message: `已请求中止任务 ${runId}` };
}

/** 进程退出时清理挂起的审批，避免外部 Agent 永久等待 */
export function releaseAllPending(reason = 'MCP 服务已关闭'): void {
  for (const [id, rec] of pendingApprovals) {
    try {
      rec.resolve(false);
    } catch {
      /* ignore */
    }
    broadcastFn({ type: 'approval_done', id, approved: false, reason });
  }
  pendingApprovals.clear();
}

/** 仅供测试：重置内部状态 */
export function __resetForTest(): void {
  pendingApprovals.clear();
  trackedRuns.clear();
  runtimeStatus = {
    enabled: false,
    stdioReady: false,
    httpListening: false,
    httpPort: null,
    lastError: null,
    startedAt: null,
    sessions: 0,
    toolCount: 0,
    callCount: 0,
  };
}

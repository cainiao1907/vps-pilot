/**
 * MCP 工具定义与分发
 *
 * 这里只负责「有哪些工具、参数长什么样、怎么调」，
 * 具体实现放在 handlers.ts —— 保持定义与实现分离，
 * 让 tools/list 的返回体可以脱离 Electron 环境单独测试。
 */

import type { McpSettings } from '@shared/types';
import * as handlers from './handlers';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** 返回给调用方的文本内容 */
  handler: (args: any, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * 门控：返回 null 表示放行，返回字符串表示拒绝原因。
   * 用于「按设置开关某个工具」——被关掉的工具不出现在 tools/list 里。
   */
  gate?: (settings: McpSettings) => string | null;
}

export interface ToolContext {
  /** 发起本次调用的会话，用于标识来源客户端 */
  sessionId: string;
  /** 客户端自报名称（来自 initialize 的 clientInfo） */
  client?: string;
  /** 调用序号，用于串起日志 */
  requestId: string | number | null;
}

export interface ToolResult {
  /** 给模型看的文本 */
  text: string;
  /** 结构化数据，一并塞进 content 的第二个块里 */
  data?: any;
  isError?: boolean;
}

/* ============ 参数小工具 ============ */

function requireString(args: any, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ToolParamError(`缺少必填参数 ${key}（应为非空字符串）`);
  }
  return v;
}

function optionalString(args: any, key: string): string | undefined {
  const v = args?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolParamError(`参数 ${key} 应为字符串`);
  return v;
}

function optionalNumber(args: any, key: string): number | undefined {
  const v = args?.[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolParamError(`参数 ${key} 应为数字`);
  return n;
}

function optionalBool(args: any, key: string): boolean | undefined {
  const v = args?.[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ToolParamError(`参数 ${key} 应为布尔值`);
}

/** 参数错误 —— 会被映射成 JSON-RPC 的 -32602 */
export class ToolParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolParamError';
  }
}

export { requireString, optionalString, optionalNumber, optionalBool };

/* ============ 工具清单 ============ */

export const TOOLS: ToolDefinition[] = [
  /* ---------- 只读：环境与资产 ---------- */
  {
    name: 'get_status',
    title: '查看服务状态',
    description:
      '返回 VPS Pilot 的运行状态：MCP 服务开关、已连接主机数、当前审批策略与权限开关。' +
      '外部 Agent 在开始操作前建议先调用一次，确认自己有哪些权限。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const s = handlers.getStatus();
      return {
        text: [
          `MCP 服务：${s.status.enabled ? '已启用' : '已停用'}`,
          `HTTP 监听：${s.status.httpListening ? `127.0.0.1:${s.status.httpPort}` : '未监听'}`,
          `已暴露工具：${s.status.toolCount} 个`,
          `审批策略：${handlers.describePolicy(s.settings.approvalPolicy)}`,
          `允许写入终端：${s.settings.allowWrite ? '是' : '否'}`,
          `允许执行命令：${s.settings.allowExec ? '是' : '否'}`,
          `允许高危命令：${s.settings.allowDangerous ? '是（危险）' : '否'}`,
        ].join('\n'),
        data: s,
      };
    },
  },
  {
    name: 'list_hosts',
    title: '列出所有主机',
    description:
      '列出 VPS Pilot 里已保存的所有主机配置，含 id、名称、地址、分组和当前连接状态。' +
      '后续所有针对具体主机的工具调用都需要用到这里的 hostId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const hosts = handlers.listHosts();
      const text = hosts.length
        ? hosts
            .map(
              (h) =>
                `- ${h.name} (id=${h.id}) ${h.username}@${h.host}:${h.port}` +
                ` 状态=${h.status}` +
                (h.tags && h.tags.length ? ` 标签=${h.tags.join('/')}` : '')
            )
            .join('\n')
        : '当前没有任何已保存的主机。';
      return { text: `共 ${hosts.length} 台主机：\n${text}`, data: hosts };
    },
  },
  {
    name: 'list_sessions',
    title: '列出活跃终端会话',
    description:
      '列出当前已建立 SSH 连接、且已开启交互式 shell 的会话。' +
      'read_terminal_output / send_terminal_input 只能作用于这里的 hostId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const sessions = handlers.listSessions();
      const text = sessions.length
        ? sessions
            .map(
              (s) =>
                `- ${s.hostName} (id=${s.hostId}) 缓冲 ${s.bufferedLines} 行` +
                ` 最新序号=${s.lastSeq}${s.closed ? ' [已关闭]' : ''}`
            )
            .join('\n')
        : '当前没有活跃的终端会话。可以用 connect_host 建立连接。';
      return { text: `共 ${sessions.length} 个会话：\n${text}`, data: sessions };
    },
  },
  {
    name: 'list_experts',
    title: '列出可用专家',
    description:
      '列出 VPS Pilot 里配置的运维专家（人格 + 方法论）。' +
      'run_agent_task 可以指定其中一位来驱动内置 Agent 引擎。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const experts = handlers.listExperts();
      const text = experts.map((e) => `- ${e.name} (id=${e.id}) — ${e.description}`).join('\n');
      return { text: `共 ${experts.length} 位专家：\n${text}`, data: experts };
    },
  },
  {
    name: 'list_skills',
    title: '列出可用技能',
    description: '列出 VPS Pilot 里配置的技能（结构化操作手册），run_agent_task 可以按 id 启用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const skills = handlers.listSkills();
      const text = skills.map((s) => `- ${s.name} (id=${s.id}) — ${s.description}`).join('\n');
      return { text: `共 ${skills.length} 个技能：\n${text}`, data: skills };
    },
  },

  /* ---------- 连接管理 ---------- */
  {
    name: 'connect_host',
    title: '连接主机',
    description:
      '与指定主机建立 SSH 连接，并可选地立即开启一个交互式 shell（带输出缓冲）。' +
      'connect_host 是幂等的：已连接时直接返回现有连接。',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 id，来自 list_hosts' },
        openShell: {
          type: 'boolean',
          description: '是否顺便开启交互式 shell（默认 true，否则只能用 exec_command）',
        },
        cols: { type: 'number', description: '终端列数，默认 120' },
        rows: { type: 'number', description: '终端行数，默认 32' },
      },
      required: ['hostId'],
      additionalProperties: false,
    },
    async handler(args) {
      const hostId = requireString(args, 'hostId');
      const openShell = optionalBool(args, 'openShell') ?? true;
      const cols = optionalNumber(args, 'cols') ?? 120;
      const rows = optionalNumber(args, 'rows') ?? 32;
      const r = await handlers.connectHost(hostId, { openShell, cols, rows });
      return { text: r.message, data: r };
    },
  },
  {
    name: 'disconnect_host',
    title: '断开主机连接',
    description: '断开指定主机的 SSH 连接，并释放对应的终端缓冲。',
    inputSchema: {
      type: 'object',
      properties: { hostId: { type: 'string', description: '主机 id' } },
      required: ['hostId'],
      additionalProperties: false,
    },
    async handler(args) {
      const hostId = requireString(args, 'hostId');
      const r = handlers.disconnectHost(hostId);
      return { text: r.message, data: r };
    },
  },

  /* ---------- 终端读写（本需求核心） ---------- */
  {
    name: 'read_terminal_output',
    title: '读取终端输出',
    description:
      '读取交互式终端的输出内容。支持增量读取：把上次返回的 nextSeq 作为 sinceSeq 传回，' +
      '就只会拿到之后的新输出。这是「看终端里发生了什么」的唯一入口。',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 id' },
        sinceSeq: {
          type: 'number',
          description: '只返回序号大于该值的行。增量读取时填上一次返回的 nextSeq',
        },
        tailLines: { type: 'number', description: '最多返回末尾多少行' },
        maxChars: { type: 'number', description: '最多返回多少字符（默认取设置里的上限）' },
        stripAnsi: { type: 'boolean', description: '是否剥离 ANSI 颜色码，默认 true' },
      },
      required: ['hostId'],
      additionalProperties: false,
    },
    async handler(args) {
      const hostId = requireString(args, 'hostId');
      const r = handlers.readTerminalOutput(hostId, {
        sinceSeq: optionalNumber(args, 'sinceSeq'),
        tailLines: optionalNumber(args, 'tailLines'),
        maxChars: optionalNumber(args, 'maxChars'),
        stripAnsi: optionalBool(args, 'stripAnsi'),
      });
      const header = [
        `hostId=${r.hostId} 行数=${r.lines.length} 序号区间=[${r.fromSeq}, ${r.toSeq}]`,
        `下次增量读取请传 sinceSeq=${r.nextSeq}`,
        r.droppedLines > 0 ? `注意：缓冲已丢弃最早 ${r.droppedLines} 行` : '',
        r.truncated ? '注意：本次输出因长度上限被截断（保留了末尾部分）' : '',
        r.closed ? '通道已关闭' : '',
      ]
        .filter(Boolean)
        .join('\n');
      return { text: `${header}\n\n${r.text}`, data: r };
    },
  },
  {
    name: 'send_terminal_input',
    title: '向终端发送输入',
    description:
      '把一段文本当作键盘输入写进交互式终端。文本里的 \\r 会被解释为回车、\\n 为换行。' +
      '典型用法：先 send_terminal_input 执行命令，再 read_terminal_output 读取回显。',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 id' },
        input: {
          type: 'string',
          description: '要发送的内容。以 \\r 或 \\n 结尾相当于按下回车。支持 \\t \\x03 等转义',
        },
        appendEnter: {
          type: 'boolean',
          description: '是否自动在末尾补一个回车（默认 true，除非输入已含 \\r 或 \\n）',
        },
        waitMs: {
          type: 'number',
          description: '发送后等待多少毫秒，便于紧接着读取输出（默认 0）',
        },
      },
      required: ['hostId', 'input'],
      additionalProperties: false,
    },
    gate: (s) => (s.allowWrite ? null : '终端写入已被设置关闭（MCP 服务 → 允许写入终端）'),
    async handler(args, ctx) {
      const hostId = requireString(args, 'hostId');
      const input = requireString(args, 'input');
      const appendEnter = optionalBool(args, 'appendEnter') ?? true;
      const waitMs = optionalNumber(args, 'waitMs') ?? 0;
      const r = await handlers.sendTerminalInput(hostId, input, { appendEnter, waitMs }, ctx);
      return { text: r.message, data: r };
    },
  },

  /* ---------- 命令执行 ---------- */
  {
    name: 'exec_command',
    title: '执行命令并取回结果',
    description:
      '在目标主机上执行一条非交互式命令，返回完整的 stdout / stderr / 退出码。' +
      '比「写终端再读回显」更可靠，适合脚本化操作。所有命令都会经过风险评估。',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 id' },
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录，默认用户家目录' },
        timeoutSec: { type: 'number', description: '超时秒数，默认取设置里的值' },
        maxChars: { type: 'number', description: '输出字符上限' },
      },
      required: ['hostId', 'command'],
      additionalProperties: false,
    },
    gate: (s) => (s.allowExec ? null : '命令执行已被设置关闭（MCP 服务 → 允许执行命令）'),
    async handler(args, ctx) {
      const hostId = requireString(args, 'hostId');
      const command = requireString(args, 'command');
      const r = await handlers.execCommand(
        hostId,
        command,
        {
          cwd: optionalString(args, 'cwd'),
          timeoutSec: optionalNumber(args, 'timeoutSec'),
          maxChars: optionalNumber(args, 'maxChars'),
        },
        ctx
      );
      return { text: r.message, data: r };
    },
  },

  /* ---------- 高层任务 ---------- */
  {
    name: 'run_agent_task',
    title: '委派任务给内置 Agent',
    description:
      '把一句话目标交给 VPS Pilot 内置的 Plan-Execute 引擎：它会自动规划步骤、逐步执行、' +
      '遇到风险步骤时按当前审批策略处理，最后给出总结。适合「帮我排查磁盘占用」这类复合任务。' +
      '注意：默认是异步的，调用后请用 get_agent_run_status 查询进度。',
    inputSchema: {
      type: 'object',
      properties: {
        hostId: { type: 'string', description: '主机 id' },
        task: { type: 'string', description: '用自然语言描述的目标' },
        expertId: { type: 'string', description: '指定专家 id，留空用默认专家' },
        skillIds: { type: 'array', items: { type: 'string' }, description: '启用哪些技能' },
        approvalMode: {
          type: 'string',
          enum: ['auto_readonly', 'manual', 'auto_all'],
          description: '审批模式，留空沿用界面上的当前设置',
        },
        wait: {
          type: 'boolean',
          description: '是否阻塞等待任务完成（默认 false）。长任务建议 false + 轮询状态',
        },
        waitTimeoutSec: { type: 'number', description: 'wait=true 时最多等待多少秒，默认 300' },
      },
      required: ['hostId', 'task'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const hostId = requireString(args, 'hostId');
      const task = requireString(args, 'task');
      const r = await handlers.runAgentTask(
        hostId,
        task,
        {
          expertId: optionalString(args, 'expertId'),
          skillIds: Array.isArray(args?.skillIds) ? args.skillIds : undefined,
          approvalMode: optionalString(args, 'approvalMode') as any,
          wait: optionalBool(args, 'wait') ?? false,
          waitTimeoutSec: optionalNumber(args, 'waitTimeoutSec'),
        },
        ctx
      );
      return { text: r.message, data: r };
    },
  },
  {
    name: 'get_agent_run_status',
    title: '查询 Agent 任务状态',
    description:
      '查询由 run_agent_task 发起的任务进度：当前阶段、已完成的步骤、输出摘要、是否卡在审批上。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'run_agent_task 返回的任务 id' } },
      required: ['runId'],
      additionalProperties: false,
    },
    async handler(args) {
      const runId = requireString(args, 'runId');
      const r = handlers.getAgentRunStatus(runId);
      return { text: r.message, data: r };
    },
  },
  {
    name: 'abort_agent_task',
    title: '中止 Agent 任务',
    description: '中止一个正在进行的 Agent 任务。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: '任务 id' } },
      required: ['runId'],
      additionalProperties: false,
    },
    async handler(args) {
      const runId = requireString(args, 'runId');
      const r = handlers.abortAgentTask(runId);
      return { text: r.message, data: r };
    },
  },

  /* ---------- 审批相关 ---------- */
  {
    name: 'list_pending_approvals',
    title: '列出待审批请求',
    description:
      '列出所有卡在人工审批上的操作。当工具返回「等待人工审批」时，可以用这个查询它是否还在等。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const list = handlers.listPendingApprovals();
      const text = list.length
        ? list
            .map(
              (p) =>
                `- id=${p.id} 主机=${p.hostName} 工具=${p.tool} 风险=${p.risk}\n  内容：${p.command}`
            )
            .join('\n')
        : '当前没有待审批的请求。';
      return { text: `共 ${list.length} 条待审批：\n${text}`, data: list };
    },
  },
  {
    name: 'decide_approval',
    title: '裁决待审批请求',
    description:
      '对某条待审批请求做出批准或拒绝。仅当审批策略为 always 时才需要外部 Agent 主动裁决；' +
      '策略为 risky / never 时，低风险操作会自行放行，无需调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待审批请求 id' },
        approve: { type: 'boolean', description: 'true 批准执行，false 拒绝' },
      },
      required: ['id', 'approve'],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const id = requireString(args, 'id');
      const approve = optionalBool(args, 'approve');
      if (approve === undefined) throw new ToolParamError('缺少必填参数 approve');
      const r = handlers.decideApproval(id, approve, ctx);
      return { text: r.message, data: r };
    },
  },
];

/** 按名字查工具 */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * 生成 tools/list 的响应体。
 * 被门控关掉的工具不会出现在清单里 —— 这样外部 Agent 不会「看得见调不动」。
 */
export function listToolsFor(settings: McpSettings): Array<Omit<ToolDefinition, 'handler' | 'gate'>> {
  return TOOLS.filter((t) => !t.gate || t.gate(settings) === null).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

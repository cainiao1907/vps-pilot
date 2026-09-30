/**
 * MCP Server 核心：会话状态机 + 方法分发
 *
 * 传输层（stdio / http）只负责「把一行 JSON 送进来，把响应送出去」，
 * 协议语义全部在这里。这样一个 Server 实例可以同时被两种传输复用。
 *
 * MCP 生命周期：
 *   initialize                        → 返回协议版本与能力声明
 *   notifications/initialized         → 客户端确认，之后才允许调用工具
 *   tools/list                        → 返回工具清单
 *   tools/call                        → 调用某个工具
 *   ping                              → 心跳
 *   其它                              → -32601 方法不存在
 *
 * 注意：规范要求「未收到 initialized 通知前，除 initialize/ping 外的请求
 * 都应被拒绝」。这里按 SERVER_NOT_INITIALIZED 处理，保证客户端不会在握手
 * 完成前就乱调工具。
 */

import type { McpSettings } from '@shared/types';
import {
  JSONRPC_VERSION,
  RPC_ERRORS,
  err,
  isNotification,
  ok,
  parseMessage,
  type JsonRpcResponse,
} from './jsonrpc';
import { TOOLS, ToolParamError, findTool, listToolsFor, type ToolContext } from './tools';
import * as handlers from './handlers';

/** 我们声明支持的协议版本。客户端请求版本不在列表里时，回落到第一个。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_NAME = 'vps-pilot';
export const SERVER_VERSION = '0.1.0';

interface Session {
  id: string;
  initialized: boolean;
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  createdAt: number;
  lastAt: number;
}

let sessionSeq = 0;

export interface DispatchResult {
  /** 需要回给客户端的消息；null 表示这是通知、无需响应 */
  response: JsonRpcResponse | JsonRpcResponse[] | null;
  /** 是否应当结束服务（收到 shutdown） */
  shouldShutdown?: boolean;
}

export class McpServer {
  private sessions = new Map<string, Session>();
  private settingsProvider: () => McpSettings;
  private onCall?: (info: { tool: string; ok: boolean; hostId?: string; durationMs: number }) => void;

  constructor(
    settingsProvider: () => McpSettings,
    opts: { onCall?: (info: { tool: string; ok: boolean; hostId?: string; durationMs: number }) => void } = {}
  ) {
    this.settingsProvider = settingsProvider;
    this.onCall = opts.onCall;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 新建会话。HTTP 传输每次 POST 都可能带 sessionId，stdio 则只有一条。 */
  createSession(): string {
    sessionSeq += 1;
    const id = `sess_${Date.now().toString(36)}_${sessionSeq}`;
    this.sessions.set(id, {
      id,
      initialized: false,
      clientName: '',
      clientVersion: '',
      protocolVersion: PREFERRED_PROTOCOL_VERSION,
      createdAt: Date.now(),
      lastAt: Date.now(),
    });
    return id;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  dropSession(id: string): void {
    this.sessions.delete(id);
  }

  clearSessions(): void {
    this.sessions.clear();
  }

  /**
   * 处理一行原始文本，返回要回写的内容。
   *
   * `sessionId` 为空时会自动建一个会话（stdio 首包即建）。
   */
  async handleLine(raw: string, sessionId?: string): Promise<DispatchResult> {
    const trimmed = raw.trim();
    if (!trimmed) return { response: null };

    const parsed = parseMessage(trimmed);
    if (parsed.kind === 'error') {
      return { response: parsed.response };
    }

    const sid = sessionId ?? this.getOrCreateDefaultSessionId();

    if (parsed.kind === 'batch') {
      const out: JsonRpcResponse[] = [];
      for (const msg of parsed.msgs) {
        const r = await this.handleMessage(msg, sid);
        if (r.response) {
          if (Array.isArray(r.response)) out.push(...r.response);
          else out.push(r.response);
        }
      }
      return { response: out.length > 0 ? out : null };
    }

    return this.handleMessage(parsed.msg, sid);
  }

  private defaultSessionId: string | null = null;

  private getOrCreateDefaultSessionId(): string {
    // stdio 场景下客户端只连一条流，复用同一个会话
    if (this.defaultSessionId && this.sessions.has(this.defaultSessionId)) {
      return this.defaultSessionId;
    }
    const id = this.createSession();
    this.defaultSessionId = id;
    return id;
  }

  private async handleMessage(msg: any, sessionId: string): Promise<DispatchResult> {
    const session = this.sessions.get(sessionId);
    if (session) session.lastAt = Date.now();

    const id = msg.id ?? null;
    const isNote = isNotification(msg);
    const method: string = msg.method;
    const params = msg.params ?? {};

    // 握手阶段：任何请求都必须先 initialize
    const isHandshake = method === 'initialize' || method === 'ping';
    if (session && !session.initialized && !isHandshake && method !== 'notifications/initialized') {
      if (isNote) return { response: null };
      return {
        response: err(
          id,
          RPC_ERRORS.SERVER_NOT_INITIALIZED,
          '会话尚未初始化，请先发送 initialize 请求'
        ),
      };
    }

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const proto =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PREFERRED_PROTOCOL_VERSION;
        if (session) {
          session.protocolVersion = proto;
          session.clientName = params?.clientInfo?.name ?? '';
          session.clientVersion = params?.clientInfo?.version ?? '';
        }
        const result = {
          protocolVersion: proto,
          capabilities: {
            // 只提供工具能力；不提供 resources / prompts / sampling
            tools: { listChanged: false },
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          // 非标准但常见：把服务端身份与使用提示一并给出，方便客户端展示
          instructions:
            'VPS Pilot 远程运维工具集。先用 list_hosts 找到目标主机，' +
            'connect_host 建立连接，然后用 read_terminal_output / send_terminal_input ' +
            '操作交互式终端，或用 exec_command 执行命令。' +
            '高危操作需要人工在 VPS Pilot 界面审批。',
        };
        return { response: isNote ? null : ok(id, result) };
      }

      case 'notifications/initialized': {
        if (session) session.initialized = true;
        return { response: null };
      }

      case 'ping':
        return { response: isNote ? null : ok(id, {}) };

      case 'tools/list': {
        const settings = this.settingsProvider();
        const tools = listToolsFor(settings);
        return {
          response: isNote ? null : ok(id, { tools }),
        };
      }

      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string' || !name) {
          return { response: err(id, RPC_ERRORS.INVALID_PARAMS, '缺少参数 name') };
        }
        const settings = this.settingsProvider();
        const tool = findTool(name);
        if (!tool) {
          return {
            response: err(id, RPC_ERRORS.INVALID_PARAMS, `未知工具：${name}`),
          };
        }
        // 门控：被设置关掉的工具，即使客户端知道名字也不能调
        if (tool.gate) {
          const reason = tool.gate(settings);
          if (reason) {
            return {
              response: ok(id, {
                content: [{ type: 'text', text: `工具 ${name} 当前不可用：${reason}` }],
                isError: true,
              }),
            };
          }
        }

        const args = params?.arguments ?? {};
        const ctx: ToolContext = {
          sessionId,
          client: session?.clientName || undefined,
          requestId: id,
        };

        const started = Date.now();
        try {
          const result = await tool.handler(args, ctx);
          const durationMs = Date.now() - started;
          // 失败判定要同时看工具层的 isError 和 data 里的 isError。
          // 起因：安全闸门拒绝时，handler 返回的 {ok:false, isError:true, ...}
          // 会被工具定义包成 {text, data}，工具层对象上并没有 isError 字段。
          // 若只看 result.isError，协议层就会把「被拒绝」报成 isError:false，
          // 外部 Agent 会误以为命令真的执行了 —— 危险静默失败。
          const failed = result.isError === true || result.data?.isError === true;
          handlers.bumpCallCount();
          this.onCall?.({
            tool: name,
            ok: !failed,
            hostId: typeof args?.hostId === 'string' ? args.hostId : undefined,
            durationMs,
          });
          const content: any[] = [{ type: 'text', text: result.text ?? '' }];
          if (result.data !== undefined) {
            content.push({
              type: 'text',
              text: JSON.stringify({ __structured: result.data }, null, 2),
            });
          }
          return {
            response: ok(id, { content, isError: failed }),
          };
        } catch (e: any) {
          const durationMs = Date.now() - started;
          handlers.bumpCallCount();
          this.onCall?.({
            tool: name,
            ok: false,
            hostId: typeof args?.hostId === 'string' ? args.hostId : undefined,
            durationMs,
          });
          // 参数错误按协议走 -32602；业务错误按工具错误返回（模型能看懂）
          if (e instanceof ToolParamError) {
            return {
              response: ok(id, {
                content: [{ type: 'text', text: `参数错误：${e.message}` }],
                isError: true,
              }),
            };
          }
          return {
            response: ok(id, {
              content: [{ type: 'text', text: `工具执行失败：${e?.message ?? String(e)}` }],
              isError: true,
            }),
          };
        }
      }

      case 'resources/list':
        // 我们没声明 resources 能力，明确告知而不是静默失败
        return { response: err(id, RPC_ERRORS.METHOD_NOT_FOUND, '本服务未提供 resources 能力') };

      case 'prompts/list':
        return { response: err(id, RPC_ERRORS.METHOD_NOT_FOUND, '本服务未提供 prompts 能力') };

      case 'shutdown':
        return { response: isNote ? null : ok(id, {}), shouldShutdown: true };

      default:
        if (isNote) return { response: null };
        return {
          response: err(id, RPC_ERRORS.METHOD_NOT_FOUND, `不支持的方法：${method}`),
        };
    }
  }

  /** 工具总数（用于状态展示） */
  get toolCount(): number {
    return TOOLS.length;
  }

  /** 可用工具数（按当前设置） */
  availableToolCount(): number {
    return listToolsFor(this.settingsProvider()).length;
  }
}

export { JSONRPC_VERSION };

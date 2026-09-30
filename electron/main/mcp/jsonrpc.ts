/**
 * JSON-RPC 2.0 编解码
 *
 * MCP 的协议底座就是 JSON-RPC 2.0。这里只做最必要的部分：
 * 消息校验、响应构造、通知构造，以及标准错误码。
 *
 * 刻意不引入任何第三方库 —— 这个文件要能在纯 Node 环境（测试）里跑，
 * 也要能被打进 Electron 主进程包，依赖越少越稳。
 */

export const JSONRPC_VERSION = '2.0';

/** 标准错误码 */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** MCP 约定：服务端未完成初始化 */
  SERVER_NOT_INITIALIZED: -32002,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: any;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: any };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** 判断是否是一个合法的请求对象 */
export function isRequest(msg: any): msg is JsonRpcRequest {
  return (
    !!msg &&
    typeof msg === 'object' &&
    typeof msg.method === 'string' &&
    msg.jsonrpc === JSONRPC_VERSION
  );
}

/** 是否通知（无 id）—— 通知不需要响应，出错也只记日志 */
export function isNotification(msg: any): boolean {
  return isRequest(msg) && (msg.id === undefined || msg.id === null);
}

export function ok(id: string | number | null, result: any): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: any
): JsonRpcFailure {
  const error: JsonRpcFailure['error'] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/**
 * 把一行文本解析成消息。
 *
 * 支持批量数组（JSON-RPC 2.0 允许数组一次性发多条）。
 * 解析失败返回一个带错误码的响应对象，交由调用方决定是否回写 ——
 * 注意：解析失败时拿不到 id，按规范 id 填 null。
 */
export function parseMessage(
  raw: string
): { kind: 'request'; msg: JsonRpcRequest } | { kind: 'batch'; msgs: any[] } | { kind: 'error'; response: JsonRpcFailure } {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'error', response: err(null, RPC_ERRORS.PARSE_ERROR, 'JSON 解析失败') };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return { kind: 'error', response: err(null, RPC_ERRORS.INVALID_REQUEST, '批量请求不能为空') };
    }
    return { kind: 'batch', msgs: parsed };
  }

  if (!isRequest(parsed)) {
    const id = parsed && typeof parsed === 'object' && 'id' in parsed ? parsed.id ?? null : null;
    return {
      kind: 'error',
      response: err(id, RPC_ERRORS.INVALID_REQUEST, '不是合法的 JSON-RPC 2.0 请求'),
    };
  }

  return { kind: 'request', msg: parsed };
}

/** 序列化为一行（不含换行符） */
export function stringify(msg: any): string {
  return JSON.stringify(msg);
}

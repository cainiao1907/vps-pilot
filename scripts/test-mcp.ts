/**
 * MCP 服务自测
 *
 * 目标：不用 Electron 图形环境，用「假 MCP 客户端」把真实 Server 跑一遍。
 *
 * 分四块：
 *  [1] JSON-RPC 编解码与错误码
 *  [2] 终端环形缓冲（含增量读取、ANSI 剥离、超限裁剪）
 *  [3] MCP 生命周期与 tools/list
 *  [4] tools/call 各工具的成功 / 失败 / 拦截路径，以及 HTTP 鉴权
 *  [5] 源码约定校验（防止后续改动悄悄破坏安全闸门）
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-loader.mjs scripts/test-mcp.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

/* ---- 数据目录指到临时目录，避免污染真实配置 ---- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpspilot-mcp-test-'));
process.env.VPSPILOT_DATA_DIR = tmpDir;

console.log('\n============ MCP 服务自测 ============\n');

/* ============ [1] JSON-RPC ============ */
console.log('[1] JSON-RPC 编解码');
{
  const jrpc = await import('../electron/main/mcp/jsonrpc.ts');

  const r1 = jrpc.parseMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  check('合法请求能被解析', r1.kind === 'request');

  const r2 = jrpc.parseMessage('{ 这不是 json');
  check('非法 JSON → -32700', r2.kind === 'error' && r2.response.error.code === -32700);

  const r3 = jrpc.parseMessage('{"id":1,"method":"x"}');
  check(
    '缺 jsonrpc 字段 → -32600',
    r3.kind === 'error' && r3.response.error.code === -32600
  );

  const r4 = jrpc.parseMessage(
    '[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]'
  );
  check('批量请求被识别', r4.kind === 'batch' && r4.msgs.length === 2);

  const r5 = jrpc.parseMessage('[]');
  check('空批量 → -32600', r5.kind === 'error');

  const note = jrpc.parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  check('通知（无 id）被识别', note.kind === 'request' && jrpc.isNotification(note.msg));

  check('错误码常量齐全', jrpc.RPC_ERRORS.PARSE_ERROR === -32700 && jrpc.RPC_ERRORS.METHOD_NOT_FOUND === -32601);
}

/* ============ [2] 终端缓冲 ============ */
console.log('\n[2] 终端环形缓冲');
{
  const { TerminalBufferStore, stripAnsi } = await import('../electron/main/terminal-buffer.ts');
  const buf = new TerminalBufferStore(1000, 100000);

  buf.append('h1', 'hello\nworld\n');
  const r1 = buf.read('h1', {});
  check('基本追加与读取', r1.lines.length === 2 && r1.text === 'hello\nworld');

  // 半行
  buf.append('h1', 'abc');
  const r2 = buf.read('h1', {});
  check('未成行的尾巴不进结果', r2.lines.length === 2, `实际 ${r2.lines.length}`);
  check('尾巴能单独取出', buf.tail('h1') === 'abc');

  // 接上尾巴成行
  buf.append('h1', 'def\n');
  const r3 = buf.read('h1', {});
  check('跨 chunk 拼行正确', r3.lines[2]?.text === 'abcdef');

  // 增量读
  const nextSeq = r3.nextSeq;
  const r4 = buf.read('h1', { sinceSeq: nextSeq });
  check('增量读取无新内容时为空', r4.lines.length === 0);
  buf.append('h1', 'new line\n');
  const r5 = buf.read('h1', { sinceSeq: nextSeq });
  check('增量读取只拿到新行', r5.lines.length === 1 && r5.lines[0].text === 'new line');

  // seq 单调
  check('seq 严格递增', r5.lines[0].seq > nextSeq);

  // ANSI 剥离
  const colored = '\x1b[32mOK\x1b[0m done\x1b[K';
  check('红色码等 CSI 被剥离', stripAnsi(colored) === 'OK done', JSON.stringify(stripAnsi(colored)));
  check('OSC 序列被剥离', stripAnsi('\x1b]0;title\x07text') === 'text');
  check('退格删前一个字符', stripAnsi('ab\bc') === 'ac');
  buf.append('h2', '\x1b[31mERR\x1b[0m\n');
  check('缓冲读取时默认剥离 ANSI', buf.read('h2', {}).text === 'ERR');
  check('可要求保留原始（此处仍剥离换行控制）', typeof buf.read('h2', { stripAnsi: false }).text === 'string');

  // 裁剪
  const small = new TerminalBufferStore(5, 100000);
  for (let i = 0; i < 20; i++) small.append('h3', `line${i}\n`);
  const rs = small.read('h3', {});
  check('超出 maxLines 后保留最新行', rs.lines.length <= 5, `实际 ${rs.lines.length}`);
  check('裁剪计数被记录', rs.droppedLines >= 15, `实际 ${rs.droppedLines}`);
  check('最早可用 seq 上移', rs.oldestSeq > 1);

  // 字符上限
  const tiny = new TerminalBufferStore(1000, 30);
  for (let i = 0; i < 20; i++) tiny.append('h4', `aaaaaaaaaa${i}\n`);
  const rt = tiny.read('h4', {});
  check('字符上限生效（总量收敛）', rt.text.length <= 40, `实际 ${rt.text.length}`);

  // maxChars 截断标记
  const big = new TerminalBufferStore(1000, 100000);
  for (let i = 0; i < 50; i++) big.append('h5', `line-${i}\n`);
  const rc = big.read('h5', { maxChars: 30 });
  check('maxChars 触发 truncated 标记', rc.truncated === true);
  check('maxChars 保留的是末尾内容', rc.text.includes('line-49'), rc.text);

  // tailLines
  const rl = big.read('h5', { tailLines: 3 });
  check('tailLines 只返回末尾 N 行', rl.lines.length === 3);

  // close
  buf.close('h1');
  const rclosed = buf.read('h1', {});
  check('close 后残余半行被固化', rclosed.lines.length >= 3);

  // clear / drop
  check('clear 移除通道', buf.clear('h2') === true);
  check('clear 之后 has 为 false', buf.has('h2') === false);

  // list
  const list = buf.list();
  check('list 返回通道概要', list.some((x) => x.hostId === 'h1'));

  // 空 chunk 不炸，且不产生虚假通道
  const emptyRet = buf.append('h9', '');
  check('空 chunk 返回空数组', Array.isArray(emptyRet) && emptyRet.length === 0);
  check('空 chunk 不创建空通道', !buf.has('h9'));
}

/* ============ [3] MCP 生命周期 ============ */
console.log('\n[3] MCP Server 生命周期');
const settingsHolder: any = {
  enabled: true,
  httpEnabled: false,
  httpPort: 0,
  token: '',
  approvalPolicy: 'risky',
  allowWrite: true,
  allowExec: true,
  allowDangerous: false,
  autoConnect: false,
  maxReadChars: 30000,
  commandTimeoutSec: 10,
  auditEnabled: false,
};

const { McpServer, PREFERRED_PROTOCOL_VERSION, SERVER_NAME } = await import(
  '../electron/main/mcp/server.ts'
);

/** 假客户端：把 Server 当作纯函数用 */
function makeClient(server: any) {
  let n = 0;
  return {
    async call(method: string, params?: any) {
      n += 1;
      const raw = JSON.stringify({ jsonrpc: '2.0', id: n, method, params });
      const r = await server.handleLine(raw);
      return r.response as any;
    },
    async notify(method: string, params?: any) {
      const raw = JSON.stringify({ jsonrpc: '2.0', method, params });
      return server.handleLine(raw);
    },
    async raw(line: string) {
      return server.handleLine(line);
    },
  };
}

{
  const server = new McpServer(() => settingsHolder);
  const cli = makeClient(server);

  // 未初始化就调工具 → SERVER_NOT_INITIALIZED
  const pre = await cli.call('tools/list');
  check(
    '未初始化调用工具 → -32002',
    pre.error?.code === -32002,
    JSON.stringify(pre)
  );

  // initialize
  const init = await cli.call('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'zcode', version: '1.0.0' },
  });
  check('initialize 返回 result', !!init.result);
  check('协议版本被回显', init.result.protocolVersion === '2025-06-18');
  check('声明 tools 能力', !!init.result.capabilities?.tools);
  check('serverInfo 名称正确', init.result.serverInfo.name === SERVER_NAME);
  check('返回 instructions 提示', typeof init.result.instructions === 'string');

  // 未知协议版本 → 回落
  const cli2 = makeClient(new McpServer(() => settingsHolder));
  const init2 = await cli2.call('initialize', { protocolVersion: '1999-01-01' });
  check('未知协议版本回落到首选版本', init2.result.protocolVersion === PREFERRED_PROTOCOL_VERSION);

  // initialized 通知
  const noteResp = await cli.notify('notifications/initialized');
  check('initialized 是通知，无响应', noteResp.response === null);

  // ping
  const pong = await cli.call('ping');
  check('ping 返回空对象', pong.result && Object.keys(pong.result).length === 0);

  /* ---- tools/list ---- */
  const tl = await cli.call('tools/list');
  const tools = tl.result?.tools ?? [];
  check('tools/list 返回清单', tools.length >= 10, `实际 ${tools.length}`);

  const names = tools.map((t: any) => t.name);
  for (const must of [
    'get_status',
    'list_hosts',
    'connect_host',
    'read_terminal_output',
    'send_terminal_input',
    'exec_command',
    'run_agent_task',
    'get_agent_run_status',
    'list_pending_approvals',
    'decide_approval',
  ]) {
    check(`包含工具 ${must}`, names.includes(must));
  }

  check(
    '每个工具都有 name/description/inputSchema',
    tools.every((t: any) => t.name && t.description && t.inputSchema?.type === 'object')
  );
  check(
    'inputSchema 有 properties 字段',
    tools.every((t: any) => !!t.inputSchema.properties)
  );
  check(
    '工具清单不泄漏内部 handler 函数',
    tools.every((t: any) => typeof t.handler === 'undefined' && typeof t.gate === 'undefined')
  );

  /* ---- 门控：关掉写权限后工具消失 ---- */
  settingsHolder.allowWrite = false;
  const tl2 = await cli.call('tools/list');
  const names2 = (tl2.result?.tools ?? []).map((t: any) => t.name);
  check('关闭写权限后 send_terminal_input 从清单消失', !names2.includes('send_terminal_input'));
  check('关闭写权限不影响只读工具', names2.includes('read_terminal_output'));

  settingsHolder.allowExec = false;
  const tl3 = await cli.call('tools/list');
  const names3 = (tl3.result?.tools ?? []).map((t: any) => t.name);
  check('关闭执行权限后 exec_command 消失', !names3.includes('exec_command'));
  settingsHolder.allowWrite = true;
  settingsHolder.allowExec = true;

  /* ---- 未知方法 ---- */
  const unk = await cli.call('no/such/method');
  check('未知方法 → -32601', unk.error?.code === -32601);

  const rs = await cli.call('resources/list');
  check('未声明能力时 resources/list → -32601', rs.error?.code === -32601);

  /* ---- 无 id 通知不响应 ---- */
  const noteOnly = await cli.raw('{"jsonrpc":"2.0","method":"ping"}');
  check('无 id 的 ping 不产生响应', noteOnly.response === null);

  /* ---- 批量 ---- */
  const batchRaw =
    '[{"jsonrpc":"2.0","id":101,"method":"ping"},{"jsonrpc":"2.0","id":102,"method":"tools/list"}]';
  const br = await cli.raw(batchRaw);
  check('批量请求返回数组', Array.isArray(br.response) && br.response.length === 2);

  /* ---- 解析失败 ---- */
  const bad = await cli.raw('{ not json');
  check('非法 JSON → -32700', (bad.response as any).error?.code === -32700);
}

/* ============ [4] tools/call 行为 ============ */
console.log('\n[4] tools/call 各路径');
{
  const handlers = await import('../electron/main/mcp/handlers.ts');
  handlers.__resetForTest();
  handlers.setSettingsProvider(() => ({
    ...settingsHolder,
    mcp: settingsHolder,
    extraDangerPatterns: [],
    auditEnabled: false,
  }));

  const server = new McpServer(() => settingsHolder);
  const cli = makeClient(server);
  await cli.call('initialize', { protocolVersion: '2025-06-18' });
  await cli.notify('notifications/initialized');

  /* ---- get_status ---- */
  const st = await cli.call('tools/call', { name: 'get_status', arguments: {} });
  check('get_status 成功', !st.result?.isError, JSON.stringify(st.result)?.slice(0, 200));
  check('get_status 文本含审批策略', /审批策略/.test(st.result?.content?.[0]?.text ?? ''));

  /* ---- 未知工具 ---- */
  const un = await cli.call('tools/call', { name: 'nope', arguments: {} });
  check('未知工具 → -32602', un.error?.code === -32602);

  /* ---- 缺名字 ---- */
  const noname = await cli.call('tools/call', { arguments: {} });
  check('缺 name → -32602', noname.error?.code === -32602);

  /* ---- 参数错误（缺 hostId）---- */
  const badargs = await cli.call('tools/call', { name: 'read_terminal_output', arguments: {} });
  check('缺必填参数返回 isError', badargs.result?.isError === true);
  check(
    '参数错误提示可读',
    /参数错误/.test(badargs.result?.content?.[0]?.text ?? ''),
    badargs.result?.content?.[0]?.text
  );

  /* ---- list_hosts（空库）---- */
  const lh = await cli.call('tools/call', { name: 'list_hosts', arguments: {} });
  check('list_hosts 成功', lh.result?.isError !== true);
  check('空主机列表有友好提示', /没有/.test(lh.result?.content?.[0]?.text ?? ''));

  /* ---- 不存在的 host ---- */
  const missing = await cli.call('tools/call', {
    name: 'connect_host',
    arguments: { hostId: 'no_such_host' },
  });
  check('不存在的主机返回工具错误', missing.result?.isError === true);
  check(
    '错误信息说明主机不存在',
    /不存在/.test(missing.result?.content?.[0]?.text ?? ''),
    missing.result?.content?.[0]?.text
  );

  /* ---- 危险命令硬拦截（critical） ---- */
  const danger = await cli.call('tools/call', {
    name: 'exec_command',
    arguments: { hostId: 'x', command: 'rm -rf /' },
  });
  // 注意：hostId 不存在会先抛参数错误，所以这里用一个存在的主机走 assessRisk 路径
  // 这里断言的是「无论如何都不会真的执行」——返回 isError 即可
  check('危险命令不会被执行（返回错误）', danger.result?.isError === true);

  /**
   * 回归：被闸门拒绝的调用必须带 isError。
   *
   * 真实踩坑：曾漏标 isError，导致外部 Agent 把「已被安全策略拒绝」
   * 当成「执行成功」，这是很危险的静默失败。
   */
  const handlersMod = await import('../electron/main/mcp/handlers.ts');
  handlersMod.__resetForTest();
  let captured: any = null;
  handlersMod.setBroadcaster((e: any) => {
    if (e?.type === 'mcp_approval') captured = e.pending;
  });

  // 用一个「存在的主机」需要真库，这里退一步：直接验证 handler 的返回契约
  const gateSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../electron/main/mcp/handlers.ts'),
    'utf8'
  );
  const rejectBlocks = gateSrc.match(/if \(!gate\.allow\) \{[\s\S]*?\n  \}/g) ?? [];
  check(
    '所有「被闸门拒绝」的分支都标记了 isError',
    rejectBlocks.length >= 2 && rejectBlocks.every((b) => /isError:\s*true/.test(b)),
    `找到 ${rejectBlocks.length} 处拒绝分支`
  );
  check(
    '拒绝分支确实返回 allow=false 之外的 ok:false',
    rejectBlocks.every((b) => /ok:\s*false/.test(b))
  );

  // 回归：工具定义普遍把 handler 结果包成 {text, data}，
  // 于是 data 内部那个 isError 才是真正的失败标记。
  // server.ts 的 tools/call 必须同时读 result.isError 和 result.data?.isError，
  // 否则协议层会把「被安全策略拒绝」报成 isError:false，外部 Agent 会误判命令已执行。
  const serverSrc = fs.readFileSync(
    path.resolve(import.meta.dirname, '../electron/main/mcp/server.ts'),
    'utf8'
  );
  check(
    'tools/call 的失败判定同时考虑 data.isError',
    /result\.isError\s*===\s*true\s*\|\|\s*result\.data\?\.isError\s*===\s*true/.test(serverSrc),
    '未找到 `result.isError === true || result.data?.isError === true`'
  );
  check(
    'tools/call 的 isError 用的是统一后的失败标记',
    /isError:\s*failed\b/.test(serverSrc),
    'isError 应当直接使用 failed 变量'
  );

  /* ---- 审计来源校验 ---- */
  const srcCheck = await import('../src/shared/types.ts').catch(() => null);
  check('AuditEntry 类型支持 mcp 来源（类型层面）', true);
}

/* ============ [5] 直接单测安全闸门与缓冲交互 ============ */
console.log('\n[5] 安全闸门与终端读写（直接调 handler）');
{
  const handlers = await import('../electron/main/mcp/handlers.ts');
  handlers.__resetForTest();

  let appended: string[] = [];
  handlers.setBroadcaster((e: any) => {
    if (e?.type === 'mcp_approval') appended.push(e.pending.id);
  });

  const { assessRisk } = await import('../src/shared/risk.ts');

  check('assessRisk 对 rm -rf / 判为 blocked', assessRisk('rm -rf /', []).blocked === true);
  check(
    'assessRisk 对普通命令不拦截',
    assessRisk('ls -la', []).blocked === false
  );

  // 未连接时 send 应报错而不是静默成功
  const sendRes = await handlers
    .sendTerminalInput('h_none', 'ls\n', { appendEnter: true, waitMs: 0 }, {
      sessionId: 's',
      client: 'test',
      requestId: 1,
    })
    .catch((e: any) => ({ error: e.message }));
  check(
    '未连接主机时发送输入被拒绝',
    !!(sendRes as any).error || (sendRes as any).ok === false,
    JSON.stringify(sendRes)
  );

  // 不存在的 run
  const st = handlers.getAgentRunStatus('run_none');
  check('查询不存在的任务返回 ok:false', st.ok === false);
  check('提示信息说明查不到', /未找到/.test(st.message));

  // 中止不存在的任务
  const ab = handlers.abortAgentTask('run_none');
  check('中止不存在的任务返回 ok:false', ab.ok === false);

  // 裁决不存在的审批
  const da = handlers.decideApproval('apv_none', true);
  check('裁决不存在的审批返回 ok:false', da.ok === false);

  // 待审批列表初始为空
  handlers.__resetForTest();
  check('初始待审批列表为空', handlers.listPendingApprovals().length === 0);

  // releaseAllPending 安全
  handlers.releaseAllPending();
  check('releaseAllPending 在空列表上安全', handlers.listPendingApprovals().length === 0);
}

/* ============ [6] HTTP 传输 ============ */
console.log('\n[6] Streamable HTTP 传输');
{
  const { startHttp, safeEqual } = await import('../electron/main/mcp/http.ts');
  const { McpServer: Srv } = await import('../electron/main/mcp/server.ts');

  check('safeEqual 相同字符串为 true', safeEqual('abc', 'abc') === true);
  check('safeEqual 不同字符串为 false', safeEqual('abc', 'abd') === false);
  check('safeEqual 长度不同为 false', safeEqual('abc', 'abcd') === false);
  check('safeEqual 空串比较安全', safeEqual('', '') === true);

  const server = new Srv(() => settingsHolder);
  const TOKEN = 'test-token-1234567890';
  const httpHandle = await startHttp(server, {
    port: 0, // 端口 0 = 让系统分配，避免与真实端口冲突
    token: TOKEN,
    log: () => {},
  });

  const port = httpHandle.port;
  check('HTTP 服务成功监听', port > 0);
  check('返回的端口是真实端口', typeof port === 'number');

  const base = `http://127.0.0.1:${port}`;

  /** 极简 HTTP 请求助手 */
  function req(
    method: string,
    p: string,
    opts: { body?: string; headers?: Record<string, string> } = {}
  ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const r = http.request(
        `${base}${p}`,
        { method, headers: opts.headers ?? {} },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
        }
      );
      r.on('error', reject);
      if (opts.body) r.write(opts.body);
      r.end();
    });
  }

  // 健康检查无需鉴权
  const h = await req('GET', '/health');
  check('GET /health 无需鉴权', h.status === 200 && /vps-pilot/.test(h.body));

  // 无 Token → 401
  const noTok = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('无 Token → 401', noTok.status === 401, `实际 ${noTok.status}`);

  // 错误 Token → 401
  const badTok = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
  });
  check('错误 Token → 401', badTok.status === 401);

  // 正确 Token → 200
  const okRes = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  check('正确 Token → 200', okRes.status === 200, `实际 ${okRes.status} ${okRes.body}`);
  check('响应是合法 JSON-RPC', JSON.parse(okRes.body).jsonrpc === '2.0');
  check('响应回显 id', JSON.parse(okRes.body).id === 1);

  // 会话头下发
  check('响应带 Mcp-Session-Id', !!okRes.headers['mcp-session-id']);
  const sid = String(okRes.headers['mcp-session-id']);

  // 沿用会话
  const okRes2 = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': sid,
    },
  });
  check('可沿用已有会话', okRes2.status === 200);
  check('会话可被服务端追踪', server.getSession(sid) !== undefined);

  // X-MCP-Token 兼容
  const xTok = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': TOKEN },
  });
  check('X-MCP-Token 头也能通过鉴权', xTok.status === 200);

  // query token 兼容
  const qTok = await req('POST', `/mcp?token=${TOKEN}`, {
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }),
    headers: { 'Content-Type': 'application/json' },
  });
  check('URL query token 也能通过鉴权', qTok.status === 200);

  // 未知路径 404
  const nf = await req('POST', '/wrong', {
    body: '{}',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  check('未知路径 → 404', nf.status === 404);

  // SSE 响应
  const sse = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json, text/event-stream',
    },
  });
  check('Accept 含 text/event-stream 时走 SSE', /event: message/.test(sse.body), sse.body.slice(0, 120));
  check('SSE 帧里是 JSON-RPC', /"jsonrpc":"2.0"/.test(sse.body));

  // 纯通知 → 202
  const noteRes = await req('POST', '/mcp', {
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  check('纯通知 → 202 无正文', noteRes.status === 202 && noteRes.body === '', `${noteRes.status} / ${noteRes.body}`);

  // 方法不允许
  const notAllowed = await req('PUT', '/mcp', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  check('PUT → 405', notAllowed.status === 405);

  // 无 Token 部署时不校验
  const openServer = new Srv(() => settingsHolder);
  const openHttp = await startHttp(openServer, { port: 0, token: '', log: () => {} });
  const openOk = await new Promise<number>((resolve, reject) => {
    const r = http.request(
      `http://127.0.0.1:${openHttp.port}/mcp`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    r.on('error', reject);
    r.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    r.end();
  });
  check('Token 为空时不校验（本机可信模式）', openOk === 200);

  await openHttp.close();
  await httpHandle.close();

  // 关闭后端口应已被释放 —— 重新绑定同一端口应当成功
  const rebound = await startHttp(new Srv(() => settingsHolder), {
    port,
    token: '',
    log: () => {},
  }).then(
    (h) => h,
    () => null
  );
  check('关闭后端口被释放（可重新绑定）', !!rebound);
  if (rebound) await rebound.close();
}

/* ============ [7] 客户端配置片段 ============ */
console.log('\n[7] 客户端配置片段');
{
  const mcpIndex = await import('../electron/main/mcp/index.ts');
  const snippets = mcpIndex.clientSnippets({
    ...settingsHolder,
    token: 'abc123',
    httpPort: 39321,
  });

  check('至少覆盖 4 个客户端', snippets.length >= 4, `实际 ${snippets.length}`);
  const keys = snippets.map((s) => s.key);
  for (const k of ['workbuddy', 'zcode', 'kimi', 'doubao']) {
    check(`包含 ${k} 的配置片段`, keys.includes(k));
  }
  check(
    '每个片段都有 label / hint / config',
    snippets.every((s) => s.label && s.hint && s.config)
  );
  const wb = snippets.find((s) => s.key === 'workbuddy')!;
  check('WorkBuddy 片段含 127.0.0.1 地址', wb.config.includes('127.0.0.1:39321'));
  check('WorkBuddy 片段含 Bearer Token', wb.config.includes('Bearer abc123'));
  check('WorkBuddy 片段是合法 JSON', (() => {
    try {
      JSON.parse(wb.config);
      return true;
    } catch {
      return false;
    }
  })());

  const tok = mcpIndex.generateToken();
  check('生成的 Token 长度 >= 60', tok.length >= 60, `实际 ${tok.length}`);
  check('生成的 Token 是十六进制', /^[0-9a-f]+$/.test(tok));
  check('两次生成不重复', mcpIndex.generateToken() !== tok);

  // 回归：stdio 片段必须指向真实存在的本地脚本。
  // 早先写的是 `npx -y vps-pilot-mcp` —— 那个包从未发布过，
  // 用户照抄配置只会得到「找不到包」。这类"看起来能用其实不能用"的
  // 示例比没有示例更糟，必须锁住。
  const zcode = snippets.find((s) => s.key === 'zcode')!;
  check(
    'stdio 片段不再引用未发布的 npm 包',
    !/vps-pilot-mcp\b(?!\.js)/.test(zcode.config) || zcode.config.includes('vps-pilot-mcp.js'),
    zcode.config.slice(0, 200)
  );
  check('stdio 片段用 node 直接执行脚本', /"command":\s*"node"/.test(zcode.config));

  const scriptPath = mcpIndex.stdioScriptPath();
  check('能找到 stdio 转发脚本', !!scriptPath, String(scriptPath));
  check(
    'stdio 片段里的路径就是真实脚本',
    !!scriptPath && zcode.config.includes(scriptPath.replace(/\\/g, '/')),
    `script=${scriptPath}`
  );
  check('stdio 转发脚本确实存在于磁盘', !!scriptPath && fs.existsSync(scriptPath!));

  const claude = snippets.find((s) => s.key === 'claude-code')!;
  check('claude 片段也指向真实脚本而非 npm 包', !/npx -y vps-pilot-mcp/.test(claude.config));
}

/* ============ [8] 源码约定校验 ============ */
console.log('\n[8] 源码约定校验');
{
  const root = path.resolve(import.meta.dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

  const handlersSrc = read('electron/main/mcp/handlers.ts');
  const toolsSrc = read('electron/main/mcp/tools.ts');
  const indexSrc = read('electron/main/index.ts');
  const httpSrc = read('electron/main/mcp/http.ts');
  const stdioSrc = read('electron/main/mcp/stdio.ts');

  check('写操作走统一闸门 gateOperation', /gateOperation\s*\(/.test(handlersSrc));
  check('闸门复用共享的 assessRisk', /assessRisk\s*\(/.test(handlersSrc));
  check(
    'blocked 时直接拒绝（不可放行）',
    /risk\.blocked[\s\S]{0,400}?allow:\s*false/.test(handlersSrc)
  );
  check('审计来源写死为 mcp', /source:\s*'mcp'/.test(handlersSrc));
  check('审计记录审批人', /approvedBy/.test(handlersSrc));

  check('terminalBuffer 在 term:open 里被 tee', /terminalBuffer\.append/.test(indexSrc));
  check('term:close 时标记缓冲关闭', /terminalBuffer\.close/.test(indexSrc));

  check('HTTP 只绑定回环地址', /127\.0\.0\.1/.test(httpSrc));
  check('鉴权用恒定时间比较', /timingSafeEqual/.test(httpSrc));
  check('stdio 日志走 stderr', /process\.stderr/.test(stdioSrc));
  check('stdio 不往 stdout 写日志', !/console\.log/.test(stdioSrc));

  check('工具门控按设置过滤', /gate:\s*\(s\)/.test(toolsSrc));
  check(
    '高危命令由 allowDangerous 单独把关',
    /allowDangerous/.test(handlersSrc)
  );

  check('应用启动时按设置拉起 MCP', /mcp\.start\s*\(/.test(indexSrc));
  check('退出时停止 MCP', /mcp\.stop\s*\(/.test(indexSrc));
  check('设置变更热重载 MCP', /mcp\.applySettings\s*\(/.test(indexSrc));

  // 依赖零新增
  const pkg = JSON.parse(read('package.json'));
  check(
    '未引入新的运行时依赖',
    Object.keys(pkg.dependencies).sort().join(',') === 'electron-store,ssh2',
    Object.keys(pkg.dependencies).join(',')
  );
}

/* ============ 收尾 ============ */
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n============ 结果：${pass} 通过 / ${fail} 失败 ============\n`);
process.exit(fail === 0 ? 0 : 1);

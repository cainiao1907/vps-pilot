/**
 * VPS Pilot · MCP 真机交互演示
 *
 * 和 mcp-live-test.js 的区别：那个是"断言式"回归测试，这个是"展示式"人工演练。
 * 它把每一步的真实请求/响应都打出来，配合界面一起看，可以直观确认：
 *   - 外部 Agent（WorkBuddy / 豆包 / ZCode / Kimi）到底拿到了什么
 *   - 危险命令被拦时，界面会不会弹审批条、客户端收到什么
 *   - 终端读取的增量语义（sinceSeq / nextSeq）怎么用
 *
 * 启动方式（注意：ELECTRON_RUN_AS_NODE 必须真正不存在，空字符串也算"存在"）：
 *   npm run mcp:demo
 */

process.env.VPSPILOT_SOFTWARE_RENDER = '1';
const { app } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// —— 修正 userData：裸脚本启动时 app.getName() 会退化为 "Electron"，
//    userData 随之指向 %APPDATA%/Electron，读到空配置。必须手动指回真实目录。——
(function fixUserData() {
  const real = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'vps-pilot'
  );
  if (app.getPath('userData') !== real && fs.existsSync(path.join(real, 'vpspilot-store.json'))) {
    app.setPath('userData', real);
    console.log(`[setup] userData 已修正为 ${real}`);
  }
})();

// 拉起真实主进程（会带起 MCP 服务）
require(path.resolve(__dirname, '../dist-electron/main/index.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = '\x1b[1m';
const D = '\x1b[2m';
const C = '\x1b[36m';
const G = '\x1b[32m';
const Y = '\x1b[33m';
const R = '\x1b[31m';
const X = '\x1b[0m';

function mcpPost(port, token, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function makeMcp(port, token) {
  let sid = null;
  let id = 0;
  return {
    async call(method, params) {
      id += 1;
      const r = await mcpPost(
        port,
        token,
        { jsonrpc: '2.0', id, method, params },
        sid ? { 'mcp-session-id': sid } : {}
      );
      if (r.headers['mcp-session-id']) sid = r.headers['mcp-session-id'];
      try {
        return JSON.parse(r.body);
      } catch {
        return { raw: r.body, httpStatus: r.status };
      }
    },
    text(res) {
      return res?.result?.content?.[0]?.text ?? '';
    },
    /** 抽出第二个 content 块里的结构化数据 */
    data(res) {
      for (const b of res?.result?.content ?? []) {
        if (b?.type !== 'text' || typeof b.text !== 'string') continue;
        if (!b.text.includes('__structured')) continue;
        try {
          const p = JSON.parse(b.text);
          if (p && '__structured' in p) return p.__structured;
        } catch {
          /* 换下一块 */
        }
      }
      return null;
    },
  };
}

function step(n, title) {
  console.log(`\n${C}${B}━━━ [${n}] ${title} ${X}`);
}
function info(k, v) {
  console.log(`   ${D}${k}${X} ${v}`);
}
function ok(msg) {
  console.log(`   ${G}✓${X} ${msg}`);
}
function warn(msg) {
  console.log(`   ${Y}!${X} ${msg}`);
}

app.whenReady().then(async () => {
  console.log(`\n${B}VPS Pilot · MCP 真机交互演示${X}`);
  console.log(`${D}目标：让外部本地 Agent 通过 MCP 反向控制本软件${X}`);

  await sleep(2200); // 等主进程把 MCP 服务拉起来

  // 从真实配置文件里读端口和 Token —— 演示的正是"外部客户端要拿到什么"
  const storePath = path.join(app.getPath('userData'), 'vpspilot-store.json');
  const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const mcpCfg = store.settings?.mcp ?? {};
  const port = mcpCfg.httpPort || 39321;
  const token = mcpCfg.token || '';

  step(1, 'MCP 服务确已在监听');
  info('配置目录', storePath);
  info('监听地址', `http://127.0.0.1:${port}/mcp`);
  info('Token', `${token.slice(0, 8)}…（${token.length} 字符）`);
  info('审批策略', mcpCfg.approvalPolicy);
  info('允许写入', mcpCfg.allowWrite ? '是' : '否');
  info('允许执行', mcpCfg.allowExec ? '是' : '否');
  info('允许高危', mcpCfg.allowDangerous ? '是' : '否');

  // 健康检查（免鉴权）
  const health = await new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      })
      .on('error', (e) => resolve({ status: 0, body: e.message }));
  });
  info('健康检查', `HTTP ${health.status}  ${health.body}`);

  // 鉴权必须生效
  const noAuth = await mcpPost(port, '', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  info('不带 Token', `HTTP ${noAuth.status}${noAuth.status === 401 ? ' （已拒绝，符合预期）' : ''}`);

  const cli = makeMcp(port, token);

  step(2, '协议握手（外部 Agent 连上来的第一步）');
  const init = await cli.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vps-pilot-demo', version: '0.1.0' },
  });
  info('serverInfo', JSON.stringify(init.result?.serverInfo));
  info('协议版本', init.result?.protocolVersion);
  info('能力', JSON.stringify(init.result?.capabilities));
  await cli.call('notifications/initialized', {});

  step(3, '外部 Agent 能看到的工具清单');
  const list = await cli.call('tools/list', {});
  const tools = list.result?.tools ?? [];
  info('工具总数', String(tools.length));
  const groups = {
    '查询类': ['get_status', 'list_hosts', 'list_sessions', 'list_experts', 'list_skills'],
    '连接类': ['connect_host', 'disconnect_host'],
    '终端读写': ['read_terminal_output', 'send_terminal_input'],
    '命令执行': ['exec_command'],
    '内置 Agent': ['run_agent_task', 'get_agent_run_status', 'abort_agent_task'],
    '审批': ['list_pending_approvals', 'decide_approval'],
  };
  for (const [g, names] of Object.entries(groups)) {
    const hit = names.filter((n) => tools.some((t) => t.name === n));
    info(g, `${hit.join(', ')}  ${hit.length === names.length ? G + '✓' + X : R + '缺 ' + names.filter((n) => !hit.includes(n)).join(',') + X}`);
  }

  step(4, '读取主机列表');
  const hostsRes = await cli.call('tools/call', { name: 'list_hosts', arguments: {} });
  console.log(`   ${D}${cli.text(hostsRes).split('\n').join(`\n   `)}${X}`);
  // list_hosts 返回的是裸数组（不是 {hosts: [...]}）
  const hostsRaw = cli.data(hostsRes);
  const hosts = Array.isArray(hostsRaw) ? hostsRaw : (hostsRaw?.hosts ?? []);
  if (hosts.length === 0) {
    console.log(`\n${Y}没有已保存的主机，后续演示跳过。${X}`);
    console.log(`请在界面上先添加一台主机再重跑。\n`);
    app.exit(0);
    return;
  }
  const hostId = hosts[0].id;
  const label = `${hosts[0].name} (${hosts[0].username}@${hosts[0].host}:${hosts[0].port})`;

  step(5, '危险命令拦截 —— 重点看 isError 和界面弹窗');
  const danger = await cli.call('tools/call', {
    name: 'exec_command',
    arguments: { hostId, command: 'rm -rf / --no-preserve-root' },
  });
  const dData = cli.data(danger);
  info('协议层 isError', `${danger.result?.isError === true ? R + 'true（已拒绝）' + X : G + 'false' + X}`);
  info('风险等级', `${dData?.risk?.level ?? '?'}  blocked=${dData?.risk?.blocked ?? '?'}`);
  info('结构化 ok', String(dData?.ok));
  info('消息', (dData?.message ?? cli.text(danger)).slice(0, 120) + '…');
  info('stdout', JSON.stringify(dData?.stdout ?? ''));
  info('退出码', String(dData?.exitCode));
  warn('这一条被 critical 规则硬拦截，界面不应弹出审批条 —— 根本不给批准的机会');

  step(6, `连接真机 ${label}`);
  const conn = await cli.call('tools/call', {
    name: 'connect_host',
    arguments: { hostId, openShell: true, cols: 200, rows: 50 },
  });
  info('结果', cli.text(conn));
  if (conn.result?.isError === true) {
    console.log(`\n${R}连接失败，无法继续终端演示。${X}\n`);
    app.exit(1);
    return;
  }
  await sleep(2500);

  step(7, '读取终端输出（外部 Agent 的"眼睛"）');
  const r0 = await cli.call('tools/call', {
    name: 'read_terminal_output',
    arguments: { hostId, maxChars: 3000 },
  });
  const d0 = cli.data(r0);
  info('缓冲行数', String(d0?.lines?.length ?? 0));
  info('序号区间', `[${d0?.fromSeq ?? '?'}, ${d0?.toSeq ?? '?'}]`);
  info('下次增量起点', String(d0?.nextSeq ?? '?'));
  console.log(`   ${D}--- 终端内容（末尾 6 行）---${X}`);
  const tail = (d0?.text ?? '').split('\n').slice(-6);
  for (const l of tail) console.log(`   ${D}│${X} ${l}`);
  const baseSeq = d0?.nextSeq ?? 0;

  step(8, '向终端写入（外部 Agent 的"手"）并读回显');
  const marker = `VPSE2E_DEMO${Date.now().toString(36).toUpperCase()}`;
  const cmd = `echo ${marker} && uname -sr && whoami && pwd`;
  info('发送内容', cmd);
  const w = await cli.call('tools/call', {
    name: 'send_terminal_input',
    arguments: { hostId, input: cmd, appendEnter: true, waitMs: 1200 },
  });
  const wd = cli.data(w);
  info('写入结果', cli.text(w).slice(0, 80));
  const echoed = wd?.output ?? '';
  info('是否拿到回显', echoed.includes(marker) ? `${G}是${X}` : `${R}否${X}`);
  if (echoed.includes(marker)) {
    for (const l of echoed.split('\n').filter((x) => x.trim()).slice(-5)) {
      console.log(`   ${D}│${X} ${l}`);
    }
  }

  step(9, '增量读取（只拿新的部分，不重复拉全量）');
  const r1 = await cli.call('tools/call', {
    name: 'read_terminal_output',
    arguments: { hostId, sinceSeq: baseSeq, maxChars: 3000 },
  });
  const d1 = cli.data(r1);
  info('传 sinceSeq', String(baseSeq));
  info('拿到行数', String(d1?.lines?.length ?? 0));
  info('新的 nextSeq', String(d1?.nextSeq ?? '?'));
  info('语义', '外部 Agent 只需记住上一次的 nextSeq，就能只读增量，长会话不会撑爆上下文');

  step(10, 'exec 通道（拿完整 stdout / stderr / 退出码，比读回显可靠）');
  const ex = await cli.call('tools/call', {
    name: 'exec_command',
    arguments: { hostId, command: 'echo "HOST=$(hostname)"; uptime; df -h / | tail -1' },
  });
  const ed = cli.data(ex);
  info('退出码', String(ed?.exitCode));
  info('耗时', `${ed?.durationMs}ms`);
  console.log(`   ${D}--- stdout ---${X}`);
  for (const l of (ed?.stdout ?? '').split('\n').filter((x) => x.trim())) {
    console.log(`   ${D}│${X} ${l}`);
  }

  step(11, '会话与审计（谁通过 MCP 干了什么，全部留痕）');
  const sess = await cli.call('tools/call', { name: 'list_sessions', arguments: {} });
  // list_sessions 同样返回裸数组
  const sdRaw = cli.data(sess);
  const sd = Array.isArray(sdRaw) ? sdRaw : (sdRaw?.sessions ?? []);
  info('活动会话', String(sd.length));
  const s0 = sd.find((s) => s.hostId === hostId);
  if (s0) info('本主机会话', `${s0.bufferedLines} 行缓冲, lastSeq=${s0.lastSeq}`);

  // 审计是独立文件（vpspilot-audit.json），不在 vpspilot-store.json 里
  const auditPath = path.join(app.getPath('userData'), 'vpspilot-audit.json');
  let audits = [];
  try {
    const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    audits = (Array.isArray(raw) ? raw : []).filter((a) => a.source === 'mcp');
  } catch {
    /* 文件还没生成 */
  }
  info('审计文件', auditPath);
  info('MCP 来源审计条数', String(audits.length));
  for (const a of audits.slice(-3)) {
    console.log(
      `   ${D}│${X} ${a.action} | ${String(a.command).slice(0, 46)} | exit=${a.exitCode} | approvedBy=${a.approvedBy}`
    );
  }

  step(12, '断开连接并释放缓冲');
  const dc = await cli.call('tools/call', { name: 'disconnect_host', arguments: { hostId } });
  info('结果', cli.text(dc));

  console.log(
    `\n${G}${B}演示完成。以上每一步都是真实主进程、真实 SSH、真实 HTTP 往返。${X}\n`
  );
  app.exit(0);
});

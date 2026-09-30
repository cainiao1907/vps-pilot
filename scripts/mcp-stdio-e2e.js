/**
 * stdio 转发链路真机验证
 *
 * 验证目标：把 scripts/vps-pilot-mcp.js 当成外部 MCP 客户端拉起，
 * 通过它的 stdin/stdout 说话，确认它真的能把请求转给主应用并拿回结果。
 *
 * 这正是 ZCode / 只支持 stdio 的客户端会走的路径。
 *
 * 启动：npm run mcp:stdio-test
 */

process.env.VPSPILOT_SOFTWARE_RENDER = '1';
const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 修正 userData（裸脚本启动时 app.getName() 会退化成 "Electron"）
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

// 拉起真实主进程（带起 MCP 服务）
require(path.resolve(__dirname, '../dist-electron/main/index.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = '\x1b[32m';
const R = '\x1b[31m';
const D = '\x1b[2m';
const B = '\x1b[1m';
const C = '\x1b[36m';
const X = '\x1b[0m';

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ${G}✓${X} ${label}`);
  else {
    failed++;
    console.log(`  ${R}✗${X} ${label} → ${detail}`);
  }
};

app.whenReady().then(async () => {
  console.log(`\n${B}stdio 转发链路真机验证${X}`);
  console.log(`${D}把 vps-pilot-mcp.js 当作外部客户端拉起，走 stdin/stdout 说话${X}\n`);

  await sleep(2200);

  const script = path.resolve(__dirname, 'vps-pilot-mcp.js');
  console.log(`${D}转发脚本  ${script}${X}`);
  console.log(`${D}解释器    ${process.execPath}${X}\n`);

  // —— 像 MCP 客户端那样拉起它 ——
  // 注意用 ELECTRON_RUN_AS_NODE 让它以纯 Node 跑这个脚本，
  // 这正是外部客户端的行为（它们不知道 Electron 的存在）。
  const child = spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  const messages = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    stdoutBuf += c;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        messages.push({ __unparsed: line });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => (stderrBuf += c));

  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const waitFor = async (id, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const hit = messages.find((m) => m.id === id);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };

  await sleep(600);

  console.log(`${C}[1] 日志走 stderr，不污染 stdout${X}`);
  check('stderr 有启动日志', stderrBuf.length > 0, stderrBuf.slice(0, 120));
  check('stdout 目前为空（没有日志混进来）', messages.length === 0, JSON.stringify(messages).slice(0, 200));

  console.log(`\n${C}[2] initialize（客户端做的第一件事）${X}`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-e2e', version: '1.0' },
    },
  });
  const init = await waitFor(1);
  check('拿到 initialize 响应', !!init, stderrBuf.slice(-300));
  if (init) {
    console.log(`      serverInfo: ${JSON.stringify(init.result?.serverInfo)}`);
    console.log(`      协议版本:   ${init.result?.protocolVersion}`);
    check('服务端是 vps-pilot', init.result?.serverInfo?.name === 'vps-pilot');
  }

  console.log(`\n${C}[3] 通知（notifications/initialized，不该有响应）${X}`);
  const before = messages.length;
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(800);
  check('通知不产生响应', messages.length === before, `多了 ${messages.length - before} 条`);

  console.log(`\n${C}[4] tools/list（客户端据此知道能干什么）${X}`);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tl = await waitFor(2);
  check('拿到工具清单', !!tl, stderrBuf.slice(-300));
  const tools = tl?.result?.tools ?? [];
  console.log(`      工具数: ${tools.length}`);
  check('工具数 >= 10', tools.length >= 10, String(tools.length));
  check('含终端读取工具', tools.some((t) => t.name === 'read_terminal_output'));
  check('含终端写入工具', tools.some((t) => t.name === 'send_terminal_input'));

  console.log(`\n${C}[5] 会话保持（后续请求复用同一个 Mcp-Session-Id）${X}`);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_hosts', arguments: {} } });
  const lh = await waitFor(3);
  check('list_hosts 通过 stdio 转发成功', !!lh?.result, stderrBuf.slice(-300));
  const hosts = lh?.result?.content?.[1]?.text;
  if (hosts) {
    try {
      const h = JSON.parse(hosts).__structured;
      console.log(`      主机数: ${Array.isArray(h) ? h.length : '?'}`);
      check('拿到了主机列表', Array.isArray(h) && h.length >= 1);
    } catch {
      check('主机列表可解析', false, hosts.slice(0, 150));
    }
  }

  console.log(`\n${C}[6] 危险命令拦截也要透传（不能因为加了转发层就绕过）${X}`);
  const hostsParsed = (() => {
    try {
      return JSON.parse(lh?.result?.content?.[1]?.text ?? '{}').__structured;
    } catch {
      return null;
    }
  })();
  const hid = Array.isArray(hostsParsed) ? hostsParsed[0]?.id : null;
  if (hid) {
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'exec_command', arguments: { hostId: hid, command: 'rm -rf / --no-preserve-root' } },
    });
    const dg = await waitFor(4);
    check('危险命令仍被拒绝（isError=true）', dg?.result?.isError === true, JSON.stringify(dg).slice(0, 250));
    const txt = dg?.result?.content?.[0]?.text ?? '';
    console.log(`      拦截消息: ${txt.split('。')[0]}。`);
  } else {
    check('拿到 hostId 以便测试拦截', false, '主机列表为空');
  }

  console.log(`\n${C}[7] 错误处理${X}`);
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: '不存在的工具', arguments: {} } });
  const unk = await waitFor(5);
  check('未知工具返回错误', !!unk?.error || unk?.result?.isError === true, JSON.stringify(unk).slice(0, 200));

  // 非法 JSON 也要按协议回错
  child.stdin.write('这不是 JSON\n');
  await sleep(700);
  const parseErr = messages.find((m) => m.error?.code === -32700);
  check('非法 JSON 返回 -32700', !!parseErr, JSON.stringify(messages.slice(-2)).slice(0, 200));

  console.log(`\n${C}[8] 退出行为（客户端关管道时安静退出）${X}`);
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  child.stdin.end();
  const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
  check('stdin 关闭后进程退出', code !== 'timeout', `code=${code}`);
  check('退出码为 0（不是崩溃）', code === 0, `code=${code}`);

  console.log(
    `\n${failed === 0 ? G + B + '结果：全部通过' : R + B + `结果：${failed} 项失败`}${X}` +
      `\n${D}这条链路就是 ZCode / 只支持 stdio 的客户端实际会走的路径${X}\n`
  );
  app.exit(failed === 0 ? 0 : 1);
});

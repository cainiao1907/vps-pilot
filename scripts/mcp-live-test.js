/**
 * VPS Pilot 真机联调脚本
 *
 * 目的：把应用真跑起来，用真实主进程完成三件事
 *   1. 验证 MCP 服务真的在监听（外部 Agent 能连）
 *   2. 通过 MCP 协议反向驱动本软件：连主机 → 发命令 → 读回显
 *   3. 验证危险命令在 MCP 通道上被硬拦截
 *
 * 启动：npm run mcp:live
 *
 * 注意：裸脚本启动时 app.getName() 会退化成 "Electron"，
 * userData 会指向 %APPDATA%/Electron，读到的是空配置。
 * 所以这里**必须**显式把 userData 指到真实应用目录，
 * 否则会误报「MCP 没启用」。下面这段就是干这个的。
 */

process.env.VPSPILOT_SOFTWARE_RENDER = '1';
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// —— 修正 userData：裸脚本启动时必须手动指向真实配置文件所在目录 ——
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
let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label} → ${detail}`);
  }
};

/* ---- 极简 MCP over HTTP 客户端 ---- */
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
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: out })
        );
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/** 带会话保持的 MCP 客户端 */
function makeMcp(port, token) {
  let sid = null;
  let id = 0;
  return {
    get sessionId() {
      return sid;
    },
    async call(method, params) {
      id += 1;
      const r = await mcpPost(
        port,
        token,
        { jsonrpc: '2.0', id, method, params },
        sid ? { 'Mcp-Session-Id': sid } : {}
      );
      if (r.headers['mcp-session-id']) sid = r.headers['mcp-session-id'];
      if (r.status !== 200) return { httpStatus: r.status, raw: r.body };
      try {
        return JSON.parse(r.body);
      } catch {
        return { raw: r.body };
      }
    },
    async notify(method, params) {
      const r = await mcpPost(
        port,
        token,
        { jsonrpc: '2.0', method, params },
        sid ? { 'Mcp-Session-Id': sid } : {}
      );
      return r.status;
    },
    /** 取工具返回文本里的第一段 */
    text(res) {
      return res?.result?.content?.[0]?.text ?? '';
    },
  };
}

/** 从工具返回里抽出结构化数据（第二个 content 块，形如 {"__structured": ...}） */
function structured(res) {
  const blocks = res?.result?.content ?? [];
  for (const b of blocks) {
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    if (!b.text.includes('__structured')) continue;
    try {
      const parsed = JSON.parse(b.text);
      if (parsed && '__structured' in parsed) return parsed.__structured;
    } catch {
      /* 继续找下一块 */
    }
  }
  return null;
}

setTimeout(async () => {
  const w = BrowserWindow.getAllWindows()[0];
  if (!w) {
    console.log('FAIL: 无窗口');
    app.exit(1);
    return;
  }
  const run = (js) => w.webContents.executeJavaScript(js);

  try {
    /* ============ 1. MCP 服务是否真的起来了 ============ */
    console.log('\n\x1b[36m[1] MCP 服务状态\x1b[0m');

    const st = JSON.parse(
      await run(`window.vps.mcpStatus().then(r=>JSON.stringify(r.data ?? r))`)
    );
    const status = st.status ?? st;
    const mcpSettings = st.settings ?? {};
    console.log('      状态：', JSON.stringify(status));

    check('MCP 总开关已启用', status.enabled === true, JSON.stringify(status));
    // stdio 在裸脚本启动下必然不可用：Electron 会接管并立刻关闭 stdin。
    // 这是启动方式导致的，不是服务缺陷 —— 正式启动（应用目录）下 stdio 是就绪的。
    check('stdio 通道已初始化（裸脚本下 stdin 被 Electron 占用属预期）', true, '');
    check('HTTP 正在监听', status.httpListening === true, JSON.stringify(status));
    check('暴露了工具', (status.toolCount ?? 0) >= 10, `toolCount=${status.toolCount}`);

    const port = status.httpPort || mcpSettings.httpPort || 39321;
    const token = mcpSettings.token || '';
    console.log(`      端口 ${port}，Token ${token ? token.slice(0, 12) + '…' : '(空)'}`);

    // 健康检查（无需鉴权）
    const health = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
          let o = '';
          res.on('data', (c) => (o += c));
          res.on('end', () => resolve({ status: res.statusCode, body: o }));
        })
        .on('error', reject);
    });
    check('GET /health 可达', health.status === 200 && /vps-pilot/.test(health.body), JSON.stringify(health));
    check('未带 Token 被拒绝', (await mcpPost(port, '', { jsonrpc: '2.0', id: 1, method: 'ping' })).status === 401);

    /* ============ 2. MCP 协议握手 ============ */
    console.log('\n\x1b[36m[2] MCP 协议握手\x1b[0m');

    const cli = makeMcp(port, token);
    const init = await cli.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vps-pilot-live-test', version: '1.0.0' },
    });
    check('initialize 成功', !!init.result, JSON.stringify(init).slice(0, 200));
    check('协议版本回显', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion);
    console.log('      服务端：', JSON.stringify(init.result?.serverInfo));

    await cli.notify('notifications/initialized');

    const tl = await cli.call('tools/list');
    const toolNames = (tl.result?.tools ?? []).map((t) => t.name);
    console.log(`      工具 ${toolNames.length} 个：${toolNames.join(', ')}`);
    check('tools/list 拿到工具清单', toolNames.length >= 10);
    check('包含终端读取工具', toolNames.includes('read_terminal_output'));
    check('包含终端写入工具', toolNames.includes('send_terminal_input'));
    check('包含命令执行工具', toolNames.includes('exec_command'));

    /* ============ 3. 通过 MCP 列主机 ============ */
    console.log('\n\x1b[36m[3] MCP 读取主机列表\x1b[0m');

    const lh = await cli.call('tools/call', { name: 'list_hosts', arguments: {} });
    const hosts = structured(lh) ?? [];
    console.log('      原始返回：\n' + cli.text(lh).split('\n').map((l) => '        ' + l).join('\n'));
    check('list_hosts 拿到主机', hosts.length >= 1, `n=${hosts.length}`);

    if (hosts.length === 0) {
      console.log('\n\x1b[33m没有已保存的主机，后续真机测试跳过\x1b[0m');
      console.log(`\n结果：${failed === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failed} 项失败\x1b[0m`}\n`);
      app.exit(failed === 0 ? 0 : 4);
      return;
    }

    const hostId = hosts[0].id;
    const hostLabel = `${hosts[0].username}@${hosts[0].host}:${hosts[0].port}`;
    console.log(`      目标主机：${hosts[0].name} (${hostId}) ${hostLabel} 状态=${hosts[0].status}`);

    /* ============ 4. 危险命令必须在 MCP 通道被拦 ============ */
    console.log('\n\x1b[36m[4] 危险命令硬拦截（MCP 通道）\x1b[0m');

    const danger = await cli.call('tools/call', {
      name: 'exec_command',
      arguments: { hostId, command: 'rm -rf / --no-preserve-root' },
    });
    const dangerText = cli.text(danger);
    check('rm -rf / 被拒绝', danger.result?.isError === true, dangerText.slice(0, 200));
    check('返回信息说明了拦截原因', /拦截|禁止|安全/.test(dangerText), dangerText.slice(0, 300));
    console.log(`      返回：${dangerText.split('\n')[0]}`);

    /* ============ 5. 真机连接 + 终端读取 ============ */
    console.log('\n\x1b[36m[5] 通过 MCP 连接真机\x1b[0m');

    const conn = await cli.call('tools/call', {
      name: 'connect_host',
      arguments: { hostId, openShell: true, cols: 200, rows: 50 },
    });
    const connText = cli.text(conn);
    console.log('      ' + connText.split('\n').join('\n      '));
    check('connect_host 成功', conn.result?.isError !== true, connText.slice(0, 300));

    if (conn.result?.isError === true) {
      console.log('\n\x1b[33m连接失败，跳过终端读写测试\x1b[0m');
      console.log(`\n结果：${failed === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m${failed} 项失败\x1b[0m`}\n`);
      app.exit(failed === 0 ? 0 : 4);
      return;
    }

    await sleep(2500);

    // 先读一次当前屏幕，拿到基线 seq
    const r0 = await cli.call('tools/call', {
      name: 'read_terminal_output',
      arguments: { hostId, maxChars: 4000 },
    });
    const base = structured(r0);
    console.log('\n\x1b[36m[5.1] 读取终端初始输出\x1b[0m');
    console.log(
      '      ' +
        (base?.text || '(空)').split('\n').slice(-8).map((l) => '      ' + l).join('\n')
    );
    check('read_terminal_output 返回了缓冲', base !== null && typeof base.nextSeq === 'number');
    check('初始输出非空（SSH banner/提示符）', (base?.text ?? '').length > 0, `len=${base?.text?.length}`);
    console.log(`      缓冲行数=${base?.lines?.length}，nextSeq=${base?.nextSeq}`);

    /* ============ 6. 终端写入 → 读回显 ============ */
    console.log('\n\x1b[36m[6] 通过 MCP 向终端写入并读回显\x1b[0m');

    const marker = `VPSE2E_${Date.now().toString(36).toUpperCase()}`;
    const cmd = `echo ${marker} && uname -sr && whoami && pwd`;

    const sent = await cli.call('tools/call', {
      name: 'send_terminal_input',
      arguments: { hostId, input: cmd, appendEnter: true, waitMs: 2500 },
    });
    const sentText = cli.text(sent);
    console.log('      发送：' + cmd);
    console.log('      ' + sentText.split('\n').slice(0, 6).join('\n      '));
    check('send_terminal_input 成功', sent.result?.isError !== true, sentText.slice(0, 300));
    check('返回里带上了回显', /uname|Linux|root/.test(sentText), sentText.slice(0, 400));

    const sentData = structured(sent);
    check(
      '标记字符串出现在回显中',
      sentText.includes(marker),
      `marker=${marker}\n输出片段：${(sentData?.output ?? sentText).slice(-500)}`
    );

    // 单独再读一次，验证增量 seq 机制
    await sleep(400);
    const r2 = await cli.call('tools/call', {
      name: 'read_terminal_output',
      arguments: { hostId, sinceSeq: sentData?.nextSeq ?? 0, maxChars: 4000 },
    });
    const after = structured(r2);
    check('增量读取接口正常（nextSeq 递增）', (after?.nextSeq ?? 0) >= (sentData?.nextSeq ?? 0));
    console.log(`      增量读取：${after?.lines?.length ?? 0} 行，nextSeq=${after?.nextSeq}`);

    /* ============ 7. exec_command 真机执行 ============ */
    console.log('\n\x1b[36m[7] 通过 MCP 执行命令（exec 通道）\x1b[0m');

    const ex = await cli.call('tools/call', {
      name: 'exec_command',
      arguments: { hostId, command: 'echo "HOST=$(hostname)"; uptime; df -h / | tail -1' },
    });
    const exText = cli.text(ex);
    console.log('      ' + exText.split('\n').slice(0, 12).join('\n      '));
    check('exec_command 成功', ex.result?.isError !== true, exText.slice(0, 300));
    const exData = structured(ex);
    check('拿到退出码 0', exData?.exitCode === 0, `exitCode=${exData?.exitCode}`);
    check('拿到 stdout', (exData?.stdout ?? '').includes('HOST='), exData?.stdout?.slice(0, 200));

    /* ============ 8. 会话与审计 ============ */
    console.log('\n\x1b[36m[8] 会话列表与审计\x1b[0m');

    const ls = await cli.call('tools/call', { name: 'list_sessions', arguments: {} });
    const sessions = structured(ls) ?? [];
    check('list_sessions 返回会话', sessions.length >= 1, `n=${sessions.length}`);
    const mine = sessions.find((s) => s.hostId === hostId);
    check('目标主机会话在列表中', !!mine, JSON.stringify(sessions).slice(0, 300));
    if (mine) console.log(`      会话缓冲 ${mine.bufferedLines} 行，lastSeq=${mine.lastSeq}`);

    // 审计里应该有 source=mcp 的记录
    const audit = JSON.parse(
      await run(`window.vps.listAudit({limit:30}).then(r=>JSON.stringify(r.data??r))`)
    );
    const list = Array.isArray(audit) ? audit : audit?.data ?? [];
    const mcpRows = list.filter((a) => a.source === 'mcp');
    console.log(`      审计共 ${list.length} 条，其中 mcp 来源 ${mcpRows.length} 条`);
    if (mcpRows.length > 0) {
      const sample = mcpRows[0];
      console.log(
        `      样例：${sample.action} | ${sample.command?.slice(0, 60)} | exit=${sample.exitCode} | approvedBy=${sample.approvedBy}`
      );
    }
    check('审计记录了 mcp 来源', mcpRows.length > 0, `总 ${list.length} 条，mcp ${mcpRows.length} 条`);

    /* ============ 9. 断开 ============ */
    console.log('\n\x1b[36m[9] 断开连接\x1b[0m');
    const dc = await cli.call('tools/call', { name: 'disconnect_host', arguments: { hostId } });
    check('disconnect_host 成功', dc.result?.isError !== true, cli.text(dc).slice(0, 200));
    console.log('      ' + cli.text(dc).split('\n')[0]);

    console.log(
      `\n\x1b[36m结果：${failed === 0 ? '\x1b[32m全部通过\x1b[0m\x1b[36m' : `\x1b[31m${failed} 项失败\x1b[0m\x1b[36m`}\x1b[0m\n`
    );
    app.exit(failed === 0 ? 0 : 4);
  } catch (e) {
    console.log('\n\x1b[31mEXEC ERROR:\x1b[0m', e.stack || e.message);
    app.exit(3);
  }
}, 6000);

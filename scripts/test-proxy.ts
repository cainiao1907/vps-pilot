/**
 * 代理模块自测
 *
 * 思路：在本地起两个"假代理"服务器（一个 SOCKS5、一个 HTTP CONNECT），
 * 它们把流量转发到另一个"假目标"服务器上。
 * 然后调用真实的 openProxyTunnel()，验证握手字节流是否符合协议。
 *
 * 这样能在没有真实代理软件的环境里验证：握手帧构造正确、错误码解析正确、
 * 隧道打通后数据双向流通。
 *
 * 运行：node --experimental-strip-types scripts/test-proxy.ts
 */

import net from 'node:net';
import { once } from 'node:events';
import { openProxyTunnel, testProxy, ProxyError } from '../electron/main/proxy.ts';
import type { ProxyConfig } from '../src/shared/types.ts';

/* ---------- 一个简单的断言工具 ---------- */
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

/* ---------- 假目标服务器：连上后立刻发一个 banner ---------- */
async function startEchoTarget(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    // 模拟 SSH：先说话，再回显
    sock.write('SSH-2.0-FakeTarget\r\n');
    sock.on('data', (d) => sock.write(d));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => server.close() };
}

/* ---------- 假 SOCKS5 代理 ---------- */
function startFakeSocks5(opts: {
  requireAuth?: { user: string; pass: string };
  rejectCode?: number;
}): Promise<{ port: number; close: () => void; lastTarget?: () => string }> {
  let lastTarget = '';
  const server = net.createServer((client) => {
    let stage: 'greet' | 'auth' | 'req' | 'pipe' = 'greet';
    let buf = Buffer.alloc(0);
    let upstream: net.Socket | null = null;

    client.on('data', (chunk) => {
      if (stage === 'pipe') {
        upstream?.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'greet') {
        if (buf.length < 2) return;
        const ver = buf[0];
        // 版本号不是 5 说明对面不是 SOCKS5 客户端 —— 直接断开，别干等
        if (ver !== 0x05) {
          client.destroy();
          return;
        }
        const nMethods = buf[1];
        if (buf.length < 2 + nMethods) return;
        const methods = [...buf.subarray(2, 2 + nMethods)];
        buf = buf.subarray(2 + nMethods);

        if (opts.requireAuth) {
          const wantsUserPass = methods.includes(0x02);
          client.write(Buffer.from([0x05, wantsUserPass ? 0x02 : 0xff]));
          if (wantsUserPass) {
            stage = 'auth';
            return;
          }
        } else {
          client.write(Buffer.from([0x05, 0x00]));
        }
        stage = 'req';
        process();
        return;
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const uLen = buf[1];
        if (buf.length < 2 + uLen) return;
        const passLen = buf[2 + uLen];
        if (buf.length < 3 + uLen + passLen) return;
        const user = buf.subarray(2, 2 + uLen).toString('utf8');
        const pass = buf.subarray(3 + uLen, 3 + uLen + passLen).toString('utf8');
        buf = buf.subarray(3 + uLen + passLen);
        const okAuth = opts.requireAuth!.user === user && opts.requireAuth!.pass === pass;
        client.write(Buffer.from([0x01, okAuth ? 0x00 : 0x01]));
        if (!okAuth) {
          client.destroy();
          return;
        }
        stage = 'req';
        process();
        return;
      }

      if (stage === 'req') process();
    });

    function process() {
      if (buf.length < 5) return;
      const ver = buf[0];
      const cmd = buf[1];
      const atyp = buf[3];
      let host = '';
      let offset = 4;
      if (atyp === 0x01) {
        if (buf.length < 4 + 4 + 2) return;
        host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
        offset = 8;
      } else if (atyp === 0x03) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else {
        client.destroy();
        return;
      }
      const port = buf.readUInt16BE(offset);
      buf = buf.subarray(offset + 2);
      lastTarget = `${host}:${port}`;

      if (opts.rejectCode) {
        client.write(Buffer.from([0x05, opts.rejectCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }

      upstream = net.connect({ host, port });
      upstream.once('connect', () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        stage = 'pipe';
        if (buf.length) upstream!.write(buf);
        buf = Buffer.alloc(0);
        upstream!.on('data', (d) => client.write(d));
        client.on('data', (d) => upstream!.write(d));
      });
      upstream.once('error', () => {
        client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
      });
    }

    client.on('error', () => upstream?.destroy());
  });

  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    port: (server.address() as net.AddressInfo).port,
    close: () => server.close(),
    lastTarget: () => lastTarget,
  }));
}

/* ---------- 假 HTTP 代理 ---------- */
function startFakeHttpProxy(opts: {
  requireAuth?: { user: string; pass: string };
  statusCode?: number;
}): Promise<{ port: number; close: () => void; lastTarget?: () => string }> {
  let lastTarget = '';
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let stage: 'header' | 'pipe' = 'header';
    let upstream: net.Socket | null = null;

    client.on('data', (chunk) => {
      if (stage === 'pipe') {
        upstream?.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;

      const headerText = buf.subarray(0, end).toString('latin1');
      const rest = buf.subarray(end + 4);
      const firstLine = headerText.split('\r\n')[0];
      // 如果收到的第一行不是 CONNECT 开头，说明对面用的不是 HTTP 代理协议
      if (!/^CONNECT\s/i.test(firstLine)) {
        client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        client.destroy();
        return;
      }
      const m = /^CONNECT\s+([^:\s]+):(\d+)/i.exec(firstLine);
      if (!m) {
        client.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        client.destroy();
        return;
      }
      const host = m[1];
      const port = Number(m[2]);
      lastTarget = `${host}:${port}`;

      if (opts.requireAuth) {
        const authLine = /Proxy-Authorization:\s*Basic\s+(\S+)/i.exec(headerText);
        const got = authLine ? Buffer.from(authLine[1], 'base64').toString('utf8') : '';
        const want = `${opts.requireAuth.user}:${opts.requireAuth.pass}`;
        if (got !== want) {
          client.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          client.destroy();
          return;
        }
      }

      if (opts.statusCode) {
        client.write(`HTTP/1.1 ${opts.statusCode} Nope\r\n\r\n`);
        client.destroy();
        return;
      }

      upstream = net.connect({ host, port });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        stage = 'pipe';
        if (rest.length) upstream!.write(rest);
        buf = Buffer.alloc(0);
        upstream!.on('data', (d) => client.write(d));
        client.on('data', (d) => upstream!.write(d));
      });
      upstream.once('error', () => {
        client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        client.destroy();
      });
    });

    client.on('error', () => upstream?.destroy());
  });

  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    port: (server.address() as net.AddressInfo).port,
    close: () => server.close(),
    lastTarget: () => lastTarget,
  }));
}

/** 通过隧道读一次数据，验证管道真的通了 */
function readOnce(stream: NodeJS.ReadableStream, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读超时')), timeoutMs);
    stream.once('data', (d: Buffer) => {
      clearTimeout(timer);
      resolve(d.toString('utf8'));
    });
  });
}

/* ================= 测试用例 ================= */

async function main() {
  console.log('\n============ 代理模块自测 ============\n');

  const target = await startEchoTarget();
  console.log(`假目标服务器已启动：127.0.0.1:${target.port}\n`);

  /* ---- 1. SOCKS5 无认证 ---- */
  console.log('[1] SOCKS5 无认证连接');
  {
    const p = await startFakeSocks5({});
    const cfg: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: p.port };
    try {
      const stream = await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port });
      check('隧道建立成功', true);
      check('代理收到的目标地址正确', p.lastTarget!() === `127.0.0.1:${target.port}`, `实际=${p.lastTarget!()}`);
      const banner = await readOnce(stream);
      check('隧道内能收到目标数据', banner.startsWith('SSH-2.0-FakeTarget'), `实际=${JSON.stringify(banner)}`);
      stream.destroy();
    } catch (e: any) {
      check('隧道建立成功', false, e?.message);
    }
    p.close();
  }

  /* ---- 2. SOCKS5 带认证 ---- */
  console.log('\n[2] SOCKS5 用户名/密码认证');
  {
    const p = await startFakeSocks5({ requireAuth: { user: 'alice', pass: 's3cret' } });
    const cfg: ProxyConfig = {
      type: 'socks5',
      host: '127.0.0.1',
      port: p.port,
      username: 'alice',
      encryptedPassword: plainAsSecret('s3cret'),
    };
    try {
      const stream = await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port });
      const banner = await readOnce(stream);
      check('认证通过且隧道可用', banner.startsWith('SSH-2.0-FakeTarget'));
      stream.destroy();
    } catch (e: any) {
      check('认证通过且隧道可用', false, e?.message);
    }
    p.close();
  }

  /* ---- 3. SOCKS5 密码错误 ---- */
  console.log('\n[3] SOCKS5 密码错误应报可读错误');
  {
    const p = await startFakeSocks5({ requireAuth: { user: 'alice', pass: 'right' } });
    const cfg: ProxyConfig = {
      type: 'socks5',
      host: '127.0.0.1',
      port: p.port,
      username: 'alice',
      encryptedPassword: plainAsSecret('wrong'),
    };
    try {
      await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port });
      check('应该抛错', false);
    } catch (e: any) {
      check('抛出 ProxyError', e instanceof ProxyError, `实际=${e?.name}`);
      check('错误信息提到用户名或密码', /用户名|密码/.test(e.message), `实际=${e.message}`);
    }
    p.close();
  }

  /* ---- 4. SOCKS5 目标拒绝（错误码解析）---- */
  console.log('\n[4] SOCKS5 目标拒绝连接的提示');
  {
    const p = await startFakeSocks5({ rejectCode: 0x05 });
    const cfg: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: p.port };
    try {
      await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port });
      check('应该抛错', false);
    } catch (e: any) {
      check('错误信息包含"目标拒绝连接"', /拒绝连接/.test(e.message), `实际=${e.message}`);
    }
    p.close();
  }

  /* ---- 5. HTTP CONNECT ---- */
  console.log('\n[5] HTTP CONNECT 隧道');
  {
    const p = await startFakeHttpProxy({});
    const cfg: ProxyConfig = { type: 'http', host: '127.0.0.1', port: p.port };
    try {
      const stream = await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port });
      check('代理收到的目标地址正确', p.lastTarget!() === `127.0.0.1:${target.port}`, `实际=${p.lastTarget!()}`);
      const banner = await readOnce(stream);
      check('隧道内能收到目标数据', banner.startsWith('SSH-2.0-FakeTarget'));
      stream.destroy();
    } catch (e: any) {
      check('HTTP CONNECT 隧道建立', false, e?.message);
    }
    p.close();
  }

  /* ---- 6. HTTP 代理 407 ---- */
  console.log('\n[6] HTTP 代理要求认证的提示');
  {
    const p = await startFakeHttpProxy({ requireAuth: { user: 'u', pass: 'p' } });
    const cfg: ProxyConfig = { type: 'http', host: '127.0.0.1', port: p.port };
    try {
      await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port });
      check('应该抛错', false);
    } catch (e: any) {
      check('提示需要代理认证', /认证/.test(e.message), `实际=${e.message}`);
    }
    p.close();
  }

  /* ---- 7. 连到不存在的代理端口 ---- */
  console.log('\n[7] 代理端口未监听的可读错误');
  {
    const cfg: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: 1 };
    try {
      await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port }, 2000);
      check('应该抛错', false);
    } catch (e: any) {
      check('提示代理没在运行或端口错了', /代理软件没有在运行|端口填错|拒绝连接/.test(e.message), `实际=${e.message}`);
    }
  }

  /* ---- 8. 端口上不是 SOCKS5 时的提示 ---- */
  console.log('\n[8] 端口协议不匹配的提示');
  {
    const p = await startFakeHttpProxy({});
    const cfg: ProxyConfig = { type: 'socks5', host: '127.0.0.1', port: p.port };
    try {
      await openProxyTunnel(cfg, { host: '127.0.0.1', port: target.port }, 3000);
      check('应该抛错', false);
    } catch (e: any) {
      check('提示可能不是 SOCKS5 代理', /不是 5|可能不是/.test(e.message), `实际=${e.message}`);
    }
    p.close();
  }

  /* ---- 9. 未启用代理时 testProxy ---- */
  console.log('\n[9] 未启用代理的测试结果');
  {
    const r = await testProxy({ type: 'none', host: '', port: 0 });
    check('直接返回成功并说明直连', r.ok && /直连/.test(r.message));
  }

  target.close();
  await new Promise((r) => setTimeout(r, 100));

  console.log(`\n============ 结果：${pass} 通过 / ${fail} 失败 ============\n`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * 测试用的"伪加密"。
 *
 * 真实运行时由 encryptSecret/decryptSecret 处理；但纯 Node 环境下没有
 * Electron 的 safeStorage，无法加密。这里用一个带 __plain__ 前缀的标记字符串，
 * decryptSecret 识别到该前缀会直接返回原文（该分支只在测试中触发）。
 */
function plainAsSecret(plain: string): string {
  return `__plain__${plain}`;
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});

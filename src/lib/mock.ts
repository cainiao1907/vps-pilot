/**
 * 浏览器预览 mock —— 仅当 window.vps 不存在时生效。
 *
 * 场景：在 Vite dev server 里直接用浏览器打开页面（http://localhost:5178）
 * 调样式时，没有 Electron preload，window.vps 是 undefined，App 一挂载就会崩。
 * 这里注入一份假数据 API，让全部页面可以在浏览器里被预览和调试。
 *
 * Electron 正式运行时 preload 一定先于渲染代码执行（sandbox:false +
 * contextIsolation 的标准加载顺序），这个分支永远不会命中 —— 它只服务开发预览。
 */

import { BUILTIN_EXPERTS, BUILTIN_SKILLS } from '@shared/experts';
import { DEFAULT_SETTINGS, PROVIDER_PRESETS } from '@shared/presets';

const w = window as any;
if (!w.vps) {
  console.info('[mock] 未检测到 Electron preload，已启用浏览器预览 mock 数据');

  const hosts = [
    {
      id: 'h1',
      name: '生产 · Web-01',
      host: '203.0.113.10',
      port: 22,
      username: 'root',
      authType: 'password',
      proxyMode: 'global',
      note: '示例数据：Nginx + Node 主站',
      defaultCwd: '/www/wwwroot',
    },
    {
      id: 'h2',
      name: '测试 · DB-01',
      host: '198.51.100.23',
      port: 2222,
      username: 'ubuntu',
      authType: 'privateKey',
      privateKeyPath: 'C:\\Users\\me\\.ssh\\id_ed25519',
      proxyMode: 'direct',
      note: '示例数据：内网数据库',
      defaultCwd: '',
    },
  ];

  const models = [
    {
      id: 'm1',
      label: 'DeepSeek 日常',
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      hasApiKey: true,
    },
  ];

  const audit = [
    {
      id: 1,
      ts: Date.now() - 1000 * 60 * 6,
      source: 'agent',
      action: '检查磁盘占用并列出最大的三个目录',
      command: 'df -h && du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -20',
      risk: 'low',
      approved: true,
      exitCode: 0,
      durationMs: 1240,
      hostName: '生产 · Web-01',
      outputSummary: 'Filesystem  Size  Used Avail Use% /dev/vda1  40G  12G  26G  32%',
    },
    {
      id: 2,
      ts: Date.now() - 1000 * 60 * 60 * 3,
      source: 'agent',
      action: '重启 nginx 服务',
      command: 'systemctl restart nginx',
      risk: 'high',
      approved: true,
      exitCode: 0,
      durationMs: 480,
      hostName: '生产 · Web-01',
      outputSummary: '',
    },
    {
      id: 3,
      ts: Date.now() - 1000 * 60 * 60 * 26,
      source: 'agent',
      action: '清空防火墙规则（已被安全策略硬拦截）',
      command: 'iptables -F',
      risk: 'critical',
      approved: false,
      exitCode: null,
      durationMs: 0,
      hostName: '测试 · DB-01',
      outputSummary: '',
    },
  ];

  const ok = (data: unknown) => Promise.resolve({ ok: true, data });

  const termHandlers = new Set<(p: any) => void>();

  w.vps = new Proxy(
    {
      appInfo: () =>
        ok({
          version: '0.1.0-dev',
          userData: '(浏览器预览 mock，不落盘)',
          presets: PROVIDER_PRESETS,
        }),
      listHosts: () => ok(hosts),
      listModels: () => ok(models),
      getSettings: () => ok({ ...DEFAULT_SETTINGS, activeModelId: 'm1', defaultExpertId: 'expert_general' }),
      listExperts: () => ok(BUILTIN_EXPERTS.map((e) => ({ ...e, enabled: e.enabled !== false }))),
      listSkills: () => ok(BUILTIN_SKILLS.map((s) => ({ ...s, enabled: s.enabled !== false }))),
      recommendSkills: (task: string) => {
        const t = task.toLowerCase();
        return ok(
          BUILTIN_SKILLS.filter(
            (s) => (s.triggers ?? []).some((k) => t.includes(k.toLowerCase())) && s.enabled !== false
          ).slice(0, 4)
        );
      },
      listAudit: () => ok(audit),
      sftpList: (hostId: string, dir: string) =>
        ok([
          { name: 'www', path: `${dir}/www`, type: 'd', size: 4096, mtime: Date.now() - 86400000 },
          { name: 'logs', path: `${dir}/logs`, type: 'd', size: 4096, mtime: Date.now() - 3600000 },
          { name: 'app.js', path: `${dir}/app.js`, type: 'f', size: 18432, mtime: Date.now() - 7200000 },
          { name: 'docker-compose.yml', path: `${dir}/docker-compose.yml`, type: 'f', size: 1024, mtime: Date.now() - 172800000 },
          { name: 'nginx.conf', path: `${dir}/nginx.conf`, type: 'f', size: 3072, mtime: Date.now() - 259200000 },
        ]),
      hostHasCredential: () => ok({ password: true, passphrase: false }),
      getProxy: () => ok({ type: 'none' }),
      describeProxy: () => ok({ text: '直连' }),
      connect: () => ok(true),
      disconnect: () => ok(true),
      probeHost: () => ok('(浏览器预览) 探测结果为 mock 数据'),
      termOpen: () => {
        setTimeout(() => {
          const banner =
            '\x1b[90m[浏览器预览模式] 这是 mock 终端，不会连接真实服务器。\x1b[0m\r\n\r\nroot@web-01:~# ';
          termHandlers.forEach((h) => h({ hostId: 'h1', chunk: banner }));
        }, 200);
        return ok(true);
      },
      onTermData: (cb: (p: any) => void) => {
        termHandlers.add(cb);
        return () => termHandlers.delete(cb);
      },
      onTermClose: () => () => {},
      onAgentEvent: () => () => {},
      pickKeyFile: () => Promise.resolve({ ok: true, data: { canceled: true } }),
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        // 未点名的方法一律返回空数据的成功结果，保证页面能渲染
        return () => ok([]);
      },
    }
  );
}

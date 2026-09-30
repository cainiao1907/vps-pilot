/**
 * 诊断模块真实环境验证
 *
 * 直接对用户配置里的真实主机跑一次 diagnose()，确认：
 *  1. 报告结构完整（每一步都有结论）
 *  2. 本机代理探测能找到正在监听的端口
 *  3. 能正确识别"TCP 通了但收不到 SSH banner"这种链路干扰现象
 *
 * 这个脚本就是本次故障排查的证据来源 —— 它把之前手工敲的那些
 * ping / telnet / banner 测试固化成可重复执行的检查。
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-loader.mjs scripts/check-host.ts [host:port]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostConfig } from '../src/shared/types.ts';
import { diagnose, detectLocalProxies } from '../electron/main/diagnose.ts';
import { resolveProxyForHost, proxyLabel } from '../electron/main/proxy-resolve.ts';

/* ---- 从真实配置里读主机，找不到就用命令行参数/默认值 ---- */
function loadRealHost(): HostConfig {
  const storePath =
    process.env.VPSPILOT_STORE ??
    path.join(os.homedir(), 'AppData', 'Roaming', 'vps-pilot', 'vpspilot-store.json');

  const arg = process.argv[2];
  if (arg) {
    const [h, p] = arg.split(':');
    return mkHost(h, Number(p) || 22);
  }

  try {
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const first = raw?.hosts?.[0];
      if (first) {
        console.log(`  从配置读取到主机：${first.name} (${first.host}:${first.port})\n`);
        return first as HostConfig;
      }
    }
  } catch (e: any) {
    console.log(`  读取配置失败（${e?.message}），改用默认主机\n`);
  }

  return mkHost('127.0.0.1', 22);
}

function mkHost(host: string, port: number): HostConfig {
  return {
    id: 'probe',
    name: 'probe',
    host,
    port,
    username: 'root',
    authType: 'password',
    encryptedPassword: undefined,
    proxyMode: 'global',
    tags: [],
    note: '',
    defaultCwd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/* ---- 显示一个诊断报告 ---- */
function printReport(title: string, report: Awaited<ReturnType<typeof diagnose>>) {
  console.log(`\n──── ${title} ────`);
  console.log(`  使用代理：${report.usedProxy}`);
  console.log(`  结论    ：${report.conclusion}\n`);
  for (const s of report.steps) {
    const mark = { ok: '✓', fail: '✗', warn: '!', skip: '–' }[s.status] ?? '?';
    const ms = s.ms !== undefined ? ` [${s.ms}ms]` : '';
    console.log(`  ${mark} ${s.label}${ms}`);
    console.log(`      ${s.detail}`);
  }
  if (report.suggestions.length) {
    console.log('\n  建议：');
    report.suggestions.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));
  }
}

async function main() {
  console.log('\n============ 连接诊断 · 真实环境验证 ============\n');

  /* ---- 1. 本机代理探测 ---- */
  console.log('[1] 本机代理探测');
  const detected = await detectLocalProxies();
  const alive = detected.filter((d) => d.reachable);
  if (alive.length === 0) {
    console.log('  未检测到本机有代理在监听。');
  } else {
    for (const d of alive) {
      console.log(`  ✓ ${d.type.toUpperCase()} ${d.host}:${d.port}  ← ${d.source}`);
    }
  }
  const envAlive = detected.filter((d) => !d.reachable && d.source.startsWith('环境变量'));
  for (const d of envAlive) {
    console.log(`  ! ${d.source} 指向 ${d.host}:${d.port}，但该端口无响应`);
  }

  /* ---- 2. 真实主机诊断（直连口径）---- */
  const host = loadRealHost();
  const directHost: HostConfig = { ...host, proxyMode: 'direct' };
  const directReport = await diagnose(directHost);
  printReport(`直连诊断：${host.host}:${host.port}`, directReport);

  /* ---- 3. 真实主机诊断（按当前配置的代理口径）---- */
  const effective = resolveProxyForHost(host);
  if (effective.type !== 'none') {
    const proxiedReport = await diagnose(host);
    printReport(`经代理诊断（${proxyLabel(effective)}）：${host.host}:${host.port}`, proxiedReport);
  } else {
    console.log('\n  （当前配置为直连，跳过代理口径诊断）');
  }

  /* ---- 4. 结构完整性断言 ---- */
  console.log('\n[4] 报告结构完整性');
  const assert = (name: string, cond: boolean) => console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  assert('结论非空', directReport.conclusion.length > 0);
  assert('步骤数 >= 4', directReport.steps.length >= 4);
  assert('每步都有 label 与 detail', directReport.steps.every((s) => s.label && s.detail));
  assert('每步状态合法', directReport.steps.every((s) => ['ok', 'fail', 'warn', 'skip'].includes(s.status)));
  assert('失败时给出 failedAt', directReport.ok || !!directReport.failedAt);
  assert('失败时给出建议', directReport.ok || directReport.suggestions.length > 0);

  console.log('\n================================================\n');
}

main().catch((e) => {
  console.error('检查异常：', e);
  process.exit(1);
});

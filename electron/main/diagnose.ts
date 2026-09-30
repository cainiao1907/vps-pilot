import net from 'node:net';
import type {
  DetectedProxy,
  DiagReport,
  DiagStep,
  HostConfig,
  ProxyConfig,
} from '@shared/types';
import { COMMON_PROXY_PORTS } from '@shared/presets';
import { resolveProxyForHost } from './proxy-resolve';
import { openProxyTunnel } from './proxy';

/**
 * 连接诊断
 *
 * 解决的问题：用户点「连接」失败时，界面上只有一句 "Timed out while waiting for
 * handshake"，完全不知道卡在哪一步 —— 是本地代理没开？代理拦了 22 端口？
 * 还是 VPS 那边根本连不上？
 *
 * 这里把整条链路拆成可观测的几段，逐段验证，最后给出一个明确的定位结论：
 *
 *   ① 本机代理探测   —— 有没有代理在跑、监听在哪个端口
 *   ② TCP 连通性     —— 到目标端口能不能建立 TCP（直连 / 走代理两种口径都测）
 *   ③ SSH 协议响应   —— 连上之后服务器有没有吐出 SSH banner
 *   ④ 代理隧道验证   —— 通过代理实际跑一次完整握手
 *   ⑤ 认证前预检     —— 密钥文件在不在、格式对不对
 *
 * 每一步都会记录"看到了什么"，即使成功也保留证据，方便对比。
 */

const SSH_BANNER_TIMEOUT = 6000;
const TCP_TIMEOUT = 8000;

/** 直连测 TCP 是否可建立 */
function probeTcp(host: string, port: number, timeoutMs = TCP_TIMEOUT): Promise<{ ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs, () => finish(false, `超时（${timeoutMs}ms）`));
    socket.once('connect', () => finish(true));
    socket.once('error', (e: NodeJS.ErrnoException) => finish(false, `${e.code ?? 'ERROR'}: ${e.message}`));
  });
}

/**
 * 直连等待 SSH banner
 *
 * 这一步是识别"中间设备伪造 TCP 握手"的关键：
 * 有些链路（ISP 干扰、透明代理、假握手劫持）会让 TCP 看起来很成功，
 * 但连接建立后一个字节都不会有。真 SSH 服务端会立刻发 banner。
 */
function probeBanner(
  host: string,
  port: number,
  timeoutMs = SSH_BANNER_TIMEOUT
): Promise<{ ok: boolean; ms: number; banner?: string; gotBytes: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let gotBytes = 0;
    let first = '';
    let settled = false;

    const finish = (ok: boolean, error?: string, banner?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, banner, gotBytes, error });
    };

    socket.setTimeout(timeoutMs, () =>
      finish(false, gotBytes > 0 ? '数据不完整' : `连接已建立，但 ${timeoutMs}ms 内没有收到任何数据`)
    );
    socket.once('connect', () => {
      // 连上后什么都不发，等服务器先说
    });
    socket.on('data', (chunk: Buffer) => {
      gotBytes += chunk.length;
      first += chunk.toString('latin1');
      if (first.includes('\n')) {
        const line = first.split('\n')[0].trim();
        finish(true, undefined, line);
      }
    });
    socket.once('error', (e: NodeJS.ErrnoException) => finish(false, `${e.code ?? 'ERROR'}: ${e.message}`));
    socket.once('close', () => finish(false, '连接被对端关闭'));
  });
}

/** 探测本机常见代理端口 */
export async function detectLocalProxies(): Promise<DetectedProxy[]> {
  const candidates: Array<{ type: DetectedProxy['type']; host: string; port: number; source: string }> = [];

  // 1) 环境变量
  const envKeys = [
    'ALL_PROXY',
    'all_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
  ] as const;
  for (const k of envKeys) {
    const raw = process.env[k];
    if (!raw) continue;
    const parsed = parseProxyUrl(raw);
    if (!parsed) continue;
    candidates.push({ ...parsed, source: `环境变量 ${k}` });
  }

  // 2) 常见本地端口
  for (const { port, hint } of COMMON_PROXY_PORTS) {
    candidates.push({ type: 'socks5', host: '127.0.0.1', port, source: hint });
  }

  // 去重（同 host:port 只留一条，优先环境变量来源）
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 并发探测端口是否在监听
  const results = await Promise.all(
    unique.map(async (c) => {
      const r = await probeTcp(c.host, c.port, 800);
      return { ...c, reachable: r.ok };
    })
  );

  // 只留下真的在监听的；环境变量里指定的即使不通也保留（能提示用户"配了但没生效"）
  return results.filter((r) => r.reachable || r.source.startsWith('环境变量'));
}

/** 解析 http://host:port 或 socks5://host:port 形式 */
function parseProxyUrl(raw: string): { type: DetectedProxy['type']; host: string; port: number } | null {
  const text = raw.trim();
  if (!text) return null;
  const m = /^(?:(socks5|socks|http|https):\/\/)?(?:[^@/]*@)?([^:/]+)(?::(\d+))?/i.exec(text);
  if (!m) return null;
  const scheme = (m[1] ?? 'http').toLowerCase();
  const host = m[2];
  const port = m[3] ? Number(m[3]) : scheme.startsWith('socks') ? 1080 : 8080;
  if (!host || !Number.isFinite(port)) return null;
  return { type: scheme.startsWith('socks') ? 'socks5' : 'http', host, port };
}

/** 把代理配置转成给人看的短描述 */
export function describeProxy(p: ProxyConfig): string {
  if (p.type === 'none') return '直连';
  const kind = p.type === 'socks5' ? 'SOCKS5' : 'HTTP';
  const auth = p.username ? `（用户 ${p.username}）` : '';
  return `${kind} ${p.host}:${p.port}${auth}`;
}

/**
 * 完整诊断一台主机的连接链路
 */
export async function diagnose(host: HostConfig): Promise<DiagReport> {
  const steps: DiagStep[] = [];
  const suggestions: string[] = [];

  const effective = resolveProxyForHost(host);
  const usedProxy = describeProxy(effective);

  /* ---- ① 本机代理探测 ---- */
  const detected = await detectLocalProxies();
  const listening = detected.filter((d) => d.reachable);

  if (effective.type === 'none') {
    if (listening.length > 0) {
      const top = listening
        .slice(0, 4)
        .map((d) => `${d.host}:${d.port}（${d.source}）`)
        .join('、');
      steps.push({
        key: 'local-proxy',
        label: '本机代理探测',
        status: 'warn',
        detail: `当前配置为「直连」，但检测到本机有代理在运行：${top}。如果你的网络必须走代理才能出国/出网，直连会失败。`,
      });
      suggestions.push(
        `检测到本机代理在监听的端口：${top}。如果直连连不上，请到「设置 → 网络代理」把代理填上再试。`
      );
    } else {
      steps.push({
        key: 'local-proxy',
        label: '本机代理探测',
        status: 'skip',
        detail: '当前配置为「直连」，且未检测到本机代理在运行。',
      });
    }
  } else {
    const alive = detected.find(
      (d) => d.host === effective.host && d.port === effective.port && d.reachable
    );
    if (alive) {
      steps.push({
        key: 'local-proxy',
        label: '本机代理探测',
        status: 'ok',
        detail: `配置使用 ${usedProxy}，端口正在监听，可以连接。`,
      });
    } else if (effective.host === '127.0.0.1' || effective.host === 'localhost') {
      const hint = listening.length
        ? `本机实际在监听的代理端口有：${listening.map((d) => d.port).join('、')}。`
        : '本机没有扫到任何常见代理端口在监听。';
      steps.push({
        key: 'local-proxy',
        label: '本机代理探测',
        status: 'fail',
        detail: `配置使用 ${usedProxy}，但该端口没有响应。${hint}`,
      });
      suggestions.push(
        listening.length
          ? `代理端口填错了 —— 你的代理软件实际监听在 ${listening.map((d) => d.port).join(' / ')}，请改成正确的端口。`
          : '代理软件似乎没有运行。请先启动你的代理客户端（Clash / v2rayN 等），确认它已开启「允许局域网连接」以外的本地监听。'
      );
    } else {
      steps.push({
        key: 'local-proxy',
        label: '本机代理探测',
        status: 'warn',
        detail: `配置使用远程代理 ${usedProxy}，无法从本机预判其可用性，交给后续步骤验证。`,
      });
    }
  }

  /* ---- ② TCP 连通性 ---- */
  if (effective.type === 'none') {
    const tcp = await probeTcp(host.host, host.port);
    if (tcp.ok) {
      steps.push({
        key: 'tcp',
        label: 'TCP 连通性（直连）',
        status: 'ok',
        detail: `成功建立到 ${host.host}:${host.port} 的 TCP 连接，耗时 ${tcp.ms}ms。`,
        ms: tcp.ms,
      });
    } else {
      steps.push({
        key: 'tcp',
        label: 'TCP 连通性（直连）',
        status: 'fail',
        detail: `无法连接到 ${host.host}:${host.port} —— ${tcp.error}。`,
        ms: tcp.ms,
      });
      suggestions.push(
        '直连无法建立 TCP 连接。可能原因：① 该 IP/端口被本地网络或运营商拦截；② 服务器防火墙没有放行你的出口 IP；③ 服务器已关机或 IP 已变更。换一个网络（比如手机热点）再试一次可以快速区分是本地网络问题还是服务器问题。'
      );
    }
  } else {
    steps.push({
      key: 'tcp',
      label: 'TCP 连通性（直连）',
      status: 'skip',
      detail: '已启用代理，直连测试不适用 —— 由「代理隧道验证」一步实际验证。',
    });
  }

  /* ---- ③ SSH banner（直连时才有意义）---- */
  if (effective.type === 'none') {
    const banner = await probeBanner(host.host, host.port);
    if (banner.ok && banner.banner) {
      steps.push({
        key: 'banner',
        label: 'SSH 协议响应',
        status: 'ok',
        detail: `服务器返回了 SSH 标识：${banner.banner}（${banner.ms}ms）。服务端是正常工作的。`,
        ms: banner.ms,
      });
    } else if (banner.gotBytes > 0) {
      steps.push({
        key: 'banner',
        label: 'SSH 协议响应',
        status: 'warn',
        detail: `收到了 ${banner.gotBytes} 字节数据但不像标准 SSH banner，可能不是 SSH 服务。`,
      });
    } else {
      steps.push({
        key: 'banner',
        label: 'SSH 协议响应',
        status: 'fail',
        detail:
          'TCP 连接建立成功，但没有收到任何 SSH 数据。这种「能连上却完全无响应」的现象，通常意味着链路中间有设备在伪造 TCP 握手（透明代理、流量干扰），流量其实并未真正到达服务器。',
      });
      suggestions.push(
        '这是最关键的一条线索：TCP 通了却收不到 SSH 响应，说明流量没有真正抵达服务器。强烈建议启用代理后重试 —— 让 SSH 流量从代理出口走，绕过被干扰的链路。'
      );
    }
  } else {
    steps.push({
      key: 'banner',
      label: 'SSH 协议响应',
      status: 'skip',
      detail: '已启用代理，banner 将在代理隧道建立后由 SSH 自身完成握手验证。',
    });
  }

  /* ---- ④ 代理隧道验证 ---- */
  if (effective.type !== 'none') {
    const started = Date.now();
    try {
      const stream = await openProxyTunnel(effective, { host: host.host, port: host.port }, 15000);
      stream.destroy();
      const ms = Date.now() - started;
      steps.push({
        key: 'tunnel',
        label: '代理隧道验证',
        status: 'ok',
        detail: `通过 ${usedProxy} 成功打通到 ${host.host}:${host.port} 的隧道（${ms}ms）。代理工作正常。`,
        ms,
      });
    } catch (e: any) {
      const ms = Date.now() - started;
      steps.push({
        key: 'tunnel',
        label: '代理隧道验证',
        status: 'fail',
        detail: `通过 ${usedProxy} 建立隧道失败：${e?.message ?? e}`,
        ms,
      });
      suggestions.push(
        `代理隧道建立失败。请先到「设置 → 网络代理」点「测试代理」验证代理本身是否可用；如果代理本身没问题，则可能是代理规则（分流策略）没有把 ${host.host} 走代理，或代理不允许连 22 端口。`
      );
      // 代理不通的话，退一步试试直连，帮助定位到底是谁的问题
      const directTcp = await probeTcp(host.host, host.port, 6000);
      const directBanner = directTcp.ok ? await probeBanner(host.host, host.port, 4000) : null;
      steps.push({
        key: 'tunnel-fallback',
        label: '对照：直连测试',
        status: directBanner?.ok ? 'warn' : 'skip',
        detail: !directTcp.ok
          ? `直连 ${host.host}:${host.port} 也失败（${directTcp.error}）。两条路都不通，问题可能出在服务器侧或目标 IP 已失效。`
          : directBanner?.ok
            ? `直连反而能拿到 SSH 响应（${directBanner.banner}）。说明服务器没问题，是你的代理配置有问题 —— 建议把该主机设为「直连」。`
            : '直连能建立 TCP 但收不到 SSH 响应，与代理的存在与否无关。服务器侧可能存在问题。',
      });
      if (directBanner?.ok) {
        suggestions.push('对照测试显示直连可以正常握手 —— 建议在这台主机的配置里把代理改为「直连」，跳过代理。');
      }
    }
  }

  /* ---- ⑤ 认证预检 ---- */
  if (host.authType === 'privateKey') {
    if (!host.privateKeyPath) {
      steps.push({
        key: 'auth',
        label: '认证方式预检',
        status: 'fail',
        detail: '认证方式选择了「私钥文件」，但没有指定私钥路径。',
      });
      suggestions.push('请指定私钥文件路径，或改用密码认证。');
    } else {
      const fs = require('node:fs') as typeof import('node:fs');
      if (!fs.existsSync(host.privateKeyPath)) {
        steps.push({
          key: 'auth',
          label: '认证方式预检',
          status: 'fail',
          detail: `私钥文件不存在：${host.privateKeyPath}`,
        });
        suggestions.push('私钥文件路径无效，请重新选择。');
      } else {
        const text = fs.readFileSync(host.privateKeyPath, 'utf8').slice(0, 200);
        if (text.includes('PuTTY-User-Key-File')) {
          steps.push({
            key: 'auth',
            label: '认证方式预检',
            status: 'fail',
            detail: '检测到这是 PuTTY 的 .ppk 格式私钥，SSH 库不支持该格式。',
          });
          suggestions.push('请用 PuTTYgen 把 .ppk 转换成 OpenSSH 格式（Conversions → Export OpenSSH key）。');
        } else if (!/-----BEGIN[^-]*PRIVATE KEY-----/.test(text)) {
          steps.push({
            key: 'auth',
            label: '认证方式预检',
            status: 'warn',
            detail: '私钥文件内容不像标准的 PEM/OpenSSH 私钥，请确认选对了文件。',
          });
        } else {
          steps.push({
            key: 'auth',
            label: '认证方式预检',
            status: 'ok',
            detail: '私钥文件存在，格式看起来正常。',
          });
        }
      }
    }
  } else if (host.authType === 'password') {
    steps.push({
      key: 'auth',
      label: '认证方式预检',
      status: host.encryptedPassword ? 'ok' : 'fail',
      detail: host.encryptedPassword
        ? '已保存登录密码（本机加密存储）。'
        : '选择了密码认证，但没有保存密码 —— 请在主机配置里填写密码。',
    });
    if (!host.encryptedPassword) suggestions.push('请在该主机的配置里填写登录密码。');
  } else {
    steps.push({
      key: 'auth',
      label: '认证方式预检',
      status: 'skip',
      detail: '使用 SSH Agent，由系统代理完成认证。',
    });
  }

  // ---- 汇总结论 ----
  const firstFail = steps.find((s) => s.status === 'fail');
  const anyFail = !!firstFail;
  const ok = !anyFail;

  let conclusion: string;
  if (ok) {
    const warned = steps.filter((s) => s.status === 'warn').length;
    conclusion = warned
      ? '各环节检查通过，但有需要留意的地方（见上方黄色提示）。可以直接尝试连接。'
      : '各环节检查全部通过，连接链路是健康的。';
  } else {
    conclusion = `问题定位在「${firstFail!.label}」—— ${firstFail!.detail}`;
  }

  return {
    ok,
    conclusion,
    steps,
    failedAt: firstFail?.key,
    suggestions: dedupe(suggestions),
    usedProxy,
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

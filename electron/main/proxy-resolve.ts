import type { HostConfig, ProxyConfig } from '@shared/types';
import { DEFAULT_PROXY } from '@shared/presets';
import { getSettings } from './db';

/**
 * 代理配置解析
 *
 * 三层优先级（就近覆盖）：
 *   1. 主机的 proxyMode = 'direct'  -> 强制直连，忽略全局
 *   2. 主机的 proxyMode = 'custom'  -> 用主机自带的 proxy
 *   3. 主机的 proxyMode = 'global'（默认）-> 用全局 defaultProxy
 *
 * 单独拆一个文件是因为 ssh.ts 和 diagnose.ts 都要用，
 * 放在 db.ts 里会引起循环依赖（db 不依赖 ssh，但 ssh 依赖 db）。
 */
export function resolveProxyForHost(host: HostConfig): ProxyConfig {
  const mode = host.proxyMode ?? 'global';

  if (mode === 'direct') return { ...DEFAULT_PROXY, type: 'none' };

  if (mode === 'custom' && host.proxy) {
    return normalizeProxy(host.proxy);
  }

  const settings = getSettings();
  return normalizeProxy(settings.defaultProxy ?? DEFAULT_PROXY);
}

/** 补全代理配置的默认字段，避免 undefined 到处跑 */
export function normalizeProxy(p: Partial<ProxyConfig> | undefined): ProxyConfig {
  return {
    type: p?.type ?? 'none',
    host: (p?.host ?? '127.0.0.1').trim(),
    port: Number(p?.port) || 7890,
    username: p?.username?.trim() ?? '',
    encryptedPassword: p?.encryptedPassword,
    hasPassword: !!p?.encryptedPassword,
  };
}

/** 代理配置是否可用于建立连接 */
export function isProxyUsable(p: ProxyConfig): boolean {
  return p.type !== 'none' && !!p.host && !!p.port;
}

/** 给用户看的代理描述 */
export function proxyLabel(p: ProxyConfig): string {
  if (p.type === 'none') return '直连';
  const kind = p.type === 'socks5' ? 'SOCKS5' : 'HTTP';
  return `${kind} 代理 ${p.host}:${p.port}`;
}

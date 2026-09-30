import React from 'react';
import type { ProxyInput, ProxyType } from '@shared/types';
import { COMMON_PROXY_PORTS } from '@shared/presets';

/**
 * 代理配置表单（全局设置与单主机覆盖共用）
 *
 * 设计考虑：
 * - 绝大多数用户不知道自己的代理端口是哪个，所以内置「检测本机代理」一键扫描
 * - 协议类型必须显式选择 —— 选错会报出可读的错误（见 proxy.ts）
 * - 保存前可以「测试」，直接在表单里看到能不能连出去
 */

export const PROXY_TYPE_LABEL: Record<ProxyType, string> = {
  none: '不使用代理（直连）',
  socks5: 'SOCKS5',
  http: 'HTTP / HTTPS（CONNECT）',
};

export interface ProxyTestState {
  state: 'idle' | 'loading' | 'ok' | 'err';
  message: string;
}

/** 测试结果提示条 */
export function ProxyTestBanner({ result }: { result: ProxyTestState | null }) {
  if (!result || result.state === 'idle' || result.state === 'loading') return null;
  const ok = result.state === 'ok';
  return (
    <div
      style={{
        padding: '8px 11px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.7,
        wordBreak: 'break-all',
        background: ok ? 'var(--green-dim)' : 'var(--red-dim)',
        color: ok ? 'var(--green)' : 'var(--red)',
      }}
    >
      {ok ? '✓ ' : '✗ '}
      {result.message}
    </div>
  );
}

/** 本机代理检测结果提示条 */
export function DetectedPortsHint({ ports }: { ports: number[] }) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color: 'var(--green)',
        background: 'var(--green-dim)',
        padding: '7px 10px',
        borderRadius: 6,
        lineHeight: 1.8,
      }}
    >
      检测到本机监听的端口：{ports.join('、')}
    </div>
  );
}

/**
 * 端口输入 + 常见端口快选
 */
export function ProxyPortInput({
  port,
  onChange,
}: {
  port: number | string;
  onChange: (v: string) => void;
}) {
  return (
    <>
      <input
        value={port}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        placeholder="7890"
        className="mono"
      />
      <div className="row gap-4" style={{ flexWrap: 'wrap', marginTop: 5 }} title="点击填入常见端口">
        {COMMON_PROXY_PORTS.slice(0, 6).map((p) => (
          <button
            key={p.port}
            type="button"
            className="btn btn-xs btn-ghost"
            onClick={() => onChange(String(p.port))}
            title={p.hint}
            style={{ fontSize: 10.5, padding: '1px 6px' }}
          >
            {p.port}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 完整代理配置表单（用于设置页）
 */
export function ProxyForm({
  value,
  onChange,
  hasSavedPassword,
  onTest,
  testing,
  testResult,
  onDetect,
  detecting,
  detectedPorts,
}: {
  value: ProxyInput;
  onChange: (patch: Partial<ProxyInput>) => void;
  hasSavedPassword?: boolean;
  onTest?: () => void;
  testing?: boolean;
  testResult?: ProxyTestState | null;
  onDetect?: () => void;
  detecting?: boolean;
  detectedPorts?: number[];
}) {
  const enabled = value.type !== 'none';

  return (
    <>
      <div className="field">
        <label className="field-label">代理类型</label>
        <div className="row gap-8">
          {(['none', 'socks5', 'http'] as ProxyType[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`btn ${value.type === t ? 'btn-accent' : ''}`}
              onClick={() => onChange({ type: t })}
              style={{ flex: 1, fontSize: 12 }}
            >
              {t === 'none' ? '不使用' : t === 'socks5' ? 'SOCKS5' : 'HTTP'}
            </button>
          ))}
        </div>
        <div className="field-hint">
          不确定选哪个？Clash / v2rayN 的「混合端口」通常是 HTTP，单独的 socks 端口选 SOCKS5。
          选错会直接报出可读的错误提示，不会静默失败。
        </div>
      </div>

      {enabled && (
        <>
          <div className="field-row">
            <div className="field" style={{ flex: 3 }}>
              <label className="field-label">代理地址</label>
              <input
                value={value.host}
                onChange={(e) => onChange({ host: e.target.value })}
                placeholder="127.0.0.1"
                className="mono"
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">端口</label>
              <ProxyPortInput port={value.port} onChange={(v) => onChange({ port: Number(v) || 0 })} />
            </div>
          </div>

          <div className="field">
            <label className="field-label">代理用户名（可选）</label>
            <input
              value={value.username ?? ''}
              onChange={(e) => onChange({ username: e.target.value })}
              placeholder="代理不需要认证则留空"
              className="mono"
            />
          </div>

          {value.username ? (
            <div className="field">
              <label className="field-label">代理密码{hasSavedPassword ? '（留空则不修改）' : ''}</label>
              <input
                type="password"
                value={value.password ?? ''}
                onChange={(e) => onChange({ password: e.target.value })}
                placeholder={hasSavedPassword ? '已保存，留空则不修改' : '输入代理密码'}
                className="mono"
              />
            </div>
          ) : (
            <div className="field">
              <label className="field-label">代理密码（可选）</label>
              <input
                type="password"
                value={value.password ?? ''}
                onChange={(e) => onChange({ password: e.target.value, username: value.username || '' })}
                placeholder="填写后自动启用认证"
                className="mono"
              />
              <div className="field-hint">如果代理需要认证，请同时填写用户名；只填密码不会生效。</div>
            </div>
          )}

          <div className="row gap-8" style={{ marginBottom: 6 }}>
            {onTest && (
              <button type="button" className="btn btn-sm" onClick={onTest} disabled={testing}>
                {testing && <span className="spinner" />}
                测试代理
              </button>
            )}
            {onDetect && (
              <button type="button" className="btn btn-sm" onClick={onDetect} disabled={detecting}>
                {detecting && <span className="spinner" />}
                {detecting ? '扫描中…' : '检测本机代理'}
              </button>
            )}
          </div>

          {detectedPorts && detectedPorts.length > 0 && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--green)',
                background: 'var(--green-dim)',
                padding: '7px 10px',
                borderRadius: 6,
                lineHeight: 1.8,
                marginBottom: 10,
              }}
            >
              检测到本机正在监听的代理端口：{detectedPorts.join('、')} —— 点上方端口快捷键即可填入。
            </div>
          )}
          {detectedPorts && detectedPorts.length === 0 && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--yellow)',
                background: 'var(--yellow-dim)',
                padding: '7px 10px',
                borderRadius: 6,
                lineHeight: 1.8,
                marginBottom: 10,
              }}
            >
              没有检测到本机有代理在运行。请先启动你的代理客户端（Clash / v2rayN / Shadowsocks 等）。
            </div>
          )}

          <ProxyTestBanner result={testResult ?? null} />
        </>
      )}
    </>
  );
}

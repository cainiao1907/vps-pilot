import React from 'react';
import type { HostConfig, HostInput, AuthType, ProxyMode, ProxyType, ProxyInput } from '@shared/types';
import { Modal, StatusDot, hostLabel } from './ui';
import { ProxyForm, ProxyTestBanner, type ProxyTestState } from './ProxyForm';

/**
 * 主机编辑对话框
 */
export function HostEditor({
  host,
  hosts,
  onClose,
  onSaved,
}: {
  host?: HostConfig;
  hosts: HostConfig[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!host;
  const [form, setForm] = React.useState<HostInput>({
    id: host?.id,
    name: host?.name ?? '',
    host: host?.host ?? '',
    port: host?.port ?? 22,
    username: host?.username ?? 'root',
    authType: host?.authType ?? 'password',
    password: '',
    privateKeyPath: host?.privateKeyPath ?? '',
    passphrase: '',
    jumpHostId: host?.jumpHostId ?? '',
    proxyMode: host?.proxyMode ?? 'global',
    proxy: host?.proxy
      ? {
          type: host.proxy.type,
          host: host.proxy.host,
          port: host.proxy.port,
          username: host.proxy.username ?? '',
          password: '',
        }
      : { type: 'socks5', host: '127.0.0.1', port: 7890, username: '', password: '' },
    note: host?.note ?? '',
    defaultCwd: host?.defaultCwd ?? '',
  });
  const [hasSaved, setHasSaved] = React.useState({ password: false, passphrase: false });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  // 全局默认代理的描述，用于「跟随全局」的提示
  const [globalProxyText, setGlobalProxyText] = React.useState('直连');
  const [proxyTest, setProxyTest] = React.useState<ProxyTestState | null>(null);
  const [proxyTesting, setProxyTesting] = React.useState(false);
  const [detecting, setDetecting] = React.useState(false);
  const [detectedPorts, setDetectedPorts] = React.useState<number[] | undefined>(undefined);

  React.useEffect(() => {
    if (host) {
      window.vps.hostHasCredential(host.id).then((r: any) => {
        if (r?.ok) setHasSaved(r.data);
      });
    }
    window.vps.getProxy().then((r: any) => {
      if (!r?.ok) return;
      const p = r.data;
      setGlobalProxyText(
        p.type === 'none'
          ? '直连（未启用代理）'
          : `${p.type === 'socks5' ? 'SOCKS5' : 'HTTP'} ${p.host}:${p.port}`
      );
    });
  }, [host?.id]);

  const set = (k: keyof HostInput, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const setProxy = (p: Partial<ProxyInput>) =>
    setForm((f) => ({ ...f, proxy: { ...(f.proxy as ProxyInput), ...p } }));

  const testProxyDraft = async () => {
    setProxyTesting(true);
    setProxyTest(null);
    const r: any = await window.vps.testProxy(form.proxy);
    setProxyTesting(false);
    if (r.ok) setProxyTest({ state: r.data.ok ? 'ok' : 'err', message: r.data.message });
    else setProxyTest({ state: 'err', message: r.error ?? '测试失败' });
  };

  const detectProxy = async () => {
    setDetecting(true);
    const r: any = await window.vps.detectProxy();
    setDetecting(false);
    if (r.ok) {
      const list = (r.data as any[]).filter((d) => d.reachable);
      setDetectedPorts(list.map((d) => d.port));
      // 只扫到一个就直接填进去，省一次点击
      if (list.length === 1) {
        setProxy({ type: list[0].type, host: list[0].host, port: list[0].port });
      }
    }
  };

  const save = async () => {
    setError('');
    if (!form.host.trim()) return setError('请填写服务器地址');
    if (!form.username.trim()) return setError('请填写登录用户名');
    if (form.authType === 'password' && !form.password && !hasSaved.password && !isEdit) {
      return setError('请填写密码');
    }
    if (form.authType === 'privateKey' && !form.privateKeyPath?.trim()) {
      return setError('请选择私钥文件');
    }
    if (form.proxyMode === 'custom' && form.proxy?.type !== 'none' && !form.proxy?.host?.trim()) {
      return setError('请填写代理地址，或把代理改为「跟随全局设置」');
    }
    setSaving(true);
    const r: any = await window.vps.saveHost({
      ...form,
      name: form.name.trim() || form.host.trim(),
      port: Number(form.port) || 22,
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? '保存失败');
      return;
    }
    onSaved();
    onClose();
  };

  const pickKey = async () => {
    const r: any = await window.vps.pickKeyFile();
    if (r?.ok && r.data && !r.data.canceled) set('privateKeyPath', r.data.path);
  };

  const otherHosts = hosts.filter((h) => h.id !== host?.id);

  return (
    <Modal
      title={isEdit ? `编辑主机 · ${host!.name}` : '添加主机'}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving && <span className="spinner" />}
            {isEdit ? '保存修改' : '添加主机'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">别名 *</label>
        <input
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="例如：生产环境-Web-01"
          autoFocus
        />
        <div className="field-hint">给自己看的名字，方便在列表里识别</div>
      </div>

      <div className="field-row">
        <div className="field" style={{ flex: 3 }}>
          <label className="field-label">服务器地址 *</label>
          <input
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder="IP 或域名，如 1.2.3.4 或 vps.example.com"
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">端口</label>
          <input
            value={form.port}
            onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))}
            placeholder="22"
          />
        </div>
      </div>

      <div className="field">
        <label className="field-label">登录用户名 *</label>
        <input value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="root" />
      </div>

      <div className="field">
        <label className="field-label">认证方式</label>
        <div className="row gap-8">
          {(
            [
              ['password', '密码'],
              ['privateKey', '私钥文件'],
              ['agent', 'SSH Agent'],
            ] as [AuthType, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`btn ${form.authType === v ? 'btn-accent' : ''}`}
              onClick={() => set('authType', v)}
              style={{ flex: 1 }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {form.authType === 'password' && (
        <div className="field">
          <label className="field-label">密码</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            placeholder={hasSaved.password && isEdit ? '已保存，留空则不修改' : '输入登录密码'}
          />
          <div className="field-hint">
            密码使用系统级加密（Windows DPAPI / macOS Keychain）保存在本地，不会上传到任何服务器
          </div>
        </div>
      )}

      {form.authType === 'privateKey' && (
        <>
          <div className="field">
            <label className="field-label">私钥文件路径 *</label>
            <div className="row gap-8">
              <input
                value={form.privateKeyPath}
                onChange={(e) => set('privateKeyPath', e.target.value)}
                placeholder="C:\Users\you\.ssh\id_rsa"
              />
              <button className="btn" onClick={pickKey} style={{ flexShrink: 0 }}>
                浏览…
              </button>
            </div>
            <div className="field-hint">支持 OpenSSH 格式私钥。PuTTY 的 .ppk 需先转换</div>
          </div>
          <div className="field">
            <label className="field-label">私钥口令（可选）</label>
            <input
              type="password"
              value={form.passphrase}
              onChange={(e) => set('passphrase', e.target.value)}
              placeholder={hasSaved.passphrase && isEdit ? '已保存，留空则不修改' : '私钥没有口令则留空'}
            />
          </div>
        </>
      )}

      {form.authType === 'agent' && (
        <div className="field">
          <div className="card" style={{ fontSize: 12, color: 'var(--text-2)' }}>
            将使用系统 SSH Agent 中已加载的密钥。请确认 <code className="mono">SSH_AUTH_SOCK</code> 环境变量
            已正确设置。
          </div>
        </div>
      )}

      <div className="field">
        <label className="field-label">通过跳板机连接（可选）</label>
        <select value={form.jumpHostId} onChange={(e) => set('jumpHostId', e.target.value)}>
          <option value="">直连（不使用跳板机）</option>
          {otherHosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name} — {hostLabel(h)}
            </option>
          ))}
        </select>
        <div className="field-hint">适用于内网机器：先连跳板机，再由跳板机转发到目标主机</div>
      </div>

      {/* ---- 代理 ---- */}
      <div
        className="field"
        style={{
          borderTop: '1px solid var(--border)',
          paddingTop: 14,
          marginTop: 4,
        }}
      >
        <label className="field-label">网络代理</label>
        <div className="row gap-8" style={{ marginBottom: 6 }}>
          {(
            [
              ['global', `跟随全局设置`],
              ['direct', '强制直连'],
              ['custom', '单独配置'],
            ] as [ProxyMode, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`btn ${form.proxyMode === v ? 'btn-accent' : ''}`}
              onClick={() => set('proxyMode', v)}
              style={{ flex: 1, fontSize: 12 }}
            >
              {label}
            </button>
          ))}
        </div>

        {form.proxyMode === 'global' && (
          <div className="field-hint">
            当前全局代理：<code className="mono">{globalProxyText}</code>
            。可在「设置 → 网络代理」里修改。
          </div>
        )}

        {form.proxyMode === 'direct' && (
          <div className="field-hint">
            这台主机的 SSH 流量不走代理，直接连接。适用于服务器在国内、或走代理反而更慢的情况。
          </div>
        )}

        {form.proxyMode === 'custom' && (
          <div style={{ marginTop: 8 }}>
            <ProxyForm
              value={form.proxy as ProxyInput}
              onChange={setProxy}
              hasSavedPassword={!!host?.proxy?.encryptedPassword}
              onTest={testProxyDraft}
              testing={proxyTesting}
              testResult={proxyTest}
              onDetect={detectProxy}
              detecting={detecting}
              detectedPorts={detectedPorts}
            />
          </div>
        )}
      </div>

      <div className="field">
        <label className="field-label">默认工作目录（可选）</label>
        <input
          value={form.defaultCwd}
          onChange={(e) => set('defaultCwd', e.target.value)}
          placeholder="/www/wwwroot/myapp"
        />
        <div className="field-hint">终端打开和 Agent 执行命令时的起始目录</div>
      </div>

      <div className="field">
        <label className="field-label">备注（可选）</label>
        <textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="这台机器是干什么的" />
      </div>

      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}

/**
 * 主机列表
 */
export function HostList({
  hosts,
  connected,
  activeHostId,
  onSelect,
  onConnect,
  onEdit,
  onDelete,
  onAdd,
}: {
  hosts: HostConfig[];
  connected: Record<string, string>;
  activeHostId: string | null;
  onSelect: (h: HostConfig) => void;
  onConnect: (h: HostConfig) => void;
  onEdit: (h: HostConfig) => void;
  onDelete: (h: HostConfig) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const filtered = hosts.filter(
    (h) =>
      !query ||
      h.name.toLowerCase().includes(query.toLowerCase()) ||
      h.host.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="col" style={{ height: '100%' }}>
      <div style={{ padding: '12px 12px 8px', display: 'flex', gap: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索主机…"
          style={{ fontSize: 12.5 }}
        />
        <button className="btn btn-accent" onClick={onAdd} style={{ flexShrink: 0 }} title="添加主机">
          + 添加
        </button>
      </div>

      <div className="scroll-panel" style={{ padding: '0 8px 12px' }}>
        {filtered.length === 0 && (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
            {hosts.length === 0 ? (
              <>
                <div style={{ marginBottom: 10 }}>还没有添加任何服务器</div>
                <button className="btn btn-primary btn-sm" onClick={onAdd}>
                  添加第一台 VPS
                </button>
              </>
            ) : (
              '没有匹配的主机'
            )}
          </div>
        )}

        {filtered.map((h) => {
          const st = connected[h.id] ?? 'disconnected';
          const active = h.id === activeHostId;
          return (
            <div
              key={h.id}
              className={`host-item ${active ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(h)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(h);
                }
              }}
            >
              <div className="row gap-6" style={{ marginBottom: 2 }}>
                <StatusDot status={st} />
                <div className="truncate" style={{ fontWeight: 600, fontSize: 12.5, flex: 1 }}>
                  {h.name}
                </div>
              </div>
              <div className="truncate mono dim" style={{ fontSize: 11, paddingLeft: 13 }}>
                {hostLabel(h)}
              </div>
              {/* 操作行：默认隐藏，hover / 键盘聚焦时才出现。
                  好处是列表本身非常干净（一眼能扫完所有主机），
                  而操作按钮出现在鼠标已经停住的位置，符合 Fitts 定律。 */}
              <div className="host-item-actions">
                <button
                  className={`btn btn-xs ${st === 'connected' ? 'btn-connected' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConnect(h);
                  }}
                  disabled={st === 'connecting'}
                >
                  {st === 'connecting' ? '连接中…' : st === 'connected' ? '已连接' : '连接'}
                </button>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(h);
                  }}
                >
                  编辑
                </button>
                <button
                  className="btn btn-ghost btn-xs btn-danger-ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(h);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

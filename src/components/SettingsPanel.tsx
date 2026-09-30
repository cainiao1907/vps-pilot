import React from 'react';
import type { ModelInput, ProxyInput, ProxyType, DetectedProxy, DiagReport } from '@shared/types';
import { Modal, Empty } from './ui';
import { ProxyForm, ProxyTestBanner, type ProxyTestState } from './ProxyForm';
import { refreshModels, refreshSettings, getState, useStore, gotoSubNav } from '../store';

/**
 * 设置面板：模型配置（BYOK）+ 网络代理 + 通用设置 + 关于
 *
 * 信息架构说明：专家 / 技能已经从这里挪到左侧一级导航的「专家库」分组下。
 * 原因是它们的配置频率远低于模型与代理，却占据设置页顶部两个最显眼的标签位，
 * 把真正需要频繁改的模型配置挤到了后面。现在设置页只留「跟本机行为有关」的项，
 * 专家 / 技能作为「内容资产」独立成组，语义上也更清楚。
 *
 * 子页切换通过 store 的 subNav 驱动（不是组件内 state），
 * 这样左侧二级导航和这里的内容是同一份真相，不会出现侧栏高亮和实际页面对不上。
 */

const SETTINGS_TABS: { key: string; label: string; hint: string }[] = [
  { key: 'models', label: '模型配置', hint: '接入用于规划与总结的 LLM' },
  { key: 'proxy', label: '网络代理', hint: '让连接绕开被干扰的链路' },
  { key: 'mcp', label: 'MCP 服务', hint: '让本地 Agent（WorkBuddy / 豆包 / ZCode / Kimi）接管终端' },
  { key: 'general', label: '通用设置', hint: '审批模式、审计保留、默认行为' },
  { key: 'about', label: '关于', hint: '版本与技术说明' },
];

export function SettingsPanel() {
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const subNav = useStore((s) => s.subNav);
  const tab = SETTINGS_TABS.some((t) => t.key === subNav) ? subNav : 'models';
  const [editing, setEditing] = React.useState<any | null>(null);

  return (
    <div className="col panel" style={{ height: '100%' }}>
      <div className="panel-head">
        <div>
          <div className="panel-title">设置</div>
          <div className="panel-sub">
            {SETTINGS_TABS.find((t) => t.key === tab)?.hint}
          </div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => gotoSubNav(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* scroll-panel：滚轮只作用在这一层，不会穿透到背后的终端 */}
      <div className="scroll-panel" style={{ padding: 20 }}>
        {tab === 'models' && <ModelsTab models={models} settings={settings} onEdit={setEditing} />}
        {tab === 'proxy' && <ProxyTab settings={settings} />}
        {tab === 'mcp' && <McpTab settings={settings} />}
        {tab === 'general' && <GeneralTab settings={settings} />}
        {tab === 'about' && <AboutTab />}
      </div>

      {editing && (
        <ModelEditor
          model={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refreshModels();
            refreshSettings();
          }}
        />
      )}
    </div>
  );
}

/* ============ 网络代理 ============ */

function ProxyTab({ settings }: any) {
  const saved = settings.defaultProxy ?? { type: 'none', host: '127.0.0.1', port: 7890 };
  const [draft, setDraft] = React.useState<ProxyInput>({
    type: (saved.type ?? 'none') as ProxyType,
    host: saved.host ?? '127.0.0.1',
    port: saved.port ?? 7890,
    username: saved.username ?? '',
    password: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [savedOk, setSavedOk] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<ProxyTestState | null>(null);
  const [detecting, setDetecting] = React.useState(false);
  const [detected, setDetected] = React.useState<DetectedProxy[] | null>(null);
  const [diag, setDiag] = React.useState<{ running: boolean; report: DiagReport | null }>({
    running: false,
    report: null,
  });

  // 外部设置变化时同步（例如打开设置页时）
  React.useEffect(() => {
    setDraft({
      type: (saved.type ?? 'none') as ProxyType,
      host: saved.host ?? '127.0.0.1',
      port: saved.port ?? 7890,
      username: saved.username ?? '',
      password: '',
    });
  }, [saved.type, saved.host, saved.port, saved.username]);

  const patch = (p: Partial<ProxyInput>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    setSaving(true);
    setSavedOk(false);
    await window.vps.saveProxy(draft);
    await refreshSettings();
    setSaving(false);
    setSavedOk(true);
    setTimeout(() => setSavedOk(false), 1800);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const r: any = await window.vps.testProxy(draft);
    setTesting(false);
    if (r.ok) {
      const d = r.data;
      setTestResult({ state: d.ok ? 'ok' : 'err', message: d.message });
    } else {
      setTestResult({ state: 'err', message: r.error ?? '测试失败' });
    }
  };

  const detect = async () => {
    setDetecting(true);
    const r: any = await window.vps.detectProxy();
    setDetecting(false);
    if (r.ok) setDetected(r.data as DetectedProxy[]);
  };

  const runDiag = async () => {
    const hosts = getState().hosts;
    if (!hosts.length) return;
    setDiag({ running: true, report: null });
    const r: any = await window.vps.diagnose(hosts[0].id);
    setDiag({ running: false, report: r.ok ? (r.data as DiagReport) : null });
  };

  const detectedPorts = detected ? detected.filter((d) => d.reachable).map((d) => d.port) : undefined;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="flex-1">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>网络代理</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            如果你本机需要通过代理才能访问外网，在这里配置后，所有 SSH 连接都会走这条代理。
            <br />
            典型症状：能 ping 通服务器、TCP 也能连上，但 SSH 握手拿不到响应 —— 这种情况下启用代理通常能直接解决。
          </div>
        </div>
        {savedOk && <span style={{ fontSize: 12, color: 'var(--green)', flexShrink: 0 }}>✓ 已保存</span>}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <ProxyForm
          value={draft}
          onChange={patch}
          hasSavedPassword={!!saved.hasPassword}
          onTest={test}
          testing={testing}
          testResult={testResult}
          onDetect={detect}
          detecting={detecting}
          detectedPorts={detectedPorts}
        />

        {detected && detected.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 6 }}>扫描到的代理服务：</div>
            <div style={{ display: 'grid', gap: 5 }}>
              {detected.map((d, i) => (
                <div
                  key={`${d.host}:${d.port}:${i}`}
                  className="row gap-8"
                  style={{
                    fontSize: 11.5,
                    padding: '5px 9px',
                    borderRadius: 5,
                    background: 'var(--bg-3)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: d.reachable ? 'var(--green)' : 'var(--text-3)',
                    }}
                  />
                  <span className="mono">
                    {d.type === 'socks5' ? 'SOCKS5' : 'HTTP'} {d.host}:{d.port}
                  </span>
                  <span className="dim flex-1 truncate">{d.source}</span>
                  <button
                    className="btn btn-xs btn-ghost"
                    onClick={() => patch({ type: d.type, host: d.host, port: d.port })}
                  >
                    使用
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="row gap-8" style={{ marginTop: 14 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving && <span className="spinner" />}
            保存代理设置
          </button>
          <button className="btn" onClick={runDiag} disabled={diag.running}>
            {diag.running && <span className="spinner" />}
            {diag.running ? '诊断中…' : '一键诊断首台主机'}
          </button>
        </div>
      </div>

      {diag.report && (
        <div className="card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>诊断结果</div>
          <DiagReportView report={diag.report} />
        </div>
      )}

      <div className="card">
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>怎么知道该填什么？</div>
        <ul style={{ fontSize: 12, lineHeight: 1.95, color: 'var(--text-2)', paddingLeft: 18, margin: 0 }}>
          <li>
            打开你的代理软件，找到「端口」或「Port」设置项 —— 那里显示的端口号就是你要填的。
          </li>
          <li>点上方「检测本机代理」，会自动扫描常见端口（Clash 7890、v2rayN 10808、SS 1080 等）。</li>
          <li>
            协议不确定时：Clash 的「混合端口 / Mixed Port」当作 HTTP 或 SOCKS5 都能用；
            v2rayN 的 socks 端口选 SOCKS5。
          </li>
          <li>单台主机想绕过代理，可以在那台主机的编辑窗口里选「强制直连」。</li>
        </ul>
      </div>
    </>
  );
}

/* ============ 诊断报告（设置页与主机概览共用） ============ */

const DIAG_ICON: Record<string, { icon: string; color: string }> = {
  ok: { icon: '✓', color: 'var(--green)' },
  fail: { icon: '✗', color: 'var(--red)' },
  warn: { icon: '!', color: 'var(--yellow)' },
  skip: { icon: '–', color: 'var(--text-3)' },
};

export function DiagReportView({ report }: { report: DiagReport }) {
  return (
    <>
      <div
        className="row gap-8"
        style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8 }}
      >
        <span>
          实际使用：<code className="mono">{report.usedProxy}</code>
        </span>
      </div>

      <div
        style={{
          padding: '9px 12px',
          borderRadius: 6,
          fontSize: 12.5,
          lineHeight: 1.75,
          marginBottom: 12,
          background: report.ok ? 'var(--green-dim)' : 'var(--red-dim)',
          color: report.ok ? 'var(--green)' : 'var(--red)',
        }}
      >
        {report.conclusion}
      </div>

      <div style={{ display: 'grid', gap: 7, marginBottom: 12 }}>
        {report.steps.map((s, i) => {
          const meta = DIAG_ICON[s.status] ?? DIAG_ICON.skip;
          return (
            <div
              key={`${s.key}:${i}`}
              style={{
                display: 'flex',
                gap: 9,
                padding: '8px 11px',
                borderRadius: 6,
                background: 'var(--bg-3)',
                border: '1px solid var(--border)',
                borderLeft: `3px solid ${meta.color}`,
              }}
            >
              <span style={{ color: meta.color, fontWeight: 700, fontSize: 12.5, flexShrink: 0, width: 12 }}>
                {meta.icon}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row gap-8" style={{ marginBottom: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.label}</span>
                  {s.ms !== undefined && (
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                      {s.ms}ms
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.75, wordBreak: 'break-word' }}>
                  {s.detail}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {report.suggestions.length > 0 && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 6,
            background: 'var(--yellow-dim)',
            fontSize: 12,
            lineHeight: 1.85,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--yellow)', marginBottom: 6 }}>建议怎么做</div>
          <ol style={{ paddingLeft: 18, margin: 0, color: 'var(--text-1)' }}>
            {report.suggestions.map((t, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {t}
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

/* ============ 模型列表 ============ */

function ModelsTab({ models, settings, onEdit }: any) {
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="flex-1">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>模型配置</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            Agent 需要调用一个大模型来理解需求、生成执行计划和分析结果。
            <br />
            支持任意 OpenAI 兼容接口 —— 云端 API 或本地 Ollama 都可以。API Key 只保存在你本机。
          </div>
        </div>
        <button className="btn btn-accent" onClick={() => onEdit('new')}>
          + 添加模型
        </button>
      </div>

      {models.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 30, opacity: 0.3, marginBottom: 10 }}>🤖</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>还没有配置模型</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
            至少添加一个模型后，Agent 才能工作
          </div>
          <button className="btn btn-primary" onClick={() => onEdit('new')}>
            添加第一个模型
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {models.map((m: any) => {
          const active = settings.activeModelId === m.id;
          return (
            <div
              key={m.id}
              className="card"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                borderColor: active ? 'var(--accent)' : 'var(--border)',
                background: active ? 'var(--accent-dim)' : 'var(--bg-2)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row gap-8" style={{ marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</span>
                  {active && (
                    <span
                      className="badge"
                      style={{ background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10 }}
                    >
                      当前使用
                    </span>
                  )}
                  {!m.hasApiKey && m.providerId !== 'ollama' && (
                    <span
                      className="badge"
                      style={{ background: 'var(--yellow-dim)', color: 'var(--yellow)', fontSize: 10 }}
                    >
                      缺少 API Key
                    </span>
                  )}
                </div>
                <div className="mono truncate" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {m.model} · {m.baseUrl}
                </div>
              </div>
              <div className="row gap-6" style={{ flexShrink: 0 }}>
                {!active && (
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      await window.vps.setSettings({ activeModelId: m.id });
                      refreshSettings();
                    }}
                  >
                    设为当前
                  </button>
                )}
                <ModelTestButton id={m.id} />
                <button className="btn btn-sm" onClick={() => onEdit(m)}>
                  编辑
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ color: 'var(--red)' }}
                  onClick={async () => {
                    if (!confirm(`删除模型「${m.label}」？`)) return;
                    await window.vps.deleteModel(m.id);
                    refreshModels();
                    refreshSettings();
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ModelTestButton({ id }: { id: string }) {
  const [state, setState] = React.useState<'idle' | 'loading' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = React.useState('');
  return (
    <>
      <button
        className="btn btn-sm"
        disabled={state === 'loading'}
        onClick={async () => {
          setState('loading');
          setMsg('');
          const r: any = await window.vps.testModel(id);
          if (r.ok && r.data.ok) {
            setState('ok');
            setMsg(r.data.reply ?? 'OK');
            setTimeout(() => setState('idle'), 3000);
          } else {
            setState('err');
            setMsg(r.data?.error ?? r.error ?? '测试失败');
          }
        }}
        title={msg || '测试连通性'}
        style={
          state === 'ok'
            ? { borderColor: 'var(--green)', color: 'var(--green)' }
            : state === 'err'
              ? { borderColor: 'var(--red)', color: 'var(--red)' }
              : undefined
        }
      >
        {state === 'loading' ? <span className="spinner" /> : state === 'ok' ? '✓ 可用' : state === 'err' ? '✗ 失败' : '测试'}
      </button>
      {state === 'err' && msg && (
        <span style={{ fontSize: 11, color: 'var(--red)', maxWidth: 260 }} className="truncate" title={msg}>
          {msg}
        </span>
      )}
    </>
  );
}

/* ============ 模型编辑 ============ */

function ModelEditor({
  model,
  onClose,
  onSaved,
}: {
  model?: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [presets, setPresets] = React.useState<any[]>([]);
  const [form, setForm] = React.useState<ModelInput>({
    id: model?.id,
    label: model?.label ?? '',
    providerId: model?.providerId ?? 'deepseek',
    baseUrl: model?.baseUrl ?? 'https://api.deepseek.com/v1',
    model: model?.model ?? 'deepseek-chat',
    apiKey: '',
    temperature: 0.2,
    maxTokens: 4096,
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ ok: boolean; msg: string } | null>(null);

  React.useEffect(() => {
    window.vps.appInfo().then((r: any) => {
      if (r.ok) setPresets(r.data.presets);
    });
  }, []);

  const set = (k: keyof ModelInput, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const pickPreset = (pid: string) => {
    const p = presets.find((x) => x.id === pid);
    setForm((f) => ({
      ...f,
      providerId: pid,
      baseUrl: p?.baseUrl ?? f.baseUrl,
      model: p?.defaultModel ?? f.model,
      label: f.label || p?.label || '',
    }));
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const r: any = await window.vps.testModelDraft(form);
    setTesting(false);
    if (r.ok && r.data.ok) setTestResult({ ok: true, msg: `连通成功，模型回复：${r.data.reply}` });
    else setTestResult({ ok: false, msg: r.data?.error ?? r.error ?? '测试失败' });
  };

  const save = async () => {
    setError('');
    if (!form.label.trim()) return setError('请填写显示名称');
    if (!form.baseUrl.trim()) return setError('请填写 API 地址');
    if (!form.model.trim()) return setError('请填写模型名称');
    setSaving(true);
    const r: any = await window.vps.saveModel(form);
    setSaving(false);
    if (!r.ok) return setError(r.error ?? '保存失败');
    onSaved();
    onClose();
  };

  const currentPreset = presets.find((p) => p.id === form.providerId);

  return (
    <Modal
      title={model ? `编辑模型 · ${model.label}` : '添加模型'}
      onClose={onClose}
      width={580}
      footer={
        <>
          <button className="btn" onClick={test} disabled={testing}>
            {testing && <span className="spinner" />}
            测试连接
          </button>
          <div className="flex-1" />
          <button className="btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving && <span className="spinner" />}
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">服务商</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {presets.map((p) => (
            <button
              key={p.id}
              className={`btn ${form.providerId === p.id ? 'btn-accent' : ''}`}
              onClick={() => pickPreset(p.id)}
              style={{ justifyContent: 'flex-start' }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label">显示名称 *</label>
        <input
          value={form.label}
          onChange={(e) => set('label', e.target.value)}
          placeholder="例如：DeepSeek 日常"
        />
      </div>

      <div className="field">
        <label className="field-label">API 地址（Base URL）*</label>
        <input
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder="https://api.deepseek.com/v1"
          className="mono"
        />
        <div className="field-hint">需兼容 OpenAI 的 /chat/completions 接口，末尾一般带 /v1</div>
      </div>

      <div className="field">
        <label className="field-label">模型名称 *</label>
        <input
          value={form.model}
          onChange={(e) => set('model', e.target.value)}
          placeholder="deepseek-chat"
          className="mono"
        />
      </div>

      {currentPreset?.needsKey !== false && (
        <div className="field">
          <label className="field-label">API Key {model ? '（留空则不修改）' : '*'}</label>
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => set('apiKey', e.target.value)}
            placeholder="sk-..."
            className="mono"
          />
          <div className="field-hint">
            使用系统级加密保存在本机，不会发送到除该模型服务商外的任何地方
          </div>
        </div>
      )}

      <div className="field-row">
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">Temperature</label>
          <input
            value={form.temperature}
            onChange={(e) => set('temperature', parseFloat(e.target.value) || 0)}
            placeholder="0.2"
          />
          <div className="field-hint">运维场景建议 0~0.3</div>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">最大输出 Token</label>
          <input
            value={form.maxTokens}
            onChange={(e) => set('maxTokens', parseInt(e.target.value) || 4096)}
            placeholder="4096"
          />
        </div>
      </div>

      {testResult && (
        <div
          style={{
            padding: '8px 11px',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.65,
            background: testResult.ok ? 'var(--green-dim)' : 'var(--red-dim)',
            color: testResult.ok ? 'var(--green)' : 'var(--red)',
            wordBreak: 'break-all',
          }}
        >
          {testResult.msg}
        </div>
      )}

      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}

/* ============ 通用设置 ============ */

/* ============ MCP 服务 ============ */

/**
 * MCP 服务配置
 *
 * 这一页只做一件事：把「本软件作为 MCP 工具提供方」这个能力开出来，
 * 并让用户看得见它的运行状态、拿到能直接粘贴的客户端配置。
 *
 * 设计取舍：
 * - 默认关闭。这个开关等于「允许本机其他程序远程操作我的服务器终端」，
 *   属于高敏感能力，不能默认打开。
 * - 审批策略与权限开关并列展示，让用户一眼看清「外部 Agent 到底能做什么」。
 * - 配置片段按客户端分块，每块一个复制按钮 —— 用户不需要去翻文档。
 */
function McpTab({ settings }: any) {
  const mcp = settings?.mcp ?? {};
  const [local, setLocal] = React.useState<any>(mcp);
  const [status, setStatus] = React.useState<any>(null);
  const [snippets, setSnippets] = React.useState<any[]>([]);
  const [tools, setTools] = React.useState<any[]>([]);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [showToken, setShowToken] = React.useState(false);

  React.useEffect(() => setLocal(mcp), [settings?.mcp]);

  const reload = React.useCallback(async () => {
    try {
      const r = await window.vps.mcpStatus();
      setStatus(r?.status ?? null);
      const s = await window.vps.mcpSnippets();
      setSnippets(Array.isArray(s) ? s : []);
      const t = await window.vps.mcpTools();
      setTools(Array.isArray(t) ? t : []);
    } catch {
      /* 主进程未就绪时静默 */
    }
  }, []);

  React.useEffect(() => {
    void reload();
    const off = window.vps.onMcpEvent?.(() => void reload());
    return () => off?.();
  }, [reload]);

  const update = async (patchInput: Record<string, unknown>) => {
    const next = { ...local, ...patchInput };
    setLocal(next);
    // mcp 是嵌套对象，主进程会做深合并，这里整体提交即可
    await window.vps.setSettings({ mcp: next });
    await refreshSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    // 开关/端口/Token 变化会触发主进程热重载，稍等再刷状态
    setTimeout(() => void reload(), 400);
  };

  const copy = async (text: string, key: string) => {
    try {
      await window.vps.clipboardWrite(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* ignore */
    }
  };

  const regenToken = async () => {
    setBusy('token');
    try {
      // IPC 返回的是 { ok, data } 包装体，必须取 data ——
      // 直接把整个响应存进去会把 {ok:true,data:"..."} 写进配置，导致 Token 变成对象
      const r: any = await window.vps.mcpGenerateToken();
      const t = typeof r === 'string' ? r : r?.data;
      if (typeof t !== 'string' || !t) {
        setBusy(null);
        return;
      }
      await update({ token: t });
      setShowToken(true);
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    setBusy('restart');
    try {
      await window.vps.mcpRestart();
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const enabled = !!local.enabled;
  const running = !!status?.httpListening || !!status?.stdioReady;

  return (
    <>
      {/* 顶部标题 + 状态灯 */}
      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>MCP 服务</div>
        <div className="flex-1" />
        {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ 已保存</span>}
        <span
          className="row"
          style={{ gap: 6, fontSize: 12, marginLeft: 10 }}
          title={status?.lastError ?? undefined}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: !enabled ? 'var(--text-2)' : running ? 'var(--green)' : 'var(--red)',
              boxShadow: enabled && running ? '0 0 8px var(--green)' : 'none',
              transition: 'background .25s, box-shadow .25s',
            }}
          />
          <span style={{ color: 'var(--text-2)' }}>
            {!enabled ? '未启用' : running ? '运行中' : '已启用但未监听'}
          </span>
        </span>
      </div>

      {/* 说明 */}
      <div
        className="card"
        style={{
          marginBottom: 12,
          borderLeft: '3px solid var(--accent)',
          background: 'var(--bg-3)',
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          开启后，本软件会作为 <b>MCP 工具提供方</b>，让 WorkBuddy、豆包、ZCode、Kimi
          这类本地 Agent <b>直接读写你的终端</b> —— 不再局限于在设置里填一个 API Key。
          <div style={{ marginTop: 8, color: 'var(--text-2)', fontSize: 12 }}>
            它监听本机 <code>127.0.0.1</code>，不会暴露到局域网。
            所有写操作仍受下方的审批策略与风险评估约束，并记入审计日志。
          </div>
        </div>
      </div>

      {/* 总开关 */}
      <div className="card" style={{ marginBottom: 12 }}>
        <label
          className="row"
          style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            style={{ marginTop: 3 }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>启用 MCP 服务</div>
            <div className="field-hint" style={{ marginTop: 2 }}>
              关闭时，外部 Agent 完全无法接入本软件。
            </div>
          </div>
        </label>
      </div>

      {enabled && (
        <>
          {/* 错误提示 */}
          {status?.lastError && (
            <div
              className="card"
              style={{
                marginBottom: 12,
                borderLeft: '3px solid var(--red)',
                color: 'var(--red)',
                fontSize: 13,
              }}
            >
              {status.lastError}
              <div style={{ marginTop: 8 }}>
                <button className="btn" onClick={restart} disabled={busy === 'restart'}>
                  {busy === 'restart' ? '重启中…' : '重启服务'}
                </button>
              </div>
            </div>
          )}

          {/* 状态概览 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="grid-2" style={{ gap: 12 }}>
              <Stat label="stdio 通道" value={status?.stdioReady ? '就绪' : '未就绪'} ok={!!status?.stdioReady} />
              <Stat
                label="HTTP 监听"
                value={status?.httpListening ? `127.0.0.1:${status.httpPort}` : '未监听'}
                ok={!!status?.httpListening}
              />
              <Stat label="可用工具" value={`${status?.toolCount ?? 0} 个`} ok={(status?.toolCount ?? 0) > 0} />
              <Stat label="活跃会话" value={`${status?.sessions ?? 0}`} />
              <Stat label="累计调用" value={`${status?.callCount ?? 0} 次`} />
              <Stat
                label="待审批"
                value={`${status?.pendingApprovals ?? 0} 条`}
                ok={(status?.pendingApprovals ?? 0) === 0}
                warn={(status?.pendingApprovals ?? 0) > 0}
              />
            </div>
            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <button className="btn" onClick={() => void reload()}>
                刷新状态
              </button>
              <button className="btn" onClick={restart} disabled={busy === 'restart'}>
                {busy === 'restart' ? '重启中…' : '重启服务'}
              </button>
            </div>
          </div>

          {/* 传输方式 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>传输方式</div>

            <label className="row" style={{ gap: 10, cursor: 'pointer', marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={!!local.httpEnabled}
                onChange={(e) => update({ httpEnabled: e.target.checked })}
              />
              <div>
                <div>HTTP（Streamable HTTP）</div>
                <div className="field-hint">
                  常驻端口，可同时被多个客户端连接（豆包、Kimi 通常走这个）。
                </div>
              </div>
            </label>

            {local.httpEnabled && (
              <div className="grid-2" style={{ gap: 12 }}>
                <div className="field">
                  <label className="field-label">监听端口</label>
                  <input
                    value={local.httpPort ?? 39321}
                    onChange={(e) =>
                      setLocal((l: any) => ({ ...l, httpPort: parseInt(e.target.value) || 0 }))
                    }
                    onBlur={(e) => update({ httpPort: parseInt(e.target.value) || 39321 })}
                  />
                  <div className="field-hint">仅绑定 127.0.0.1。被占用时换个端口即可。</div>
                </div>
                <div className="field">
                  <label className="field-label">访问令牌（Bearer Token）</label>
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={local.token ?? ''}
                      placeholder="留空则不校验（不推荐）"
                      onChange={(e) => setLocal((l: any) => ({ ...l, token: e.target.value }))}
                      onBlur={(e) => update({ token: e.target.value })}
                      style={{ flex: 1 }}
                    />
                    <button className="btn" onClick={() => setShowToken((v) => !v)} title="显示/隐藏">
                      {showToken ? '隐藏' : '显示'}
                    </button>
                    <button className="btn" onClick={regenToken} disabled={busy === 'token'}>
                      {busy === 'token' ? '…' : '重新生成'}
                    </button>
                  </div>
                  <div className="field-hint">
                    {local.token
                      ? '外部 Agent 必须带上这个 Token 才能接入。'
                      : '⚠ 未设 Token 时，本机任何程序都能控制你的终端。建议生成一个。'}
                  </div>
                </div>
              </div>
            )}

            <div className="field-hint" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              stdio 通道始终可用：客户端可直接拉起本软件进程，通过标准输入输出通信。
            </div>
          </div>

          {/* 安全策略 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 10 }}>安全策略</div>

            <div className="field">
              <label className="field-label">审批策略</label>
              <select
                value={local.approvalPolicy ?? 'risky'}
                onChange={(e) => update({ approvalPolicy: e.target.value })}
              >
                <option value="risky">仅高风险操作需我在界面上确认（推荐）</option>
                <option value="always">任何写操作都需我确认</option>
                <option value="never">免审批，外部 Agent 自主执行</option>
              </select>
              <div className="field-hint">
                {local.approvalPolicy === 'never'
                  ? '⚠ 免审批模式下，MCP 客户端可直接在服务器上执行命令，无人值守。请确认你信任接入的客户端。'
                  : local.approvalPolicy === 'always'
                  ? '人不在电脑前时，外部 Agent 的写操作会一直等待，无法推进。'
                  : '低风险命令自动放行，高风险命令会弹出确认框并等你点击。'}
              </div>
            </div>

            <div className="field">
              <label className="field-label">能力开关</label>
              <div className="col" style={{ gap: 10 }}>
                <ToggleRow
                  checked={!!local.allowWrite}
                  onChange={(v) => update({ allowWrite: v })}
                  title="允许写入终端"
                  hint="外部 Agent 可以模拟键盘输入（发命令、回车）。关闭后对应的工具会从清单里消失。"
                />
                <ToggleRow
                  checked={!!local.allowExec}
                  onChange={(v) => update({ allowExec: v })}
                  title="允许执行命令"
                  hint="外部 Agent 可以执行非交互式命令并拿到完整 stdout / 退出码。"
                />
                <ToggleRow
                  checked={!!local.allowDangerous}
                  onChange={(v) => update({ allowDangerous: v })}
                  title="允许执行高危命令"
                  hint="开启后，被评估为「高」风险的操作不再被拦截。无论此开关如何，「禁止」级破坏性命令永远拦死。"
                  danger
                />
                <ToggleRow
                  checked={!!local.autoConnect}
                  onChange={(v) => update({ autoConnect: v })}
                  title="允许外部 Agent 自动建立 SSH 连接"
                  hint="关闭后，外部 Agent 只能操作你在界面上手动连好的主机。"
                />
                <ToggleRow
                  checked={!!local.auditEnabled}
                  onChange={(v) => update({ auditEnabled: v })}
                  title="记录 MCP 调用到审计日志"
                  hint="审计来源会标记为 mcp，并记录是谁批准的。"
                />
              </div>
            </div>

            <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">单次读取最大字符数</label>
                <input
                  value={local.maxReadChars ?? 30000}
                  onChange={(e) =>
                    setLocal((l: any) => ({ ...l, maxReadChars: parseInt(e.target.value) || 30000 }))
                  }
                  onBlur={(e) => update({ maxReadChars: parseInt(e.target.value) || 30000 })}
                />
                <div className="field-hint">读终端输出时的截断上限，防止一次塞爆上下文。</div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="field-label">命令超时（秒）</label>
                <input
                  value={local.commandTimeoutSec ?? 120}
                  onChange={(e) =>
                    setLocal((l: any) => ({ ...l, commandTimeoutSec: parseInt(e.target.value) || 120 }))
                  }
                  onBlur={(e) => update({ commandTimeoutSec: parseInt(e.target.value) || 120 })}
                />
                <div className="field-hint">MCP 执行单条命令的最长等待时间。</div>
              </div>
            </div>
          </div>

          {/* 工具清单 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600 }}>外部 Agent 能看到的能力</div>
              <div className="flex-1" />
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{tools.length} 个工具</span>
            </div>
            <div className="col" style={{ gap: 6 }}>
              {tools.map((t: any) => (
                <div
                  key={t.name}
                  className="row tool-row"
                  style={{
                    gap: 8,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: 'var(--bg-3)',
                    alignItems: 'baseline',
                  }}
                >
                  <code style={{ fontSize: 12, color: 'var(--accent)', minWidth: 160 }}>{t.name}</code>
                  <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1 }}>
                    {t.title || t.description}
                  </span>
                </div>
              ))}
              {tools.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  暂无可用工具（可能被上方的能力开关全部关闭）。
                </div>
              )}
            </div>
          </div>

          {/* 客户端配置 */}
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>客户端接入配置</div>
            <div className="field-hint" style={{ marginBottom: 8 }}>
              选你正在用的 Agent 客户端，把配置粘到它的 MCP 设置里即可。
            </div>
            <div className="field-hint" style={{ marginBottom: 12 }}>
              两种接法都可用：<b>HTTP</b> 直接连本机端口，多个工具可共用同一个连接；
              <b>stdio</b> 由客户端自己拉起一个转发进程，适合只会「跑本地命令」的客户端。
              stdio 方式不要求填端口和 Token —— 转发脚本自己会从配置里读。
            </div>
            <div className="col" style={{ gap: 10 }}>
              {snippets.map((s: any) => (
                <div
                  key={s.key}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    className="row"
                    style={{
                      padding: '8px 10px',
                      background: 'var(--bg-3)',
                      gap: 8,
                    }}
                  >
                    <b style={{ fontSize: 13 }}>{s.label}</b>
                    <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1 }}>{s.hint}</span>
                    <button
                      className="btn"
                      onClick={() => copy(s.config, s.key)}
                      title="复制到剪贴板"
                    >
                      {copied === s.key ? '✓ 已复制' : '复制'}
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 10,
                      fontSize: 12,
                      lineHeight: 1.6,
                      overflowX: 'auto',
                      background: 'var(--bg)',
                      maxHeight: 220,
                    }}
                  >
                    {s.config}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** 状态小格 */
function Stat({
  label,
  value,
  ok,
  warn,
}: {
  label: string;
  value: string;
  ok?: boolean;
  warn?: boolean;
}) {
  const color = warn ? 'var(--yellow, #e6b800)' : ok === false ? 'var(--text-2)' : ok ? 'var(--green)' : undefined;
  return (
    <div style={{ padding: '8px 10px', background: 'var(--bg-3)', borderRadius: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{label}</div>
      <div style={{ fontSize: 13, marginTop: 2, color: color ?? 'var(--text)' }}>{value}</div>
    </div>
  );
}

/** 带说明的开关行 */
function ToggleRow({
  checked,
  onChange,
  title,
  hint,
  danger,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
  danger?: boolean;
}) {
  return (
    <label className="row toggle-row" style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3 }}
      />
      <div>
        <div style={{ color: danger && checked ? 'var(--red)' : undefined }}>{title}</div>
        <div className="field-hint" style={{ marginTop: 2 }}>
          {hint}
        </div>
      </div>
    </label>
  );
}

function GeneralTab({ settings }: any) {
  const [local, setLocal] = React.useState(settings);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => setLocal(settings), [settings]);

  const update = async (patch: Record<string, unknown>) => {
    setLocal((l: any) => ({ ...l, ...patch }));
    await window.vps.setSettings(patch);
    refreshSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>通用设置</div>
        <div className="flex-1" />
        {saved && <span style={{ fontSize: 12, color: 'var(--green)' }}>✓ 已保存</span>}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label">默认审批模式</label>
          <select
            value={local.defaultApprovalMode}
            onChange={(e) => update({ defaultApprovalMode: e.target.value })}
          >
            <option value="auto_readonly">只读自动放行，写操作需确认（推荐）</option>
            <option value="every_step">每步都需我确认</option>
            <option value="plan_once">批准计划后自动执行</option>
          </select>
          <div className="field-hint">
            无论选哪种模式，被标记为「禁止」的破坏性命令都会被硬拦截，无法执行。
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="field">
          <label className="field-label">命令输出传给模型的最大字符数</label>
          <input
            value={local.maxOutputChars}
            onChange={(e) => setLocal((l: any) => ({ ...l, maxOutputChars: parseInt(e.target.value) || 8000 }))}
            onBlur={(e) => update({ maxOutputChars: parseInt(e.target.value) || 8000 })}
          />
          <div className="field-hint">
            日志太长会消耗大量 token。超出部分会被截断后再发给模型（完整输出仍保留在界面和审计日志中）。
          </div>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label">单条命令超时（秒）</label>
          <input
            value={local.commandTimeoutSec}
            onChange={(e) =>
              setLocal((l: any) => ({ ...l, commandTimeoutSec: parseInt(e.target.value) || 120 }))
            }
            onBlur={(e) => update({ commandTimeoutSec: parseInt(e.target.value) || 120 })}
          />
          <div className="field-hint">长时间运行的命令（如编译、下载）建议调大</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label">自定义危险命令规则（正则，每行一条）</label>
          <textarea
            rows={4}
            value={(local.extraDangerPatterns ?? []).join('\n')}
            onChange={(e) =>
              setLocal((l: any) => ({
                ...l,
                extraDangerPatterns: e.target.value.split('\n').filter((x: string) => x.trim()),
              }))
            }
            onBlur={(e) =>
              update({
                extraDangerPatterns: e.target.value.split('\n').filter((x: string) => x.trim()),
              })
            }
            placeholder={'例如：\ndrop\\s+database\nDROP\\s+TABLE'}
            className="mono"
          />
          <div className="field-hint">
            命中这些正则的命令会被标记为高危并要求你确认。默认规则已覆盖常见的破坏性命令。
          </div>
        </div>
      </div>

      <div className="card">
        <label className="row gap-8" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={local.auditEnabled}
            onChange={(e) => update({ auditEnabled: e.target.checked })}
            style={{ width: 'auto' }}
          />
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>启用操作审计日志</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
              记录每条执行过的命令、风险等级与结果，便于事后追溯
            </div>
          </div>
        </label>
      </div>
    </>
  );
}

/* ============ 关于 ============ */

function AboutTab() {
  const [info, setInfo] = React.useState<any>(null);
  React.useEffect(() => {
    window.vps.appInfo().then((r: any) => r.ok && setInfo(r.data));
  }, []);

  return (
    <>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>关于 VPS Pilot</div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.9, color: 'var(--text-1)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            VPS Pilot <span className="dim">v{info?.version ?? '0.1.0'}</span>
          </div>
          一个本地运行的 VPS 远程运维客户端 —— 既是 SSH 终端工具，也是一个能理解自然语言、
          自主规划并执行运维任务的 AI Agent。
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>安全设计</div>
        <ul style={{ fontSize: 12, lineHeight: 1.95, color: 'var(--text-2)', paddingLeft: 18 }}>
          <li>Agent 运行在本地，只有经过你批准的命令才会通过 SSH 发往服务器</li>
          <li>密码与 API Key 使用系统级加密存储（Windows DPAPI / macOS Keychain）</li>
          <li>破坏性命令（删根目录、格式化、写盘、关机等）被硬拦截，无法批准执行</li>
          <li>所有操作留痕，可在审计日志中完整回溯</li>
          <li>不向任何第三方服务上传你的服务器信息 —— 只有你配置的模型 API 会收到命令上下文</li>
        </ul>
      </div>

      <div className="card">
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>数据存放位置</div>
        <code className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)', wordBreak: 'break-all' }}>
          {info?.userData ?? '-'}
        </code>
        <div className="field-hint">
          主机配置、模型配置与审计日志以 JSON 文件存放在本机，不经过网络。
        </div>
      </div>
    </>
  );
}

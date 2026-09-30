import React from 'react';
import type { HostConfig, DiagReport, ProxyType } from '@shared/types';
import {
  useStore,
  setState,
  refreshHosts,
  refreshModels,
  refreshSettings,
  refreshExperts,
  refreshSkills,
  gotoNav,
  getState,
} from './store';
import type { NavGroup } from './store';
import { HostList, HostEditor } from './components/HostManager';
import { NavRail } from './components/NavRail';
import { TerminalView } from './components/TerminalView';
import { AgentPanel } from './components/AgentPanel';
import { SftpPanel } from './components/SftpPanel';
import { AuditPanel } from './components/AuditPanel';
import { SettingsPanel, DiagReportView } from './components/SettingsPanel';
import { LibraryPanel } from './components/LibraryPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Modal, StatusDot, hostLabel } from './components/ui';

/**
 * 应用主布局
 *
 * 三段式（左→右）：
 *   [一级导航栏 56px] [主机列表 268px（仅主机相关分组显示）] [工作区 flex]
 *
 * ⚠️ 关于工作区的一个硬性约束（别再改回去）
 *
 * 工作区（标签栏 + 终端/Agent/SFTP 实例）**必须常驻挂载**，切换一级导航时
 * 只切换 CSS 显示，绝不条件渲染卸载。原因：
 *
 *   1. TerminalView 的 useEffect 里创建了 Terminal 实例、打开了 SSH shell channel，
 *      cleanup 会执行 term.dispose() 并把 termRef 置空。一旦组件被卸载，
 *      正在服务器上跑的命令就变成孤儿进程（SSH 层还连着，但没人收输出），
 *      滚回历史（scrollback 20000 行）也全部丢失。
 *   2. 重新挂载会重新走一遍 termOpen，如果主进程侧的旧 channel 还没清理干净，
 *      会报「该主机已有活动会话」之类的问题。
 *
 * 之前这里写的是 `{view === 'terminal' && (...)}`，于是「进设置页再回来」
 * 就等于把终端重建一次 —— 表现就是回来之后终端一片空白、打不了字。
 * 现在改成常驻 + 隐藏，这条路径就不可能再坏。
 */

interface Tab {
  id: string;
  hostId: string;
  kind: 'terminal' | 'agent' | 'sftp';
  title: string;
}

/** 进入某个分组时，主机侧栏要不要显示 */
function showsHostList(nav: NavGroup): boolean {
  return nav === 'workspace' || nav === 'hosts';
}

export default function App() {
  const hosts = useStore((s) => s.hosts);
  const connected = useStore((s) => s.connected);
  const activeHostId = useStore((s) => s.activeHostId);
  const nav = useStore((s) => s.nav);
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);

  const [editingHost, setEditingHost] = React.useState<HostConfig | 'new' | null>(null);
  const [tabs, setTabs] = React.useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = React.useState<string | null>(null);
  const [connError, setConnError] = React.useState('');
  const [connErrorHost, setConnErrorHost] = React.useState<HostConfig | null>(null);
  const [toast, setToast] = React.useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  // 连续弹两条 toast 时，前一条的定时器不能把后一条提前清掉 —— 用 ref 追踪并清理
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 外部 Agent 通过 MCP 发起、正等人确认的操作 */
  const [mcpApproval, setMcpApproval] = React.useState<any | null>(null);

  const showToast = (msg: string, kind: 'ok' | 'err' = 'ok') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, kind });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  // 初始化
  React.useEffect(() => {
    refreshHosts();
    refreshModels();
    refreshSettings();
    refreshExperts();
    refreshSkills();
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  /**
   * MCP 审批提示。
   *
   * 外部 Agent 通过 MCP 发起的写操作，如果落在「需要人工确认」的策略上，
   * 会在主进程挂起并把请求推到这里。用户可能在任何一个页面，所以这个
   * 提示条挂在最外层，不依赖当前导航位置。
   */
  React.useEffect(() => {
    const off = window.vps.onMcpEvent?.((e: any) => {
      if (e?.type === 'approval' && e.pending) {
        setMcpApproval(e.pending);
      } else if (e?.type === 'approval_done') {
        setMcpApproval((cur: any) => (cur && cur.id === e.id ? null : cur));
      }
    });
    return () => off?.();
  }, []);

  /** 裁决 MCP 待审批操作 */
  const decideMcp = async (approve: boolean) => {
    const cur = mcpApproval;
    if (!cur) return;
    setMcpApproval(null);
    await window.vps.mcpDecideApproval(cur.id, approve);
    showToast(approve ? '已批准，外部 Agent 将继续执行' : '已拒绝该操作', approve ? 'ok' : 'err');
  };

  /** 连接主机 */
  const connect = async (h: HostConfig) => {
    setState({ connected: { ...getState().connected, [h.id]: 'connecting' } });
    const r: any = await window.vps.connect(h.id);
    if (r.ok) {
      setState({ connected: { ...getState().connected, [h.id]: 'connected' } });
      setConnError('');
      setConnErrorHost(null);
      showToast(`已连接到 ${h.name}`);
      return true;
    } else {
      setState({ connected: { ...getState().connected, [h.id]: 'error' } });
      setConnError(`${h.name}: ${r.error}`);
      setConnErrorHost(h);
      return false;
    }
  };

  /** 从状态栏直接发起诊断 */
  const diagnoseFailedHost = async () => {
    if (!connErrorHost) return;
    setEditingHost(null);
    setState({ activeHostId: connErrorHost.id });
    gotoNav('hosts');
    // 让 HostOverview 挂载后再触发诊断 —— 用一个一次性标记
    setPendingDiagHostId(connErrorHost.id);
  };
  const [pendingDiagHostId, setPendingDiagHostId] = React.useState<string | null>(null);

  const selectHost = async (h: HostConfig) => {
    setState({ activeHostId: h.id });
    if (nav === 'workspace' && connected[h.id] === 'connected') openTab(h, 'terminal');
    else gotoNav('hosts');
  };

  const openTab = (h: HostConfig, kind: Tab['kind']) => {
    setState({ activeHostId: h.id });
    gotoNav('workspace');
    const existing = tabs.find((t) => t.hostId === h.id && t.kind === kind);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `${h.id}:${kind}`;
    const titles = { terminal: '终端', agent: 'Agent', sftp: '文件' };
    setTabs((t) => [...t, { id, hostId: h.id, kind, title: `${h.name} · ${titles[kind]}` }]);
    setActiveTabId(id);
  };

  const closeTab = (id: string) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.id !== id);
      if (activeTabId === id) setActiveTabId(rest[rest.length - 1]?.id ?? null);
      return rest;
    });
  };

  const handleConnectClick = async (h: HostConfig) => {
    if (connected[h.id] === 'connected') {
      openTab(h, 'terminal');
      return;
    }
    const ok = await connect(h);
    if (ok) openTab(h, 'terminal');
  };

  const deleteHost = async (h: HostConfig) => {
    if (!confirm(`确定要删除主机「${h.name}」吗？\n\n该主机的连接会断开，相关配置将被移除。`)) return;
    // 先断开再删配置：断开依赖连接池里的 hostId，删除后连接池条目仍在，
    // 但反过来先删配置会让「删除成功却断开失败」留下一条僵尸连接
    await window.vps.disconnect(h.id);
    const r: any = await window.vps.deleteHost(h.id);
    if (!r?.ok) {
      showToast(r?.error ?? '删除失败', 'err');
      refreshHosts();
      return;
    }
    setTabs((t) => t.filter((x) => x.hostId !== h.id));
    refreshHosts();
    if (activeHostId === h.id) setState({ activeHostId: null });
    showToast(`已删除主机「${h.name}」`);
  };

  const activeHost = hosts.find((h) => h.id === activeHostId) ?? null;
  const connectedCount = Object.values(connected).filter((s) => s === 'connected').length;
  const inWorkspace = nav === 'workspace';

  return (
    <div className="col" style={{ height: '100%' }}>
      {/* ===== 标题栏（常驻，z-index 高于一切面板） ===== */}
      <header className="titlebar">
        <div className="row gap-8 titlebar-brand">
          <span className="titlebar-logo">VPS Pilot</span>
          <span className="badge badge-muted">AI Agent 运维</span>
        </div>

        <div className="flex-1" />

        {/* 连接概览 —— 放在标题栏中间偏右，一眼能看到当前连着几台 */}
        <div className="titlebar-meta" title="当前已连接的服务器数量">
          <span
            className="titlebar-meta-dot"
            style={{
              background: connectedCount > 0 ? 'var(--ok)' : 'var(--text-3)',
              boxShadow: connectedCount > 0 ? '0 0 6px var(--ok)' : 'none',
            }}
          />
          <span className="mono">{connectedCount}</span>
          <span>台已连接</span>
        </div>

        {/* 模型状态 */}
        <div
          className="titlebar-meta"
          title={models.find((m) => m.id === settings.activeModelId)?.label ?? '未配置模型 —— 去「设置 → 模型配置」添加'}
        >
          <span
            className="titlebar-meta-dot"
            style={{ background: models.length > 0 ? 'var(--ok)' : 'var(--warn)' }}
          />
          <span className="truncate" style={{ maxWidth: 150 }}>
            {models.find((m) => m.id === settings.activeModelId)?.label ?? '未配置模型'}
          </span>
        </div>
      </header>

      {/* ===== 主体：导航栏 + 主机列表 + 工作区 =====
          注意 alignItems 必须 stretch：.row 工具类默认 center，
          会把导航栏 / 主机列表收缩成内容高度并垂直居中（布局塌陷） */}
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        <NavRail
          nav={nav}
          connectedCount={connectedCount}
          onSelect={(k) => gotoNav(k)}
        />

        {/* 主机列表：只在工作区 / 主机分组显示，避免在配置页占用横向空间 */}
        {showsHostList(nav) && (
          <aside className="host-aside">
            <HostList
              hosts={hosts}
              connected={connected}
              activeHostId={activeHostId}
              onSelect={selectHost}
              onConnect={handleConnectClick}
              onEdit={(h) => setEditingHost(h)}
              onDelete={deleteHost}
              onAdd={() => setEditingHost('new')}
            />
          </aside>
        )}

        {/* ===== 右侧内容区：多层叠放，用显隐切换 ===== */}
        <div className="flex-1 col" style={{ minWidth: 0, position: 'relative' }}>
          {/*
            工作区：**常驻挂载**。inWorkspace 为 false 时只加 .is-hidden
            （visibility:hidden + pointer-events:none + inert），
            终端实例、SSH shell channel、scrollback 全部原样保留。

            ⚠️ 不要改成条件渲染。这是「从设置页回来终端就死了」的根因，
               详见本文件顶部的说明和 scripts/test-dom-events.ts 第 10 组。
          */}
          <WorkspaceLayer visible={inWorkspace}>
            <div className="col" style={{ flex: 1, minHeight: 0 }}>
              {/* 标签栏 */}
              <div className="tabstrip" role="tablist">
                {tabs.map((t) => {
                  const isActive = activeTabId === t.id;
                  return (
                    <div
                      key={t.id}
                      role="tab"
                      aria-selected={isActive}
                      className={`tab-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        setActiveTabId(t.id);
                        setState({ activeHostId: t.hostId });
                      }}
                    >
                      <StatusDot status={connected[t.hostId] ?? 'disconnected'} />
                      <span>{t.title}</span>
                      <button
                        className="btn btn-ghost btn-xs tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.id);
                        }}
                        title="关闭这个工作区"
                        aria-label={`关闭 ${t.title}`}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {tabs.length === 0 && (
                  <div style={{ padding: '9px 14px', fontSize: 11.5, color: 'var(--text-3)' }}>
                    还没有打开的工作区 —— 在左侧主机上点「连接」
                  </div>
                )}
              </div>

              {/* 工作区内容 */}
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                {tabs.length === 0 && (
                  <div className="empty">
                    <div style={{ fontSize: 34, opacity: 0.28 }}>▮</div>
                    <div className="empty-title">暂无打开的会话</div>
                    <div style={{ fontSize: 12.5 }}>
                      在左侧主机上点「连接」，或在主机概览里打开终端 / Agent
                    </div>
                  </div>
                )}

                {tabs.map((t) => {
                  const h = hosts.find((x) => x.id === t.hostId);
                  if (!h) return null;
                  const isActive = activeTabId === t.id;
                  const isConn = connected[t.hostId] === 'connected';
                  return (
                    <div
                      key={t.id}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: isActive ? 'flex' : 'none',
                        flexDirection: 'row',
                        minHeight: 0,
                      }}
                    >
                      {/*
                        每个标签页各自套一层错误边界：某个终端/SFTP 面板出问题
                        时只影响它自己，标签栏和其他标签仍然可用，不会整窗空白。
                      */}
                      <ErrorBoundary key={`${t.id}:boundary`} label={`${t.title}`}>
                        {t.kind === 'terminal' && (
                          <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
                            <TerminalView host={h} active={isActive && inWorkspace} />
                          </div>
                        )}
                        {t.kind === 'agent' && <AgentPanel host={h} connected={isConn} />}
                        {t.kind === 'sftp' && <SftpPanel host={h} connected={isConn} />}
                      </ErrorBoundary>
                    </div>
                  );
                })}
              </div>
            </div>
          </WorkspaceLayer>

          {/* 主机概览 */}
          <OverlayLayer visible={nav === 'hosts'}>
            {activeHost ? (
              <HostOverview
                key={activeHost.id}
                host={activeHost}
                status={connected[activeHost.id] ?? 'disconnected'}
                onConnect={() => handleConnectClick(activeHost)}
                onOpen={(k) => openTab(activeHost, k)}
                onEdit={() => setEditingHost(activeHost)}
                autoDiag={pendingDiagHostId === activeHost.id}
                onAutoDiagDone={() => setPendingDiagHostId(null)}
              />
            ) : (
              <div className="empty">
                <div style={{ fontSize: 38, opacity: 0.28 }}>🖥</div>
                <div className="empty-title">选择一台服务器开始</div>
                <div style={{ fontSize: 12.5, maxWidth: 460, lineHeight: 1.85 }}>
                  在左侧选择主机，或点击「添加」录入你的 VPS 信息。
                  <br />
                  连接后你可以打开终端、用自然语言指挥 Agent 部署服务，或管理远程文件。
                </div>
                {hosts.length === 0 && (
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 10 }}
                    onClick={() => setEditingHost('new')}
                  >
                    添加第一台 VPS
                  </button>
                )}
              </div>
            )}
          </OverlayLayer>

          {/* 审计 */}
          <OverlayLayer visible={nav === 'audit'}>
            <ErrorBoundary label="审计日志">
              <AuditPanel hosts={hosts} />
            </ErrorBoundary>
          </OverlayLayer>

          {/* 专家库 */}
          <OverlayLayer visible={nav === 'library'}>
            <ErrorBoundary label="专家库">
              <LibraryPanel />
            </ErrorBoundary>
          </OverlayLayer>

          {/* 设置 */}
          <OverlayLayer visible={nav === 'settings'}>
            <ErrorBoundary label="设置">
              <SettingsPanel />
            </ErrorBoundary>
          </OverlayLayer>
        </div>
      </div>

      {/* ===== 状态栏 ===== */}
      <div className="statusbar">
        <span>{hosts.length} 台主机</span>
        <span>{connectedCount} 个已连接</span>
        <div className="flex-1" />
        {connError && (
          <>
            <span className="truncate" style={{ color: 'var(--danger)', maxWidth: 420 }} title={connError}>
              {connError}
            </span>
            {connErrorHost && (
              <button
                className="btn btn-xs btn-danger-ghost"
                onClick={diagnoseFailedHost}
                title="逐段检查连接链路，定位卡在哪一步"
              >
                诊断原因
              </button>
            )}
          </>
        )}
      </div>

      {/* 主机编辑 */}
      {editingHost && (
        <HostEditor
          host={editingHost === 'new' ? undefined : editingHost}
          hosts={hosts}
          onClose={() => setEditingHost(null)}
          onSaved={() => {
            refreshHosts();
            showToast('主机已保存');
          }}
        />
      )}

      {/* Toast */}
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.msg}</div>}

      {/*
        MCP 审批条。
        外部 Agent 的操作挂起时，用户必须能在任何页面看到并处理它 ——
        否则 Agent 那边会一直等，而用户根本不知道有人在等。
      */}
      {mcpApproval && (
        <div className="mcp-approval" role="alertdialog" aria-label="外部 Agent 请求执行操作">
          <div className="mcp-approval-head">
            <span className={`mcp-risk mcp-risk-${mcpApproval.risk}`}>{mcpApproval.risk}</span>
            <b>外部 Agent 请求执行操作</b>
            <span style={{ fontSize: 12, color: 'var(--text-2)', marginLeft: 'auto' }}>
              {mcpApproval.client ? `来自 ${mcpApproval.client}` : 'MCP 客户端'}
            </span>
          </div>
          <div className="mcp-approval-body">
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 4 }}>
              目标主机：<b style={{ color: 'var(--text-0)' }}>{mcpApproval.hostName}</b>
              {'　'}工具：<code>{mcpApproval.tool}</code>
            </div>
            <pre className="mcp-approval-cmd">{mcpApproval.command}</pre>
            {mcpApproval.reasons?.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--yellow)', marginTop: 6 }}>
                风险提示：{mcpApproval.reasons.join('；')}
              </div>
            )}
          </div>
          <div className="mcp-approval-actions">
            <button className="btn" onClick={() => void decideMcp(false)}>
              拒绝
            </button>
            <button className="btn btn-primary" onClick={() => void decideMcp(true)}>
              批准执行
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 工作区层：常驻挂载，只切显隐。
 *
 * 用 visibility + pointer-events 而不是只靠 display:none，
 * 并且额外用原生 `inert` 属性把整层移出可交互树 —— 否则 Tab 键会跑到
 * 看不见的终端里，用户会陷入「焦点消失了」的困惑。
 *
 * 注：React 18 的 JSX 类型里还没有 inert，所以走 ref 直接设原生属性。
 */
function WorkspaceLayer({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // inert 在现代 Chromium（Electron 33 是 Chromium 130）里是原生支持的
    if (visible) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [visible]);

  return (
    <div className={`layer ${visible ? '' : 'is-hidden'}`} aria-hidden={!visible} ref={ref}>
      {children}
    </div>
  );
}

/** 普通覆盖层：同样常驻，切换显隐 */
function OverlayLayer({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  if (!visible) return null;
  return <div className="layer">{children}</div>;
}

/** 主机概览页 */
function HostOverview({
  host,
  status,
  onConnect,
  onOpen,
  onEdit,
  autoDiag,
  onAutoDiagDone,
}: {
  host: HostConfig;
  status: string;
  onConnect: () => void;
  onOpen: (kind: 'terminal' | 'agent' | 'sftp') => void;
  onEdit: () => void;
  autoDiag?: boolean;
  onAutoDiagDone?: () => void;
}) {
  const isConn = status === 'connected';
  const [probing, setProbing] = React.useState(false);
  const [probeResult, setProbeResult] = React.useState('');
  const [proxyText, setProxyText] = React.useState('直连');
  const [diagOpen, setDiagOpen] = React.useState(false);
  const [diagRunning, setDiagRunning] = React.useState(false);
  const [diag, setDiag] = React.useState<DiagReport | null>(null);

  React.useEffect(() => {
    window.vps.describeProxy(host.id).then((r: any) => {
      if (r?.ok) setProxyText(r.data.text);
    });
  }, [host.id, host.proxyMode, host.proxy?.host, host.proxy?.port, host.proxy?.type]);

  const probe = async () => {
    setProbing(true);
    setProbeResult('');
    const r: any = await window.vps.probeHost(host.id);
    setProbing(false);
    if (r.ok) setProbeResult(r.data);
    else setProbeResult(`探测失败：${r.error}`);
  };

  const runDiag = async () => {
    setDiagOpen(true);
    setDiagRunning(true);
    setDiag(null);
    const r: any = await window.vps.diagnose(host.id);
    setDiagRunning(false);
    setDiag(r.ok ? (r.data as DiagReport) : null);
  };

  // 连接失败后从状态栏点「诊断」进来时，自动跑一次
  React.useEffect(() => {
    if (autoDiag) {
      void runDiag();
      onAutoDiagDone?.();
    }
    // 只在 autoDiag 变为 true 时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDiag]);

  return (
    <div className="scroll-panel" style={{ padding: 24 }}>
      <div className="row gap-12" style={{ marginBottom: 20 }}>
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 10,
            background: isConn ? 'var(--green-dim)' : 'var(--bg-3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            border: `1px solid ${isConn ? 'rgba(63,185,80,0.3)' : 'var(--border)'}`,
          }}
        >
          🖥
        </div>
        <div style={{ flex: 1 }}>
          <div className="row gap-8" style={{ marginBottom: 3 }}>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{host.name}</span>
            <StatusDot status={status} />
            <span style={{ fontSize: 11.5, color: isConn ? 'var(--green)' : 'var(--text-3)' }}>
              {isConn ? '已连接' : status === 'connecting' ? '连接中' : '未连接'}
            </span>
          </div>
          <div className="mono dim" style={{ fontSize: 12 }}>
            {hostLabel(host)}
            {host.jumpHostId && ' · 经跳板机'}
            {proxyText !== '直连' && ` · ${proxyText}`}
          </div>
        </div>
        <button className="btn" onClick={runDiag} disabled={diagRunning} title="检查连接链路，定位卡在哪一步">
          {diagRunning && <span className="spinner" />}
          {diagRunning ? '诊断中…' : '一键诊断'}
        </button>
        <button className="btn" onClick={onEdit}>
          编辑配置
        </button>
        <button className={isConn ? 'btn' : 'btn btn-primary'} onClick={onConnect} disabled={status === 'connecting'}>
          {status === 'connecting' ? '连接中…' : isConn ? '打开终端' : '连接'}
        </button>
      </div>

      {/* 快捷入口 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        <QuickCard
          icon="▮"
          title="终端"
          desc="交互式 SSH 会话，和你习惯的终端一样"
          disabled={!isConn}
          onClick={() => onOpen('terminal')}
        />
        <QuickCard
          icon="✦"
          title="AI Agent"
          desc="用一句话描述目标，自动规划并执行运维任务"
          highlight
          disabled={!isConn}
          onClick={() => onOpen('agent')}
        />
        <QuickCard
          icon="📁"
          title="文件管理"
          desc="浏览、编辑、上传下载远程文件"
          disabled={!isConn}
          onClick={() => onOpen('sftp')}
        />
      </div>

      {/* 环境探测 */}
      {isConn && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>服务器环境探测</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                查看系统版本、CPU、内存、磁盘和包管理器，便于规划部署
              </div>
            </div>
            <button className="btn btn-sm" onClick={probe} disabled={probing}>
              {probing && <span className="spinner" />}
              {probing ? '探测中…' : '开始探测'}
            </button>
          </div>
          {probeResult && (
            <pre
              className="mono"
              style={{
                background: '#010409',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: 12,
                fontSize: 11.5,
                lineHeight: 1.65,
                maxHeight: 380,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                margin: 0,
                color: 'var(--text-1)',
              }}
            >
              {probeResult}
            </pre>
          )}
        </div>
      )}

      {/* 详细信息 */}
      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>配置详情</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px 24px' }}>
          <InfoRow label="地址" value={`${host.host}:${host.port}`} mono />
          <InfoRow label="用户名" value={host.username} mono />
          <InfoRow
            label="认证方式"
            value={host.authType === 'password' ? '密码' : host.authType === 'privateKey' ? '私钥文件' : 'SSH Agent'}
          />
          <InfoRow label="工作目录" value={host.defaultCwd || '—'} mono />
          <InfoRow
            label="网络代理"
            value={`${proxyText}${
              host.proxyMode === 'direct' ? '（本机强制）' : host.proxyMode === 'custom' ? '（本机单独配置）' : '（跟随全局）'
            }`}
            mono
          />
          {host.privateKeyPath && <InfoRow label="私钥路径" value={host.privateKeyPath} mono />}
          {host.note && <InfoRow label="备注" value={host.note} />}
        </div>
      </div>

      {/* 一键诊断 */}
      {diagOpen && (
        <Modal
          title={`连接诊断 · ${host.name}`}
          onClose={() => setDiagOpen(false)}
          width={660}
          footer={
            <>
              <button className="btn" onClick={() => setDiagOpen(false)}>
                关闭
              </button>
              <div className="flex-1" />
              <button className="btn btn-primary" onClick={runDiag} disabled={diagRunning}>
                {diagRunning && <span className="spinner" />}
                重新诊断
              </button>
            </>
          }
        >
          {diagRunning && (
            <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
              <span className="spinner" /> 正在逐段检查连接链路…
            </div>
          )}
          {!diagRunning && diag && <DiagReportView report={diag} />}
          {!diagRunning && !diag && (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12.5, color: 'var(--red)' }}>
              诊断执行失败，请重试。
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function QuickCard({
  icon,
  title,
  desc,
  onClick,
  disabled,
  highlight,
}: {
  icon: string;
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  highlight?: boolean;
}) {
  return (
    <button
      className={`card quick-card${highlight ? ' quick-card-hl' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <div style={{ fontSize: 19, marginBottom: 7, color: highlight ? 'var(--accent)' : 'var(--text-2)' }}>
        {icon}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.6 }}>{desc}</div>
    </button>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>{label}</div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

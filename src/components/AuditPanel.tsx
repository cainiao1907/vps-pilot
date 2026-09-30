import React from 'react';
import type { AuditEntry, RiskLevel } from '@shared/types';
import { RiskBadge, Empty, fmtTime, fmtRel } from './ui';

/**
 * 审计日志 —— 所有通过 Agent 和手动执行的命令都记录在此
 */
export function AuditPanel({ hosts }: { hosts: any[] }) {
  const [entries, setEntries] = React.useState<AuditEntry[]>([]);
  const [hostFilter, setHostFilter] = React.useState('');
  const [riskFilter, setRiskFilter] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<Record<number, boolean>>({});
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    const r: any = await window.vps.listAudit({ hostId: hostFilter || undefined, limit: 500 });
    setLoading(false);
    if (r.ok) setEntries(r.data);
  }, [hostFilter]);

  React.useEffect(() => {
    load();
  }, [load]);

  const filtered = entries.filter((e) => {
    if (riskFilter && e.risk !== riskFilter) return false;
    if (query && !e.command.toLowerCase().includes(query.toLowerCase()) && !e.action.toLowerCase().includes(query.toLowerCase()))
      return false;
    return true;
  });

  const stats = React.useMemo(() => {
    const total = entries.length;
    const risky = entries.filter((e) => e.risk === 'high' || e.risk === 'critical').length;
    const rejected = entries.filter((e) => e.approved === false || e.risk === 'critical').length;
    const failed = entries.filter((e) => e.exitCode !== null && e.exitCode !== 0).length;
    return { total, risky, rejected, failed };
  }, [entries]);

  return (
    <div className="col" style={{ height: '100%' }}>
      {/* 统计条 */}
      <div
        style={{
          display: 'flex',
          gap: 1,
          background: 'var(--border)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <Stat label="总操作数" value={stats.total} />
        <Stat label="高危操作" value={stats.risky} color="var(--orange)" />
        <Stat label="已拦截" value={stats.rejected} color="var(--red)" />
        <Stat label="执行失败" value={stats.failed} color="var(--yellow)" />
      </div>

      {/* 过滤栏 */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索命令或操作描述…"
          style={{ flex: 1, fontSize: 12 }}
        />
        <select
          value={hostFilter}
          onChange={(e) => setHostFilter(e.target.value)}
          style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }}
        >
          <option value="">全部主机</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <select
          value={riskFilter}
          onChange={(e) => setRiskFilter(e.target.value)}
          style={{ width: 'auto', fontSize: 12, padding: '6px 10px' }}
        >
          <option value="">全部风险等级</option>
          <option value="safe">安全</option>
          <option value="low">低危</option>
          <option value="medium">中危</option>
          <option value="high">高危</option>
          <option value="critical">禁止</option>
        </select>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? <span className="spinner" /> : '刷新'}
        </button>
        <button
          className="btn btn-sm"
          style={{ color: 'var(--red)' }}
          onClick={async () => {
            if (!confirm('确定要清空所有审计日志吗？此操作不可撤销。')) return;
            await window.vps.clearAudit();
            load();
          }}
        >
          清空
        </button>
      </div>

      {/* 列表 */}
      <div className="scroll-panel">
        {filtered.length === 0 && !loading && (
          <Empty
            icon="📋"
            title={entries.length === 0 ? '还没有任何操作记录' : '没有匹配的记录'}
            desc={
              entries.length === 0
                ? '当 Agent 或你手动执行命令后，这里会记录完整的历史，包括命令内容、风险等级、执行结果'
                : undefined
            }
          />
        )}

        {filtered.map((e) => (
          <div
            key={e.id}
            style={{
              padding: '9px 14px',
              borderBottom: '1px solid var(--border-light)',
              cursor: 'pointer',
            }}
            onClick={() => setExpanded((x) => ({ ...x, [e.id]: !x[e.id] }))}
            onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
          >
            <div className="row gap-8" style={{ marginBottom: 3 }}>
              <RiskBadge level={e.risk as RiskLevel} small />
              <span className="badge" style={{ background: 'var(--bg-3)', color: 'var(--text-2)', fontSize: 10 }}>
                {e.source === 'agent' ? 'Agent' : '手动'}
              </span>
              {e.approved === false && (
                <span className="badge" style={{ background: 'var(--orange-dim)', color: 'var(--orange)', fontSize: 10 }}>
                  已拒绝
                </span>
              )}
              {e.exitCode !== null && (
                <span
                  className="mono"
                  style={{ fontSize: 10.5, color: e.exitCode === 0 ? 'var(--green)' : 'var(--red)' }}
                >
                  exit {e.exitCode}
                </span>
              )}
              <div className="flex-1" />
              <span className="dim" style={{ fontSize: 11 }} title={fmtTime(e.ts)}>
                {fmtRel(e.ts)}
              </span>
            </div>

            <div className="truncate" style={{ fontSize: 12, marginBottom: 2 }}>
              {e.action}
            </div>
            <div className="row gap-8">
              <code
                className="mono truncate"
                style={{ fontSize: 11, color: 'var(--text-3)', flex: 1 }}
              >
                $ {e.command}
              </code>
              <span className="dim" style={{ fontSize: 10.5, flexShrink: 0 }}>
                {e.hostName}
              </span>
            </div>

            {expanded[e.id] && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4, fontWeight: 600 }}>
                  完整命令
                </div>
                <pre
                  className="mono"
                  style={{
                    background: 'var(--bg-0)',
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    margin: '0 0 10px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 11.5,
                  }}
                >
                  {e.command}
                </pre>
                {e.outputSummary && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4, fontWeight: 600 }}>
                      输出摘要
                    </div>
                    <pre
                      className="mono"
                      style={{
                        background: '#010409',
                        padding: '8px 10px',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                        maxHeight: 260,
                        overflow: 'auto',
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        fontSize: 11.5,
                        color: 'var(--text-1)',
                      }}
                    >
                      {e.outputSummary}
                    </pre>
                  </>
                )}
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
                  执行时间：{fmtTime(e.ts)} · 耗时 {(e.durationMs / 1000).toFixed(2)}s
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-1)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 600, color: color ?? 'var(--text-0)' }}>{value}</div>
    </div>
  );
}

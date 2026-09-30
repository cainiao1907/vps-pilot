import React from 'react';
import type { ExpertConfig, ExpertInput, ApprovalMode } from '@shared/types';
import { Modal } from './ui';
import { useStore, refreshExperts, refreshSettings, getState } from '../store';
import { EXPERT_CATEGORIES } from '@shared/experts';

/**
 * 专家配置面板
 *
 * 交互设计上做了两个关键取舍：
 *  1. 内置专家不能直接编辑（只能停用 / 复制成自定义）—— 否则版本升级时
 *     用户的改动会被覆盖，或者用户拿到的是过期的内置内容
 *  2. 「复制为自定义」是这个页面的主要入口 —— 绝大多数用户想做的其实是
 *     「在内置专家的基础上改一点」，而不是从空白开始写提示词
 */

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  auto_readonly: '只读自动放行，写操作需确认',
  every_step: '每步都需我确认',
  plan_once: '批准计划后自动执行',
};

export function ExpertsPanel() {
  const experts = useStore((s) => s.experts);
  const settings = useStore((s) => s.settings);
  const [editing, setEditing] = React.useState<ExpertConfig | 'new' | null>(null);
  const [preview, setPreview] = React.useState<ExpertConfig | null>(null);

  const refreshAll = () => {
    refreshExperts();
    refreshSettings();
  };

  const toggleEnabled = async (e: ExpertConfig) => {
    await window.vps.setExpertEnabled(e.id, !e.enabled);
    refreshAll();
  };

  const duplicate = async (e: ExpertConfig) => {
    const r: any = await window.vps.duplicateExpert(e.id);
    if (r?.ok) {
      refreshAll();
      setEditing(r.data as ExpertConfig);
    }
  };

  const remove = async (e: ExpertConfig) => {
    if (!confirm(`删除专家「${e.name}」？\n\n此操作不可撤销。`)) return;
    await window.vps.deleteExpert(e.id);
    refreshAll();
  };

  const setDefault = async (e: ExpertConfig) => {
    await window.vps.setSettings({ defaultExpertId: e.id });
    refreshSettings();
  };

  // 按分类分组，分类顺序按 EXPERT_CATEGORIES，未在表里的排最后
  const grouped = React.useMemo(() => {
    const map = new Map<string, ExpertConfig[]>();
    for (const e of experts) {
      const list = map.get(e.category) ?? [];
      list.push(e);
      map.set(e.category, list);
    }
    const cats = Array.from(map.keys()).sort((a, b) => {
      const ia = EXPERT_CATEGORIES.indexOf(a);
      const ib = EXPERT_CATEGORIES.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return cats.map((c) => ({ category: c, items: map.get(c)! }));
  }, [experts]);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="flex-1">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>专家（Persona）</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            专家决定 Agent「以什么身份、用什么方法论」来规划命令。
            <br />
            同一个任务，交给「资深 SRE」和「新手向导」，产出的计划粒度与解释详细程度完全不同。
          </div>
        </div>
        <button className="btn btn-accent" onClick={() => setEditing('new')}>
          + 新建专家
        </button>
      </div>

      {experts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 30, opacity: 0.3, marginBottom: 10 }}>🧩</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>没有可用的专家</div>
        </div>
      )}

      {grouped.map(({ category, items }) => (
        <div key={category} style={{ marginBottom: 18 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--text-3)',
              letterSpacing: '0.6px',
              marginBottom: 8,
              textTransform: 'uppercase',
            }}
          >
            {category}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {items.map((e) => {
              const isDefault = settings.defaultExpertId === e.id;
              return (
                <div
                  key={e.id}
                  className="card"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '12px 14px',
                    opacity: e.enabled ? 1 : 0.5,
                    borderColor: isDefault ? 'var(--accent)' : 'var(--border)',
                    background: isDefault ? 'var(--accent-dim)' : 'var(--bg-2)',
                  }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 8,
                      background: 'var(--bg-3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 17,
                      flexShrink: 0,
                    }}
                  >
                    {e.icon}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row gap-8" style={{ marginBottom: 3, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</span>
                      {e.builtin && (
                        <span
                          className="badge"
                          style={{ background: 'var(--bg-3)', color: 'var(--text-3)', fontSize: 10 }}
                        >
                          内置
                        </span>
                      )}
                      {!e.builtin && (
                        <span
                          className="badge"
                          style={{ background: 'var(--purple)', color: '#fff', fontSize: 10, opacity: 0.85 }}
                        >
                          自定义
                        </span>
                      )}
                      {isDefault && (
                        <span
                          className="badge"
                          style={{ background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10 }}
                        >
                          默认
                        </span>
                      )}
                      {!e.enabled && (
                        <span
                          className="badge"
                          style={{ background: 'var(--yellow-dim)', color: 'var(--yellow)', fontSize: 10 }}
                        >
                          已停用
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.65 }}>
                      {e.description || '（无说明）'}
                    </div>
                    {e.suggestedApprovalMode && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 4 }}>
                        建议审批：{APPROVAL_LABELS[e.suggestedApprovalMode]}
                      </div>
                    )}
                  </div>

                  <div className="row gap-6" style={{ flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button className="btn btn-xs" onClick={() => setPreview(e)} title="查看完整提示词">
                      查看
                    </button>
                    {!isDefault && e.enabled && (
                      <button className="btn btn-xs" onClick={() => setDefault(e)}>
                        设为默认
                      </button>
                    )}
                    {e.builtin ? (
                      <button className="btn btn-xs" onClick={() => duplicate(e)} title="基于它创建一份可编辑的副本">
                        复制
                      </button>
                    ) : (
                      <button className="btn btn-xs" onClick={() => setEditing(e)}>
                        编辑
                      </button>
                    )}
                    <button className="btn btn-xs" onClick={() => toggleEnabled(e)}>
                      {e.enabled ? '停用' : '启用'}
                    </button>
                    {!e.builtin && (
                      <button
                        className="btn btn-xs btn-ghost"
                        style={{ color: 'var(--red)' }}
                        onClick={() => remove(e)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {editing && (
        <ExpertEditor
          expert={editing === 'new' ? undefined : (editing as ExpertConfig)}
          onClose={() => setEditing(null)}
          onSaved={refreshAll}
        />
      )}

      {preview && (
        <Modal title={`提示词 · ${preview.name}`} onClose={() => setPreview(null)} width={680}
          footer={<button className="btn" onClick={() => setPreview(null)}>关闭</button>}>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 8 }}>
            以下内容会被拼接在 Agent 的基础提示词之后，作为它的人格设定：
          </div>
          <pre
            className="mono"
            style={{
              background: 'var(--bg-0)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: 12,
              fontSize: 11.5,
              lineHeight: 1.75,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 460,
              overflowY: 'auto', overscrollBehavior: 'contain',
              margin: 0,
              color: 'var(--text-1)',
            }}
          >
            {preview.prompt || '（这个专家没有提示词）'}
          </pre>
        </Modal>
      )}
    </>
  );
}

/* ============ 专家编辑器 ============ */

const ICON_CHOICES = ['🔧', '📊', '🛡', '🐳', '🌐', '🗄', '🔍', '⚡', '🔌', '🎓', '📋', '▫', '🧩', '🚀', '🧪', '🔐'];

function ExpertEditor({
  expert,
  onClose,
  onSaved,
}: {
  expert?: ExpertConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<ExpertInput>({
    id: expert?.id,
    name: expert?.name ?? '',
    description: expert?.description ?? '',
    icon: expert?.icon ?? '🧩',
    category: expert?.category ?? '自定义',
    prompt: expert?.prompt ?? '',
    suggestedApprovalMode: expert?.suggestedApprovalMode,
    enabled: expert?.enabled ?? true,
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const set = (k: keyof ExpertInput, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError('');
    if (!form.name.trim()) return setError('请填写专家名称');
    if (!form.prompt.trim()) return setError('请填写提示词 —— 这是专家的核心内容');
    setSaving(true);
    const r: any = await window.vps.saveExpert(form);
    setSaving(false);
    if (!r.ok) return setError(r.error ?? '保存失败');
    onSaved();
    onClose();
  };

  return (
    <Modal
      title={expert ? `编辑专家 · ${expert.name}` : '新建专家'}
      onClose={onClose}
      width={700}
      footer={
        <>
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
      <div className="field-row">
        <div className="field" style={{ flex: 2 }}>
          <label className="field-label">名称 *</label>
          <input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="例如：灰度发布专家"
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">分类</label>
          <input
            value={form.category}
            onChange={(e) => set('category', e.target.value)}
            placeholder="自定义"
          />
        </div>
      </div>

      <div className="field">
        <label className="field-label">图标</label>
        <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
          {ICON_CHOICES.map((ic) => (
            <button
              key={ic}
              className={`btn btn-xs ${form.icon === ic ? 'btn-accent' : ''}`}
              onClick={() => set('icon', ic)}
              style={{ fontSize: 15, padding: '4px 7px', minWidth: 32 }}
            >
              {ic}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field-label">一句话说明</label>
        <input
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="在 Agent 面板里显示，让用户知道什么时候该选它"
        />
      </div>

      <div className="field">
        <label className="field-label">建议审批模式</label>
        <select
          value={form.suggestedApprovalMode ?? ''}
          onChange={(e) => set('suggestedApprovalMode', (e.target.value || undefined) as ApprovalMode | undefined)}
        >
          <option value="">不指定（跟随全局设置）</option>
          <option value="auto_readonly">只读自动放行，写操作需确认</option>
          <option value="every_step">每步都需我确认</option>
          <option value="plan_once">批准计划后自动执行</option>
        </select>
        <div className="field-hint">
          选用这个专家时，Agent 面板的审批模式会自动切到这里的值 —— 用户可以随时手动改回去。
        </div>
      </div>

      <div className="field">
        <label className="field-label">提示词 *</label>
        <textarea
          rows={14}
          value={form.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          placeholder={`用第二人称描述这个专家的身份和工作方式。例如：

你是一位专注于高并发系统的工程师。

## 核心原则
- 先压测再优化，不做没有数据支撑的调优
- 任何改动都要评估对现有流量的影响

## 输出要求
- 明确给出预期收益和代价
- 不确定的地方要直说`}
          className="mono"
          style={{ fontSize: 12, lineHeight: 1.7 }}
        />
        <div className="field-hint">
          <strong>只写人格和方法论，不要写输出格式</strong> —— JSON 格式要求由系统统一负责，
          在写它会覆盖掉正确的输出结构，导致计划无法解析。
        </div>
      </div>

      <label className="row gap-8" style={{ cursor: 'pointer', marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={form.enabled !== false}
          onChange={(e) => set('enabled', e.target.checked)}
          style={{ width: 'auto' }}
        />
        <span style={{ fontSize: 12.5 }}>启用（在 Agent 面板中可选）</span>
      </label>

      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}

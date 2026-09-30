import React from 'react';
import type { SkillConfig, SkillInput, SkillParam } from '@shared/types';
import { Modal } from './ui';
import { useStore, refreshSkills, refreshSettings } from '../store';
import { SKILL_CATEGORIES } from '@shared/experts';

/**
 * 技能配置面板
 *
 * 技能的本质是「把踩过的坑固化成配方」：标准步骤 + 判断规则 + 风险提示。
 * 所以编辑器的字段设计围绕这三点，而不是给一个自由文本框了事。
 *
 * 表格化的步骤编辑（而不是让用户写一大段文本）理由：
 * 步骤会被逐条编号注入提示词，结构化之后既能校验空行、又能在 Agent 面板里
 * 预览「这次会按哪几步走」，对用户是可解释的。
 */

export function SkillsPanel() {
  const skills = useStore((s) => s.skills);
  const settings = useStore((s) => s.settings);
  const [editing, setEditing] = React.useState<SkillConfig | 'new' | null>(null);
  const [preview, setPreview] = React.useState<SkillConfig | null>(null);
  const [query, setQuery] = React.useState('');

  const refreshAll = () => {
    refreshSkills();
    refreshSettings();
  };

  const toggleEnabled = async (s: SkillConfig) => {
    await window.vps.setSkillEnabled(s.id, !s.enabled);
    refreshAll();
  };

  const duplicate = async (s: SkillConfig) => {
    const r: any = await window.vps.duplicateSkill(s.id);
    if (r?.ok) {
      refreshAll();
      setEditing(r.data as SkillConfig);
    }
  };

  const remove = async (s: SkillConfig) => {
    if (!confirm(`删除技能「${s.name}」？\n\n此操作不可撤销。`)) return;
    await window.vps.deleteSkill(s.id);
    refreshAll();
  };

  const toggleDefault = async (s: SkillConfig) => {
    const cur = settings.defaultSkillIds ?? [];
    const next = cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id];
    await window.vps.setSettings({ defaultSkillIds: next });
    refreshSettings();
  };

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        (s.triggers ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }, [skills, query]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, SkillConfig[]>();
    for (const s of filtered) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    const cats = Array.from(map.keys()).sort((a, b) => {
      const ia = SKILL_CATEGORIES.indexOf(a);
      const ib = SKILL_CATEGORIES.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    return cats.map((c) => ({ category: c, items: map.get(c)! }));
  }, [filtered]);

  const defaultCount = (settings.defaultSkillIds ?? []).length;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="flex-1">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>技能（Skills）</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            技能是「任务配方」——把某个场景的标准步骤、判断规则和常见坑固化下来。
            <br />
            勾选为默认的技能会在每次执行任务时自动带上；也可以只针对单次任务临时启用。
          </div>
        </div>
        <button className="btn btn-accent" onClick={() => setEditing('new')}>
          + 新建技能
        </button>
      </div>

      <div className="row gap-8" style={{ marginBottom: 14 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索技能名称、说明或关键词…"
          style={{ flex: 1 }}
        />
        {defaultCount > 0 && (
          <span className="badge" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>
            已设 {defaultCount} 项默认
          </span>
        )}
      </div>

      {grouped.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div style={{ fontSize: 30, opacity: 0.3, marginBottom: 10 }}>⚡</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            {query ? '没有匹配的技能' : '还没有技能'}
          </div>
          {query && (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>换个关键词试试</div>
          )}
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
            {items.map((s) => {
              const isDefault = (settings.defaultSkillIds ?? []).includes(s.id);
              return (
                <div
                  key={s.id}
                  className="card"
                  style={{
                    padding: '12px 14px',
                    opacity: s.enabled ? 1 : 0.5,
                    borderColor: isDefault ? 'var(--accent)' : 'var(--border)',
                    background: isDefault ? 'var(--accent-dim)' : 'var(--bg-2)',
                  }}
                >
                  <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
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
                      {s.icon}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row gap-8" style={{ marginBottom: 3, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</span>
                        <span
                          className="badge"
                          style={{
                            background: s.builtin ? 'var(--bg-3)' : 'var(--purple)',
                            color: s.builtin ? 'var(--text-3)' : '#fff',
                            fontSize: 10,
                            opacity: s.builtin ? 1 : 0.85,
                          }}
                        >
                          {s.builtin ? '内置' : '自定义'}
                        </span>
                        {isDefault && (
                          <span
                            className="badge"
                            style={{ background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10 }}
                          >
                            默认启用
                          </span>
                        )}
                        {!s.enabled && (
                          <span
                            className="badge"
                            style={{ background: 'var(--yellow-dim)', color: 'var(--yellow)', fontSize: 10 }}
                          >
                            已停用
                          </span>
                        )}
                        {(s.steps?.length ?? 0) > 0 && (
                          <span className="dim" style={{ fontSize: 10.5 }}>
                            {s.steps!.length} 个步骤
                          </span>
                        )}
                        {(s.params?.length ?? 0) > 0 && (
                          <span className="dim" style={{ fontSize: 10.5 }}>
                            {s.params!.length} 个参数
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: 11.5, color: 'var(--text-2)', lineHeight: 1.65 }}>
                        {s.description || '（无说明）'}
                      </div>

                      {(s.triggers?.length ?? 0) > 0 && (
                        <div className="row gap-4" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>触发词：</span>
                          {s.triggers!.slice(0, 10).map((t) => (
                            <span
                              key={t}
                              className="mono"
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: 'var(--bg-3)',
                                color: 'var(--text-2)',
                                border: '1px solid var(--border)',
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="row gap-6" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                    <button className="btn btn-xs" onClick={() => setPreview(s)}>
                      查看内容
                    </button>
                    {s.enabled && (
                      <button
                        className={`btn btn-xs ${isDefault ? 'btn-accent' : ''}`}
                        onClick={() => toggleDefault(s)}
                        title="设为默认后，每次任务都会带上这个技能"
                      >
                        {isDefault ? '取消默认' : '设为默认'}
                      </button>
                    )}
                    {s.builtin ? (
                      <button className="btn btn-xs" onClick={() => duplicate(s)}>
                        复制
                      </button>
                    ) : (
                      <button className="btn btn-xs" onClick={() => setEditing(s)}>
                        编辑
                      </button>
                    )}
                    <button className="btn btn-xs" onClick={() => toggleEnabled(s)}>
                      {s.enabled ? '停用' : '启用'}
                    </button>
                    {!s.builtin && (
                      <button
                        className="btn btn-xs btn-ghost"
                        style={{ color: 'var(--red)' }}
                        onClick={() => remove(s)}
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
        <SkillEditor
          skill={editing === 'new' ? undefined : (editing as SkillConfig)}
          onClose={() => setEditing(null)}
          onSaved={refreshAll}
        />
      )}

      {preview && <SkillPreview skill={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

/* ============ 技能内容预览 ============ */

function SkillPreview({ skill, onClose }: { skill: SkillConfig; onClose: () => void }) {
  return (
    <Modal
      title={`技能内容 · ${skill.name}`}
      onClose={onClose}
      width={720}
      footer={<button className="btn" onClick={onClose}>关闭</button>}
    >
      <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.7 }}>
        启用这个技能后，以下内容会作为「专业规范」注入 Agent 的系统提示词，
        引导它按这套步骤和规则来规划命令。
      </div>

      {skill.instructions && (
        <Section title="专业指导">
          <pre className="skill-pre">{skill.instructions}</pre>
        </Section>
      )}

      {(skill.steps?.length ?? 0) > 0 && (
        <Section title={`执行要点（${skill.steps!.length} 步）`}>
          <ol style={{ paddingLeft: 20, margin: 0, fontSize: 12, lineHeight: 1.9, color: 'var(--text-1)' }}>
            {skill.steps!.map((s, i) => (
              <li key={i} style={{ marginBottom: 5 }}>
                {s}
              </li>
            ))}
          </ol>
        </Section>
      )}

      {(skill.riskNotes?.length ?? 0) > 0 && (
        <Section title="风险提示">
          <ul
            style={{
              paddingLeft: 20,
              margin: 0,
              fontSize: 12,
              lineHeight: 1.9,
              color: 'var(--text-1)',
            }}
          >
            {skill.riskNotes!.map((r, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                {r}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(skill.params?.length ?? 0) > 0 && (
        <Section title="参数">
          <div style={{ display: 'grid', gap: 5 }}>
            {skill.params!.map((p) => (
              <div key={p.key} className="row gap-8" style={{ fontSize: 11.5 }}>
                <code className="mono" style={{ color: 'var(--accent)' }}>
                  {`{{${p.key}}}`}
                </code>
                <span style={{ color: 'var(--text-1)' }}>{p.label}</span>
                {p.required && <span style={{ color: 'var(--red)', fontSize: 10 }}>必填</span>}
                {p.placeholder && <span className="dim">{p.placeholder}</span>}
              </div>
            ))}
          </div>
        </Section>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-3)', marginBottom: 7 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

/* ============ 技能编辑器 ============ */

const SKILL_ICONS = ['⚡', '💾', '🌐', '🐳', '🔒', '🧱', '🛡', '⚙', '💿', '📜', '👥', '🟢', '🔍', '🚀', '🧪', '🗄'];

function SkillEditor({
  skill,
  onClose,
  onSaved,
}: {
  skill?: SkillConfig;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<SkillInput>({
    id: skill?.id,
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    icon: skill?.icon ?? '⚡',
    category: skill?.category ?? '自定义',
    instructions: skill?.instructions ?? '',
    steps: skill?.steps ?? [],
    params: skill?.params ?? [],
    triggers: skill?.triggers ?? [],
    riskNotes: skill?.riskNotes ?? [],
    enabled: skill?.enabled ?? true,
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  const set = (k: keyof SkillInput, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError('');
    if (!form.name.trim()) return setError('请填写技能名称');
    if (!form.instructions.trim() && (form.steps ?? []).length === 0) {
      return setError('至少要填「专业指导」或一个「执行要点」，否则这个技能没有内容');
    }
    setSaving(true);
    const r: any = await window.vps.saveSkill(form);
    setSaving(false);
    if (!r.ok) return setError(r.error ?? '保存失败');
    onSaved();
    onClose();
  };

  /** 校验占位符：params 里定义的 key 必须在正文/步骤里被用到，反之亦然 */
  const placeholderWarning = React.useMemo(() => {
    const defined = new Set((form.params ?? []).map((p) => p.key).filter(Boolean));
    const body = [form.instructions, ...(form.steps ?? []), ...(form.riskNotes ?? [])].join('\n');
    const used = new Set<string>();
    for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]);

    const unused = Array.from(defined).filter((k) => !used.has(k));
    const undeclared = Array.from(used).filter((k) => !defined.has(k));
    const msgs: string[] = [];
    if (unused.length) msgs.push(`参数 ${unused.map((k) => `{{${k}}}`).join('、')} 定义了但没在正文中使用`);
    if (undeclared.length)
      msgs.push(`正文里的 ${undeclared.map((k) => `{{${k}}}`).join('、')} 没有对应的参数定义，不会被替换`);
    return msgs;
  }, [form.params, form.instructions, form.steps, form.riskNotes]);

  return (
    <Modal
      title={skill ? `编辑技能 · ${skill.name}` : '新建技能'}
      onClose={onClose}
      width={760}
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
            placeholder="例如：WordPress 站点迁移"
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label className="field-label">分类</label>
          <input value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="自定义" />
        </div>
      </div>

      <div className="field">
        <label className="field-label">图标</label>
        <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
          {SKILL_ICONS.map((ic) => (
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
          placeholder="这个技能解决什么问题"
        />
      </div>

      <ListEditor
        label="触发关键词"
        hint="用户的任务里出现这些词时，Agent 面板会把该技能标记为「推荐」。用逗号分隔。"
        inline
        value={(form.triggers ?? []).join('，')}
        onInlineChange={(v) =>
          set(
            'triggers',
            v
              .split(/[,，]/)
              .map((x) => x.trim())
              .filter(Boolean)
          )
        }
        placeholder="例如：nginx, 反向代理, 站点"
      />

      <div className="field">
        <label className="field-label">专业指导</label>
        <textarea
          rows={9}
          value={form.instructions}
          onChange={(e) => set('instructions', e.target.value)}
          placeholder={`写给模型看的专业判断规则。可以包含：
- 判断顺序（先看什么、再看什么）
- 常见坑与对应现象
- 技术选型倾向

例如：
判断顺序很重要：先用 df 找分区，再用 du 逐层下钻。
df 显示满但 du 加起来对不上，一定是「文件已删除但进程还持有句柄」。`}
          className="mono"
          style={{ fontSize: 12, lineHeight: 1.7 }}
        />
      </div>

      <ListEditor
        label="执行要点"
        hint="会被编号后作为「必须覆盖的要点」注入提示词，防止模型漏掉关键检查点。"
        value={form.steps ?? []}
        onChange={(v) => set('steps', v)}
        placeholder="例如：确认当前磁盘各分区使用率"
      />

      <RiskNotesEditor
        label="风险提示"
        hint="这个技能涉及的高危操作与注意事项，会单独列出以引起模型注意。"
        value={form.riskNotes ?? []}
        onChange={(v) => set('riskNotes', v)}
        placeholder="例如：删日志前先确认服务是否还在写"
      />

      <ParamsEditor
        value={form.params ?? []}
        onChange={(v) => set('params', v)}
        warning={placeholderWarning}
      />

      <label className="row gap-8" style={{ cursor: 'pointer', marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={form.enabled !== false}
          onChange={(e) => set('enabled', e.target.checked)}
          style={{ width: 'auto' }}
        />
        <span style={{ fontSize: 12.5 }}>启用</span>
      </label>

      {error && <div className="field-error">{error}</div>}
    </Modal>
  );
}

/* ============ 通用列表编辑 ============ */

/** 单行文本列表编辑（触发词那种用 inline 模式更紧凑） */
function ListEditor({
  label,
  hint,
  value,
  onChange,
  placeholder,
  inline,
  onInlineChange,
}: {
  label: string;
  hint?: string;
  value: string[] | string;
  onChange?: (v: string[]) => void;
  placeholder?: string;
  inline?: boolean;
  onInlineChange?: (v: string) => void;
}) {
  if (inline) {
    return (
      <div className="field">
        <label className="field-label">{label}</label>
        <input
          value={value as string}
          onChange={(e) => onInlineChange?.(e.target.value)}
          placeholder={placeholder}
        />
        {hint && <div className="field-hint">{hint}</div>}
      </div>
    );
  }

  const items = value as string[];
  return (
    <div className="field">
      <label className="field-label">
        {label}
        <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>
          {items.length} 项
        </span>
      </label>
      <div style={{ display: 'grid', gap: 6 }}>
        {items.map((it, i) => (
          <div key={i} className="row gap-6">
            <span
              className="mono"
              style={{ fontSize: 11, color: 'var(--text-3)', width: 18, textAlign: 'right', flexShrink: 0 }}
            >
              {i + 1}.
            </span>
            <input
              value={it}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange?.(next);
              }}
              placeholder={placeholder}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-xs btn-ghost"
              style={{ color: 'var(--red)', flexShrink: 0 }}
              onClick={() => onChange?.(items.filter((_, j) => j !== i))}
              title="删除这一项"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="btn btn-sm"
          style={{ justifySelf: 'start' }}
          onClick={() => onChange?.([...items, ''])}
        >
          + 添加一项
        </button>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function RiskNotesEditor({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="field">
      <label className="field-label">
        {label}
        <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>
          {value.length} 项
        </span>
      </label>
      <div style={{ display: 'grid', gap: 6 }}>
        {value.map((it, i) => (
          <div key={i} className="row gap-6" style={{ alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--orange)', fontSize: 13, flexShrink: 0, marginTop: 8 }}>⚠</span>
            <textarea
              rows={2}
              value={it}
              onChange={(e) => {
                const next = [...value];
                next[i] = e.target.value;
                onChange(next);
              }}
              placeholder={placeholder}
              style={{ flex: 1, fontSize: 12 }}
            />
            <button
              className="btn btn-xs btn-ghost"
              style={{ color: 'var(--red)', flexShrink: 0 }}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="btn btn-sm" style={{ justifySelf: 'start' }} onClick={() => onChange([...value, ''])}>
          + 添加风险提示
        </button>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/* ============ 参数编辑 ============ */

function ParamsEditor({
  value,
  onChange,
  warning,
}: {
  value: SkillParam[];
  onChange: (v: SkillParam[]) => void;
  warning: string[];
}) {
  const patch = (i: number, p: Partial<SkillParam>) => {
    const next = [...value];
    next[i] = { ...next[i], ...p };
    onChange(next);
  };

  return (
    <div className="field">
      <label className="field-label">
        参数
        <span className="dim" style={{ fontWeight: 400, marginLeft: 6 }}>
          {value.length} 个
        </span>
      </label>
      <div className="field-hint" style={{ marginTop: 0, marginBottom: 8 }}>
        定义参数后，在 Agent 面板启用该技能时可以填值；正文里用{' '}
        <code className="mono">{'{{参数名}}'}</code> 引用。适合域名、端口、路径这类每次不同的信息。
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {value.map((p, i) => (
          <div
            key={i}
            style={{
              padding: 10,
              borderRadius: 6,
              background: 'var(--bg-3)',
              border: '1px solid var(--border)',
            }}
          >
            <div className="row gap-6" style={{ marginBottom: 6 }}>
              <input
                value={p.key}
                onChange={(e) => patch(i, { key: e.target.value.replace(/[^\w]/g, '') })}
                placeholder="key（英文，如 domain）"
                className="mono"
                style={{ flex: 1, fontSize: 11.5 }}
              />
              <input
                value={p.label}
                onChange={(e) => patch(i, { label: e.target.value })}
                placeholder="显示名（如 域名）"
                style={{ flex: 1, fontSize: 11.5 }}
              />
              <button
                className="btn btn-xs btn-ghost"
                style={{ color: 'var(--red)', flexShrink: 0 }}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            <div className="row gap-6">
              <input
                value={p.placeholder ?? ''}
                onChange={(e) => patch(i, { placeholder: e.target.value })}
                placeholder="输入框提示语"
                style={{ flex: 2, fontSize: 11.5 }}
              />
              <label className="row gap-4" style={{ cursor: 'pointer', flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={!!p.required}
                  onChange={(e) => patch(i, { required: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                <span style={{ fontSize: 11.5 }}>必填</span>
              </label>
            </div>
          </div>
        ))}
        <button
          className="btn btn-sm"
          style={{ justifySelf: 'start' }}
          onClick={() => onChange([...value, { key: '', label: '', placeholder: '', required: false }])}
        >
          + 添加参数
        </button>
      </div>

      {warning.length > 0 && (
        <div
          style={{
            marginTop: 8,
            padding: '7px 10px',
            borderRadius: 6,
            background: 'var(--yellow-dim)',
            fontSize: 11.5,
            lineHeight: 1.7,
            color: 'var(--text-1)',
          }}
        >
          {warning.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

import React from 'react';
import type {
  AgentEvent,
  AgentPhase,
  AgentProfile,
  ApprovalMode,
  ExpertConfig,
  HostConfig,
  PlanStep,
  RiskAssessment,
  SkillConfig,
} from '@shared/types';
import { RiskBadge, Modal } from './ui';
import { useStore, refreshExperts, refreshSkills } from '../store';

/**
 * Agent 面板 —— 自然语言驱动 VPS 运维
 *
 * 交互流程：
 * 1. 选专家（决定用谁的脑子）+ 选技能（补充专业配方）
 * 2. 用户输入任务（自然语言）
 * 3. 模型生成结构化计划（步骤 + 命令 + 白话解释 + 风险等级 + 回滚方式）
 * 4. 按审批模式决定：逐步确认 / 整单确认 / 只读自动放行
 * 5. 执行，实时流式回显输出
 * 6. 汇总报告
 */

interface StepView extends PlanStep {}

/** 面板里对技能的临时选择状态（如果技能带参数，还要记参数值） */
interface SkillPick {
  skillId: string;
  values: Record<string, string>;
}

export function AgentPanel({ host, connected }: { host: HostConfig; connected: boolean }) {
  const experts = useStore((s) => s.experts);
  const skills = useStore((s) => s.skills);
  const settings = useStore((s) => s.settings);

  const [task, setTask] = React.useState('');
  const [approvalMode, setApprovalMode] = React.useState<ApprovalMode>(
    settings.defaultApprovalMode ?? 'auto_readonly'
  );
  const [phase, setPhase] = React.useState<AgentPhase>('idle');
  const [steps, setSteps] = React.useState<StepView[]>([]);
  const [summary, setSummary] = React.useState('');
  const [thinking, setThinking] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [runId, setRunId] = React.useState<string | null>(null);
  const [pendingStepId, setPendingStepId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [editing, setEditing] = React.useState<Record<string, string>>({});
  const [hasModel, setHasModel] = React.useState(true);
  const [profile, setProfile] = React.useState<AgentProfile | null>(null);

  /* 专家与技能的选择状态 */
  const [expertId, setExpertId] = React.useState<string | null>(settings.defaultExpertId ?? 'expert_general');
  const [picked, setPicked] = React.useState<SkillPick[]>([]);
  const [picksInitialized, setPicksInitialized] = React.useState(false);
  const [showPicker, setShowPicker] = React.useState(false);
  const [recommended, setRecommended] = React.useState<{ id: string; name: string; matched: string[] }[]>([]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  // 用户上翻查看历史输出时，不要用自动滚动强行把 TA 拉回底部；
  // 只有当滚动位置停在底部附近（48px 内）时才跟随新输出。
  const stickToBottom = React.useRef(true);
  const onScrollList = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // 首次拿到列表时，把「设为默认」的技能预勾选上
  React.useEffect(() => {
    if (picksInitialized) return;
    if (skills.length === 0) return;
    const defs = settings.defaultSkillIds ?? [];
    setPicked(
      defs
        .filter((id) => skills.some((s) => s.id === id && s.enabled))
        .map((id) => ({ skillId: id, values: {} }))
    );
    setPicksInitialized(true);
  }, [skills, settings.defaultSkillIds, picksInitialized]);

  // 设置里的默认专家变化时同步（例如用户在设置页改了默认）
  React.useEffect(() => {
    if (phase === 'idle') {
      setExpertId(settings.defaultExpertId ?? 'expert_general');
    }
    // 只在空闲时跟随，避免运行中把用户的选择冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.defaultExpertId]);

  // 检查是否配置了模型
  React.useEffect(() => {
    window.vps.listModels().then((r: any) => {
      setHasModel(r?.ok && r.data?.length > 0);
    });
  }, [phase]);

  // 订阅 Agent 事件
  React.useEffect(() => {
    const off = window.vps.onAgentEvent((e: AgentEvent) => {
      switch (e.type) {
        case 'phase':
          setPhase(e.phase);
          if (e.phase === 'awaiting_approval') setThinking((t) => [...t, '等待你的确认…']);
          break;
        case 'profile':
          setProfile(e.profile);
          break;
        case 'thinking':
          setThinking((t) => [...t, e.text]);
          break;
        case 'plan':
          setSteps(e.steps);
          break;
        case 'step_start':
          setPendingStepId(null);
          setSteps((s) => s.map((x) => (x.id === e.stepId ? { ...x, status: 'running' } : x)));
          setExpanded((x) => ({ ...x, [e.stepId]: true }));
          break;
        case 'step_output':
          setSteps((s) =>
            s.map((x) => (x.id === e.stepId ? { ...x, output: (x.output ?? '') + e.chunk } : x))
          );
          break;
        case 'step_done':
          setSteps((s) =>
            s.map((x) =>
              x.id === e.stepId
                ? { ...x, status: e.status, exitCode: e.exitCode, error: e.error }
                : x
            )
          );
          break;
        case 'summary':
          setSummary(e.summary);
          break;
        case 'error':
          setError(e.error);
          break;
      }
    });
    return off;
  }, []);

  // 需要在 awaiting_approval 时找出当前待批步骤
  React.useEffect(() => {
    if (phase === 'awaiting_approval') {
      const p = steps.find((s) => s.status === 'pending');
      if (p) setPendingStepId(p.id);
    }
  }, [phase, steps]);

  // 自动滚动：仅当用户停在底部附近时跟随新输出（见 stickToBottom）
  React.useEffect(() => {
    if (stickToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [steps, summary, thinking]);

  // 任务描述变化时，拉一次技能推荐（防抖，避免每敲一个字都请求）
  React.useEffect(() => {
    const t = setTimeout(async () => {
      if (!task.trim() || task.trim().length < 4) {
        setRecommended([]);
        return;
      }
      const r: any = await window.vps.recommendSkills(task);
      if (r?.ok) {
        const pickedIds = new Set(picked.map((p) => p.skillId));
        setRecommended((r.data as any[]).filter((x) => !pickedIds.has(x.id)));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [task, picked]);

  const reset = () => {
    setSteps([]);
    setSummary('');
    setThinking([]);
    setError('');
    setRunId(null);
    setPhase('idle');
    setPendingStepId(null);
    setProfile(null);
  };

  const start = async () => {
    if (!task.trim() || !connected) return;
    reset();
    const r: any = await window.vps.agentRun({
      hostId: host.id,
      task: task.trim(),
      approvalMode,
      expertId,
      skills: picked.map((p) => ({ skillId: p.skillId, values: p.values })),
    });
    if (!r.ok) {
      setError(r.error ?? '启动失败');
      return;
    }
    setRunId(r.data.runId);
  };

  const decide = async (stepId: string, approved: boolean) => {
    if (!runId) return;
    const edited = editing[stepId];
    const step = steps.find((s) => s.id === stepId);
    const editedCommand = edited && edited !== step?.command ? edited : undefined;
    await window.vps.agentDecide(runId, stepId, { approved, editedCommand });
    setPendingStepId(null);
    setEditing((e) => {
      const n = { ...e };
      delete n[stepId];
      return n;
    });
  };

  const abort = async () => {
    if (runId) await window.vps.agentAbort(runId);
  };

  const toggleSkill = (id: string) => {
    setPicked((p) =>
      p.some((x) => x.skillId === id) ? p.filter((x) => x.skillId !== id) : [...p, { skillId: id, values: {} }]
    );
  };

  const setSkillValue = (id: string, key: string, value: string) => {
    setPicked((p) => p.map((x) => (x.skillId === id ? { ...x, values: { ...x.values, [key]: value } } : x)));
  };

  const busy = phase === 'planning' || phase === 'executing' || phase === 'summarizing';

  const currentExpert = experts.find((e) => e.id === expertId) ?? null;
  const pickedSkills = picked
    .map((p) => ({ pick: p, skill: skills.find((s) => s.id === p.skillId) }))
    .filter((x): x is { pick: SkillPick; skill: SkillConfig } => !!x.skill);
  // 技能里定义了参数但还没填的，会提示用户
  const missingParams = pickedSkills.filter(({ pick, skill }) =>
    (skill.params ?? []).some((p) => p.required && !pick.values[p.key]?.trim())
  );

  // 必填参数没填完不允许启动：占位符会原样保留进计划（renderTemplate 保留 {{key}}），
  // 生成的命令大概率跑不通 —— 与其让用户批准一条废命令，不如先在入口拦下
  const canStart = connected && task.trim().length > 0 && !busy && missingParams.length === 0;

  const phaseMeta: Record<AgentPhase, { label: string; color: string }> = {
    idle: { label: '待命', color: 'var(--text-3)' },
    planning: { label: '规划中', color: 'var(--yellow)' },
    awaiting_approval: { label: '等待确认', color: 'var(--orange)' },
    executing: { label: '执行中', color: 'var(--accent)' },
    summarizing: { label: '汇总中', color: 'var(--purple)' },
    done: { label: '已完成', color: 'var(--green)' },
    error: { label: '出错', color: 'var(--red)' },
    aborted: { label: '已中止', color: 'var(--text-3)' },
  };

  const pm = phaseMeta[phase];

  if (!hasModel) {
    return (
      <div className="empty" style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 34, opacity: 0.35 }}>⚙</div>
        <div className="empty-title">还没有配置模型</div>
        <div style={{ fontSize: 12.5, maxWidth: 380 }}>
          Agent 需要一个 LLM 来理解你的需求并生成执行计划。请到「设置」页添加一个模型
          （支持 DeepSeek、OpenAI、Kimi、通义千问、Ollama 本地模型等）。
        </div>
      </div>
    );
  }

  return (
    // flex: 1 + minWidth: 0 —— 标签页容器是 flex row，没有这两项面板会收缩成内容宽度
    <div className="col" style={{ height: '100%', flex: 1, minWidth: 0 }}>
      {/* 顶部：人设 + 任务输入 */}
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {/* 专家选择 */}
        <div className="row gap-8" style={{ marginBottom: 8 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)', flexShrink: 0 }}>专家</span>
          <select
            value={expertId ?? ''}
            onChange={(e) => setExpertId(e.target.value || null)}
            disabled={busy}
            style={{ flex: 1, maxWidth: 320, padding: '3px 8px', fontSize: 11.5 }}
            title={currentExpert?.description ?? ''}
          >
            {experts
              .filter((e) => e.enabled)
              .map((e: ExpertConfig) => (
                <option key={e.id} value={e.id}>
                  {e.icon} {e.name}
                </option>
              ))}
          </select>
          <div className="flex-1" />
          <div className="row gap-6">
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: pm.color, display: 'inline-block' }} />
            <span style={{ fontSize: 11.5, color: pm.color, fontWeight: 600 }}>{pm.label}</span>
          </div>
          <select
            value={approvalMode}
            onChange={(e) => setApprovalMode(e.target.value as ApprovalMode)}
            style={{ width: 'auto', padding: '3px 8px', fontSize: 11.5 }}
            title="审批模式"
            disabled={busy}
          >
            <option value="auto_readonly">只读自动放行，写操作需确认</option>
            <option value="every_step">每步都需我确认</option>
            <option value="plan_once">批准计划后自动执行</option>
          </select>
        </div>

        {/* 技能选择区 */}
        <div className="row gap-8" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)', flexShrink: 0 }}>技能</span>
          {pickedSkills.length === 0 && (
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>未启用（Agent 将按通用方法处理）</span>
          )}
          {pickedSkills.map(({ pick, skill }) => (
            <span
              key={skill.id}
              className="row gap-4"
              style={{
                padding: '2px 8px',
                borderRadius: 10,
                background: 'var(--accent-dim)',
                color: 'var(--accent)',
                fontSize: 11,
                border: '1px solid var(--accent-border)',
              }}
            >
              {skill.icon} {skill.name}
              <button
                onClick={() => toggleSkill(skill.id)}
                disabled={busy}
                style={{ color: 'inherit', opacity: 0.7, fontSize: 11, padding: '0 2px' }}
                title="移除"
              >
                ✕
              </button>
            </span>
          ))}
          <button className="btn btn-xs" onClick={() => setShowPicker(true)} disabled={busy}>
            + 选择技能
          </button>
        </div>

        {/* 已启用技能带参数时，就地填值 */}
        {pickedSkills.some(({ skill }) => (skill.params?.length ?? 0) > 0) && (
          <div
            style={{
              marginBottom: 8,
              padding: '8px 10px',
              borderRadius: 6,
              background: 'var(--bg-3)',
              border: '1px solid var(--border)',
            }}
          >
            {pickedSkills.map(({ pick, skill }) =>
              (skill.params?.length ?? 0) === 0 ? null : (
                <div key={skill.id} style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginBottom: 4 }}>
                    {skill.icon} {skill.name} · 参数
                  </div>
                  <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                    {(skill.params ?? []).map((p) => (
                      <div key={p.key} className="row gap-4" style={{ flex: '1 1 200px', minWidth: 160 }}>
                        <span
                          style={{
                            fontSize: 10.5,
                            color: p.required && !pick.values[p.key]?.trim() ? 'var(--orange)' : 'var(--text-2)',
                            flexShrink: 0,
                          }}
                        >
                          {p.label}
                          {p.required ? ' *' : ''}
                        </span>
                        <input
                          value={pick.values[p.key] ?? ''}
                          onChange={(e) => setSkillValue(skill.id, p.key, e.target.value)}
                          placeholder={p.placeholder}
                          disabled={busy}
                          className="mono"
                          style={{ flex: 1, fontSize: 11, padding: '3px 7px', minWidth: 0 }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        )}

        {/* 推荐技能 */}
        {recommended.length > 0 && !busy && (
          <div className="row gap-6" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, color: 'var(--yellow)', flexShrink: 0 }}>推荐：</span>
            {recommended.slice(0, 4).map((r) => (
              <button
                key={r.id}
                className="btn btn-xs"
                onClick={() => toggleSkill(r.id)}
                style={{ borderColor: 'rgba(210,153,34,0.4)', color: 'var(--yellow)' }}
                title={`匹配到关键词：${r.matched.join('、')}`}
              >
                + {r.name}
              </button>
            ))}
          </div>
        )}

        <textarea
          rows={3}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              start();
            }
          }}
          placeholder={
            connected
              ? '用自然语言描述你要做的事，例如：\n在 /www/wwwroot 下部署一个 Nginx 静态站点，并配置反向代理到 3000 端口'
              : '请先连接到一台服务器'
          }
          disabled={!connected || busy}
          style={{ fontSize: 12.5, marginBottom: 8 }}
        />

        <div className="row gap-8">
          <button
            className="btn btn-primary"
            onClick={start}
            disabled={!canStart}
            style={{ flex: 1 }}
            title={
              missingParams.length > 0
                ? '请先填完技能的必填参数'
                : !connected
                  ? '请先连接到服务器'
                  : undefined
            }
          >
            {busy ? (
              <>
                <span className="spinner" /> 执行中…
              </>
            ) : missingParams.length > 0 ? (
              `还有 ${missingParams.length} 个必填参数未填`
            ) : (
              '生成计划并执行'
            )}
          </button>
          {busy && (
            <button className="btn btn-danger" onClick={abort}>
              中止
            </button>
          )}
          {(phase === 'done' || phase === 'error' || phase === 'aborted') && (
            <button className="btn" onClick={reset}>
              清空
            </button>
          )}
        </div>
        <div className="field-hint" style={{ marginTop: 6 }}>
          Ctrl + Enter 快速提交 · Agent 生成的每条命令都会经过安全检查和你的授权
          {missingParams.length > 0 && (
            <span style={{ color: 'var(--orange)' }}>
              {' '}
              · 还有 {missingParams.length} 个技能参数没填
            </span>
          )}
        </div>
      </div>

      {/* 中间：步骤列表 */}
      <div ref={scrollRef} onScroll={onScrollList} className="scroll-panel" style={{ padding: 12 }}>
        {/* 本次使用的人设（运行时显示，便于追溯） */}
        {profile && (
          <div
            className="row gap-8"
            style={{
              marginBottom: 10,
              padding: '6px 10px',
              borderRadius: 6,
              background: 'var(--bg-3)',
              border: '1px solid var(--border)',
              fontSize: 11,
              color: 'var(--text-2)',
              flexWrap: 'wrap',
            }}
          >
            <span>
              专家：<strong style={{ color: 'var(--text-1)' }}>{profile.expertName}</strong>
            </span>
            {profile.skillNames.length > 0 && (
              <span>
                技能：<strong style={{ color: 'var(--text-1)' }}>{profile.skillNames.join('、')}</strong>
              </span>
            )}
          </div>
        )}

        {steps.length === 0 && !error && (
          <div style={{ padding: '50px 20px', textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
            <div style={{ fontSize: 30, opacity: 0.3, marginBottom: 12 }}>Agent</div>
            <div style={{ marginBottom: 6, color: 'var(--text-2)', fontWeight: 600 }}>
              描述你的目标，我来规划并执行
            </div>
            <div style={{ lineHeight: 1.9 }}>
              例如：
              <br />
              · 帮我搭建一个 Nginx + Node.js 的网站环境
              <br />
              · 检查服务器磁盘和内存使用情况，找出占用最大的目录
              <br />
              · 安装 Docker 并把我的应用跑起来
              <br />· 排查为什么 80 端口访问不了
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 12,
              background: 'var(--red-dim)',
              border: '1px solid rgba(248,81,73,0.3)',
              borderRadius: 8,
              color: 'var(--red)',
              fontSize: 12.5,
              marginBottom: 12,
            }}
          >
            <strong>出错了：</strong>
            {error}
          </div>
        )}

        {steps.map((s) => (
          <StepCard
            key={s.id}
            step={s}
            isPending={pendingStepId === s.id}
            expanded={!!expanded[s.id]}
            onToggle={() => setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))}
            editValue={editing[s.id]}
            onEditChange={(v) => setEditing((e) => ({ ...e, [s.id]: v }))}
            onApprove={() => decide(s.id, true)}
            onReject={() => decide(s.id, false)}
          />
        ))}

        {thinking.length > 0 && (
          <div style={{ marginTop: 8, paddingLeft: 4 }}>
            {thinking.slice(-3).map((t, i) => (
              <div key={i} style={{ fontSize: 11.5, color: 'var(--text-3)', marginBottom: 2 }}>
                <span style={{ opacity: 0.6 }}>·</span> {t}
              </div>
            ))}
          </div>
        )}

        {summary && (
          <div
            style={{
              marginTop: 14,
              padding: 14,
              background: 'var(--bg-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              borderLeft: '3px solid var(--green)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 12.5, color: 'var(--green)' }}>
              执行总结
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.8, whiteSpace: 'pre-wrap', color: 'var(--text-1)' }}>
              {summary}
            </div>
          </div>
        )}
      </div>

      {/* 技能选择弹窗 */}
      {showPicker && (
        <SkillPicker
          skills={skills}
          picked={picked}
          onToggle={toggleSkill}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

/* ============ 技能选择弹窗 ============ */

function SkillPicker({
  skills,
  picked,
  onToggle,
  onClose,
}: {
  skills: SkillConfig[];
  picked: SkillPick[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const pickedIds = new Set(picked.map((p) => p.skillId));

  const enabled = skills.filter((s) => s.enabled);
  const q = query.trim().toLowerCase();
  const list = q
    ? enabled.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          (s.triggers ?? []).some((t) => t.toLowerCase().includes(q))
      )
    : enabled;

  // 按分类分组
  const grouped = new Map<string, SkillConfig[]>();
  for (const s of list) {
    const arr = grouped.get(s.category) ?? [];
    arr.push(s);
    grouped.set(s.category, arr);
  }

  return (
    <Modal
      title="选择技能"
      onClose={onClose}
      width={640}
      footer={
        <>
          <span style={{ fontSize: 11.5, color: 'var(--text-3)', alignSelf: 'center' }}>
            已选 {picked.length} 项
          </span>
          <div className="flex-1" />
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索技能…"
        style={{ marginBottom: 12 }}
      />

      {list.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', fontSize: 12.5, color: 'var(--text-3)' }}>
          {enabled.length === 0
            ? '还没有启用的技能 —— 可以到「设置 → 技能」里创建，或启用内置技能'
            : '没有匹配的技能'}
        </div>
      )}

      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {Array.from(grouped.entries()).map(([category, items]) => (
          <div key={category} style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: 'var(--text-3)',
                letterSpacing: '0.5px',
                marginBottom: 6,
                textTransform: 'uppercase',
              }}
            >
              {category}
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {items.map((s) => {
                const on = pickedIds.has(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => onToggle(s.id)}
                    className={`picker-item${on ? ' picker-item-on' : ''}`}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      textAlign: 'left',
                      padding: '9px 11px',
                      borderRadius: 6,
                    }}
                  >
                    <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{s.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row gap-6" style={{ marginBottom: 2 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-0)' }}>
                          {s.name}
                        </span>
                        {(s.steps?.length ?? 0) > 0 && (
                          <span className="dim" style={{ fontSize: 10 }}>
                            {s.steps!.length} 步
                          </span>
                        )}
                        {(s.params?.length ?? 0) > 0 && (
                          <span className="dim" style={{ fontSize: 10 }}>
                            {s.params!.length} 参数
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.6 }}>
                        {s.description}
                      </div>
                    </div>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 13,
                        color: on ? 'var(--accent)' : 'var(--text-3)',
                        marginTop: 2,
                      }}
                    >
                      {on ? '✓' : '+'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** 单个步骤卡片 */
function StepCard({
  step,
  isPending,
  expanded,
  onToggle,
  editValue,
  onEditChange,
  onApprove,
  onReject,
}: {
  step: StepView;
  isPending: boolean;
  expanded: boolean;
  onToggle: () => void;
  editValue: string | undefined;
  onEditChange: (v: string) => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const statusMeta = {
    pending: { icon: '○', color: 'var(--text-3)', text: '待执行' },
    running: { icon: '◐', color: 'var(--accent)', text: '执行中' },
    success: { icon: '✓', color: 'var(--green)', text: '成功' },
    failed: { icon: '✗', color: 'var(--red)', text: '失败' },
    rejected: { icon: '⊘', color: 'var(--orange)', text: '已拒绝' },
    skipped: { icon: '—', color: 'var(--text-3)', text: '跳过' },
  }[step.status];

  const [localEdit, setLocalEdit] = React.useState<string | null>(null);
  const currentCmd = localEdit ?? editValue ?? step.command;

  const borderColor = isPending
    ? step.risk.level === 'critical'
      ? 'var(--red)'
      : 'var(--orange)'
    : step.status === 'running'
      ? 'var(--accent)'
      : step.status === 'failed'
        ? 'rgba(248,81,73,0.4)'
        : step.status === 'success'
          ? 'var(--ok-border)'
          : 'var(--border)';

  return (
    <div
      style={{
        marginBottom: 10,
        background: 'var(--bg-2)',
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        overflow: 'hidden',
        transition: 'border-color 0.2s',
      }}
    >
      {/* 头部 */}
      <div
        onClick={onToggle}
        style={{
          padding: '9px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          background: isPending ? 'rgba(210,153,34,0.07)' : 'transparent',
        }}
      >
        <span
          style={{ color: statusMeta.color, fontSize: 13, width: 14, textAlign: 'center' }}
          className={step.status === 'running' ? 'pulsing' : ''}
        >
          {statusMeta.icon}
        </span>
        <span className="dim mono" style={{ fontSize: 11, flexShrink: 0 }}>
          {step.index}.
        </span>
        <span className="truncate" style={{ flex: 1, fontSize: 12.5, fontWeight: 500 }}>
          {step.description}
        </span>
        <RiskBadge level={step.risk.level} small />
        {step.exitCode !== null && step.exitCode !== undefined && (
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: step.exitCode === 0 ? 'var(--green)' : 'var(--red)',
              flexShrink: 0,
            }}
          >
            exit {step.exitCode}
          </span>
        )}
        <span className="dim" style={{ fontSize: 10, flexShrink: 0 }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border-light)' }}>
          {/* 风险提示 */}
          {step.risk.reasons.length > 0 && step.risk.level !== 'safe' && (
            <div
              style={{
                marginTop: 10,
                padding: '7px 10px',
                background: step.risk.blocked ? 'var(--red-dim)' : 'var(--yellow-dim)',
                borderRadius: 6,
                fontSize: 11.5,
                lineHeight: 1.7,
                color: step.risk.level === 'critical' ? 'var(--red)' : 'var(--text-1)',
              }}
            >
              <strong>{step.risk.blocked ? '⛔ 已被安全策略禁止执行：' : '⚠ 风险提示：'}</strong>
              {step.risk.reasons.join('；')}
            </div>
          )}

          {/* 白话解释 */}
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.75 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>这条命令会做什么：</span>
            <br />
            {step.explanation}
          </div>

          {/* 命令 */}
          <div style={{ marginTop: 10 }}>
            <div
              style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4, fontWeight: 600 }}
            >
              命令 {isPending && '（你可以直接修改后再批准）'}
            </div>
            {isPending && !step.risk.blocked ? (
              <textarea
                rows={Math.min(6, Math.max(2, currentCmd.split('\n').length))}
                value={currentCmd}
                onChange={(e) => {
                  setLocalEdit(e.target.value);
                  onEditChange(e.target.value);
                }}
                className="mono"
                style={{ fontSize: 12 }}
              />
            ) : (
              <pre
                className="mono"
                style={{
                  background: 'var(--bg-0)',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  margin: 0,
                  color: step.risk.level === 'critical' ? 'var(--red)' : 'var(--text-0)',
                }}
              >
                $ {step.command}
              </pre>
            )}
          </div>

          {/*
            回滚方式。
            只对「改动了系统」的步骤显示 —— 纯查询命令给出回滚没有意义，
            反而会稀释真正需要注意的地方。
          */}
          {step.rollback && step.risk.isWrite && (
            <div style={{ marginTop: 10 }}>
              <div
                style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4, fontWeight: 600 }}
              >
                出问题怎么退回去
              </div>
              <pre
                className="mono"
                style={{
                  background: 'rgba(240,136,62,0.06)',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid rgba(240,136,62,0.25)',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  margin: 0,
                  fontSize: 11.5,
                  color: 'var(--text-1)',
                }}
              >
                {step.rollback}
              </pre>
            </div>
          )}

          {/* 执行输出 */}
          {step.output && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4, fontWeight: 600 }}>
                输出
              </div>
              <pre
                className="mono"
                style={{
                  background: '#010409',
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  maxHeight: 320,
                  overflowY: 'auto', overscrollBehavior: 'contain',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  margin: 0,
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  color: 'var(--text-1)',
                }}
              >
                {step.output}
              </pre>
            </div>
          )}

          {step.error && !step.output && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{step.error}</div>
          )}

          {/* 审批按钮 */}
          {isPending && (
            <div className="row gap-8" style={{ marginTop: 12 }}>
              {step.risk.blocked ? (
                <button className="btn" onClick={onReject} style={{ flex: 1 }}>
                  跳过这一步
                </button>
              ) : (
                <>
                  <button className="btn btn-primary" onClick={onApprove} style={{ flex: 1 }}>
                    ✓ 批准执行
                  </button>
                  <button className="btn" onClick={onReject} style={{ flex: 1 }}>
                    ✕ 拒绝
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

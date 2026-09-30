import type {
  AgentProfile,
  ExpertConfig,
  ExpertInput,
  SkillConfig,
  SkillInput,
} from '@shared/types';
import { BUILTIN_EXPERTS, BUILTIN_SKILLS } from '@shared/experts';

/**
 * 专家与技能注册表
 *
 * 设计要点：
 *  - 内置（builtin）= 模板，存在代码里，用户不能改也不能删，但可以「关掉」或「复制成自定义」
 *  - 自定义 = 用户建的，存在 store.json 里，完全可改可删
 *  - 最终对外暴露的列表 = 内置（去掉被禁用的）+ 自定义
 *
 * 为什么要区分这两种：内置专家/技能会随版本升级改进，如果允许直接编辑，
 * 用户改过的版本会覆盖升级带来的改进。用「复制成自定义」的方式，
 * 既保住了用户的定制，又能拿到新版本的内置内容。
 */

/**
 * 读取设置的注入点。
 *
 * 正常运行时由 db 模块注入（见下方 setSettingsProvider）。
 * 之所以不直接 import db，是为了让这个模块可以在纯 Node 环境下被测试 ——
 * db 依赖 electron 的 app.getPath，在测试里跑不起来。
 */
type SettingsProvider = () => {
  disabledExpertIds?: string[];
  disabledSkillIds?: string[];
  defaultExpertId?: string | null;
  defaultSkillIds?: string[];
};

let settingsProvider: SettingsProvider = () => ({});

export function setSettingsProvider(fn: SettingsProvider): void {
  settingsProvider = fn;
}

function readSettings() {
  try {
    return settingsProvider() ?? {};
  } catch {
    // 还没初始化（例如测试环境）时降级为空设置，不影响内置库可用性
    return {};
  }
}

/** 内置专家 + 用户自定义专家，已应用启用状态 */
export function listExperts(custom: ExpertConfig[]): ExpertConfig[] {
  const off = new Set(readSettings().disabledExpertIds ?? []);
  const builtins = BUILTIN_EXPERTS.map((e) => ({ ...e, enabled: !off.has(e.id) }));
  const mine = custom.filter((e) => !e.builtin);
  return [...builtins, ...mine];
}

/** 内置技能 + 用户自定义技能，已应用启用状态 */
export function listSkills(custom: SkillConfig[]): SkillConfig[] {
  const off = new Set(readSettings().disabledSkillIds ?? []);
  const builtins = BUILTIN_SKILLS.map((s) => ({ ...s, enabled: !off.has(s.id) }));
  const mine = custom.filter((s) => !s.builtin);
  return [...builtins, ...mine];
}

export function findExpert(custom: ExpertConfig[], id: string | null | undefined): ExpertConfig | null {
  if (!id) return null;
  return listExperts(custom).find((e) => e.id === id) ?? null;
}

export function findSkill(custom: SkillConfig[], id: string): SkillConfig | null {
  return listSkills(custom).find((s) => s.id === id) ?? null;
}

/** 把输入规范成一条可落盘的专家记录 */
export function normalizeExpertInput(input: ExpertInput, existing?: ExpertConfig | null): ExpertConfig {
  return {
    id: input.id ?? existing?.id ?? '',
    name: (input.name ?? '').trim() || '未命名专家',
    description: (input.description ?? '').trim(),
    icon: (input.icon ?? '').trim() || '🧩',
    category: (input.category ?? '').trim() || '自定义',
    prompt: (input.prompt ?? '').trim(),
    suggestedApprovalMode: input.suggestedApprovalMode ?? existing?.suggestedApprovalMode,
    builtin: false,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

export function normalizeSkillInput(input: SkillInput, existing?: SkillConfig | null): SkillConfig {
  return {
    id: input.id ?? existing?.id ?? '',
    name: (input.name ?? '').trim() || '未命名技能',
    description: (input.description ?? '').trim(),
    icon: (input.icon ?? '').trim() || '⚡',
    category: (input.category ?? '').trim() || '自定义',
    instructions: (input.instructions ?? '').trim(),
    steps: (input.steps ?? existing?.steps ?? []).map((s) => String(s).trim()).filter(Boolean),
    params: (input.params ?? existing?.params ?? []).map((p) => ({
      key: String(p.key ?? '').trim(),
      label: String(p.label ?? '').trim(),
      placeholder: p.placeholder?.trim(),
      required: !!p.required,
      defaultValue: p.defaultValue,
    })).filter((p) => p.key && p.label),
    triggers: (input.triggers ?? existing?.triggers ?? []).map((t) => String(t).trim()).filter(Boolean),
    riskNotes: (input.riskNotes ?? existing?.riskNotes ?? []).map((r) => String(r).trim()).filter(Boolean),
    builtin: false,
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

/* ============ 技能参数渲染 ============ */

/**
 * 把技能里的 {{key}} 占位符替换成用户填的值。
 * 没填的必填项保持原样（用方括号标出来，让用户知道还缺东西）。
 */
export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const v = values[key];
    if (v === undefined || v === '') return whole;
    return v;
  });
}

/** 用一组参数值把技能渲染成可直接拼进提示词的文本 */
export function renderSkill(skill: SkillConfig, values: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`### 技能：${skill.name}`);
  if (skill.description) lines.push(skill.description);

  if (skill.instructions) {
    lines.push('');
    lines.push(renderTemplate(skill.instructions, values));
  }

  if (skill.steps && skill.steps.length > 0) {
    lines.push('');
    lines.push('执行时请覆盖以下要点（顺序可按实际情况调整，但不要遗漏）：');
    skill.steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${renderTemplate(s, values)}`);
    });
  }

  if (skill.riskNotes && skill.riskNotes.length > 0) {
    lines.push('');
    lines.push('特别注意：');
    skill.riskNotes.forEach((r) => lines.push(`- ${renderTemplate(r, values)}`));
  }

  return lines.join('\n');
}

/* ============ 提示词拼装 ============ */

/**
 * 组装系统提示词。
 *
 * 拼接顺序（越靠后约束力越强，这是模型的注意力分布决定的）：
 *   1. 基础工程师提示词（PLAN_SYSTEM_PROMPT，包含 JSON 输出格式的硬要求）
 *   2. 专家人格（改变"谁来干"）
 *   3. 技能配方（补充"怎么干"）
 *   4. 用户自定义的额外要求
 *
 * 注意：JSON 格式要求放在最前面而不是最后面 —— 它在基础提示词里已经
 * 用「必须输出严格的 JSON」这种强指令写了，专家/技能不该覆盖它，
 * 所以专家提示词里要显式重申"仍然遵守上面的 JSON 输出格式"。
 */
export function composeSystemPrompt(opts: {
  basePrompt: string;
  expert: ExpertConfig | null;
  skills: { skill: SkillConfig; values: Record<string, string> }[];
  extraInstructions?: string;
}): string {
  const parts: string[] = [opts.basePrompt];

  if (opts.expert && opts.expert.prompt) {
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push(`## 你的角色：${opts.expert.name}`);
    if (opts.expert.description) parts.push(opts.expert.description);
    parts.push('');
    parts.push(opts.expert.prompt);
    parts.push('');
    parts.push('注意：以上角色设定只影响你的思考方式和表达风格，**不改变输出格式要求** —— 你仍然必须输出上面规定的严格 JSON。');
  }

  if (opts.skills.length > 0) {
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('## 本次任务适用的技能与专业规范');
    parts.push('下面的规范来自经过验证的运维实践，请优先遵循。如果与用户的明确要求冲突，以用户要求为准。');
    for (const { skill, values } of opts.skills) {
      parts.push('');
      parts.push(renderSkill(skill, values));
    }
  }

  if (opts.extraInstructions && opts.extraInstructions.trim()) {
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('## 用户的额外要求（优先级最高）');
    parts.push(opts.extraInstructions.trim());
    parts.push('');
    parts.push('仍然必须以严格 JSON 格式输出。');
  }

  return parts.join('\n');
}

/** 生成一次运行使用的 profile 快照（用于回显与审计） */
export function buildProfile(
  expert: ExpertConfig | null,
  skills: SkillConfig[]
): AgentProfile {
  return {
    expertId: expert?.id ?? null,
    expertName: expert?.name ?? '（未指定专家）',
    skillIds: skills.map((s) => s.id),
    skillNames: skills.map((s) => s.name),
  };
}

/**
 * 根据用户的任务描述，推荐匹配的技能。
 * 用技能自带的 triggers 做关键词匹配 —— 简单但足够有效，
 * 而且完全可解释（用户能看懂为什么推荐它）。
 */
export function recommendSkills(
  custom: SkillConfig[],
  task: string
): { skill: SkillConfig; matched: string[] }[] {
  const text = (task ?? '').toLowerCase();
  if (!text.trim()) return [];

  const out: { skill: SkillConfig; matched: string[] }[] = [];
  for (const skill of listSkills(custom)) {
    if (!skill.enabled) continue;
    const matched = (skill.triggers ?? []).filter((t) => t && text.includes(t.toLowerCase()));
    if (matched.length > 0) out.push({ skill, matched });
  }
  // 命中关键词多的排前面
  return out.sort((a, b) => b.matched.length - a.matched.length);
}

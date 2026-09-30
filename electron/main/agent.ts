import { BrowserWindow } from 'electron';
import type {
  AgentEvent,
  AgentProfile,
  ApprovalMode,
  ExecResult,
  PlanStep,
  SkillConfig,
} from '@shared/types';
import { assessRisk } from '@shared/risk';
import { chat, type ChatMessage } from './llm';
import * as ssh from './ssh';
import {
  getHost,
  getModel,
  getSettings,
  insertAudit,
  listCustomExperts,
  listCustomSkills,
} from './db';
import { buildProfile, composeSystemPrompt, findExpert, findSkill } from './registry';
import * as registry from './registry';
import { shortId } from './secure-store';

/**
 * 本地 Agent 引擎
 *
 * 流程：自然语言任务 -> LLM 生成结构化计划 -> 逐步（或整体）审批 -> SSH 执行 -> 汇总结果
 * 关键设计：控制权始终在人手上 —— 危险命令硬拦截，写操作默认需确认
 */

export interface AgentCallbacks {
  emit: (e: AgentEvent) => void;
}

/**
 * 一次运行请求里携带的「人设配置」。
 *
 * 技能参数写成 Record<string, string> 而不是数组，是为了让调用方直接传表单值；
 * 主进程再用技能定义里的 params 顺序渲染，避免依赖对象键顺序。
 */
export interface SkillSelection {
  skillId: string;
  /** 用户在 UI 上填的参数值 */
  values?: Record<string, string>;
}

/** 单次运行的上下文 */
interface RunCtx {
  runId: string;
  hostId: string;
  task: string;
  approvalMode: ApprovalMode;
  steps: PlanStep[];
  /** 等待人工批准的步骤 resolve 函数 */
  pendingApproval: {
    stepId: string;
    resolve: (decision: { approved: boolean; editedCommand?: string }) => void;
  } | null;
  aborted: boolean;
  /** 累计执行历史，供模型重规划参考 */
  history: { command: string; output: string; exitCode: number | null }[];
  /** 本次运行使用的专家与技能快照 */
  profile: AgentProfile;
  /** 已经渲染好的系统提示词（专家 + 技能已注入） */
  systemPrompt: string;
}

const runs = new Map<string, RunCtx>();
const windows = new Set<BrowserWindow>();

/**
 * 启动时把 registry 的设置来源接上。
 *
 * agent 会通过 registry 读取「哪些内置专家被停用」，而 registry 为了可测试
 * 不直接依赖 db —— 所以需要在应用启动时显式注入一次。
 */
export function initAgent(): void {
  registry.setSettingsProvider(() => getSettings());
}

export function registerWindow(win: BrowserWindow): void {
  windows.add(win);
  win.on('closed', () => windows.delete(win));
}

/**
 * 额外的 Agent 事件订阅者。
 *
 * MCP 的高层工具 run_agent_task 需要跟踪任务进度，但那个任务不是界面发起的，
 * 界面上的 Agent 面板也看不到它。这里开一个旁路订阅口，让 mcp/handlers 能把
 * 事件收集到自己的一份运行跟踪表里，再通过 MCP 工具暴露给外部 Agent。
 */
type AgentEventSink = (e: AgentEvent) => void;
const eventSinks = new Set<AgentEventSink>();

export function setEventSink(fn: AgentEventSink): () => void {
  eventSinks.add(fn);
  return () => eventSinks.delete(fn);
}

function broadcast(e: AgentEvent): void {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send('agent:event', e);
  }
  // 旁路订阅者出错不能影响 Agent 主流程
  for (const sink of eventSinks) {
    try {
      sink(e);
    } catch (err) {
      console.error('[agent:eventSink]', err);
    }
  }
}

/* ============ Prompt 设计 ============ */

const PLAN_SYSTEM_PROMPT = `你是一位资深的 Linux 运维工程师（SRE），负责把用户的自然语言需求转换成可执行的服务器操作计划。

## 你的输出格式
必须输出严格的 JSON，不要有任何额外文字、不要用 markdown 代码块包裹：

{
  "steps": [
    {
      "description": "这一步的目的（简述，中文）",
      "command": "实际要在服务器上执行的 shell 命令",
      "explanation": "白话解释这条命令会对服务器做什么（中文，面向不懂技术的用户，要说清楚影响）",
      "rollback": "如果这一步出了问题，怎么退回去（中文，写具体可执行的命令；纯读取操作留空字符串）"
    }
  ]
}

## 硬性要求
1. command 必须是可直接在 bash 中执行的完整命令，不要有占位符、不要有注释、不要有 \`sudo\` 前缀（除非必要且你已确认需要）
2. 每条命令尽量是幂等的、可回滚的。避免使用破坏性操作
3. 如果需要先检查环境，把检查命令作为前序步骤
4. 步骤数量控制在 3-15 之间，粒度适中（一条命令一个步骤）
5. explanation 必须说清楚：这条命令是「读取信息」还是「修改系统」，会改动哪些文件或服务
6. 不要输出 rm -rf / 、mkfs、dd 写盘、shutdown 等破坏性命令，这些会被系统拦截
7. 如果用户的需求本身有风险（例如要删除数据），在 description 中明确提示风险
8. **凡是要修改系统状态的步骤（改配置、写文件、重启服务、改权限），rollback 必须给出具体命令**，
   不能写"恢复原配置"这种空话。标准做法例如：
   - 改配置文件：\`cp /etc/nginx/nginx.conf.bak.1699999999 /etc/nginx/nginx.conf && systemctl reload nginx\`
   - 停止服务：\`systemctl start 服务名\`
   - 创建目录/文件：\`rm -rf 路径\`
   纯查询/读取类的步骤，rollback 填 ""

## 执行环境
- 目标是一台 Linux VPS，通过 SSH 以普通用户或 root 身份登录
- 常见发行版：Ubuntu / Debian / CentOS / AlmaLinux
- 包管理器可能是 apt 或 yum/dnf，你可以在计划中先探测`;

function buildPlanMessages(
  task: string,
  hostInfo: string,
  systemPrompt: string,
  context?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `服务器信息：\n${hostInfo}\n\n用户需求：${task}` },
  ];
  if (context) {
    messages.push({
      role: 'user',
      content: `已有执行历史与观察结果（请据此调整计划，避免重复已完成的步骤）：\n${context}`,
    });
  }
  return messages;
}

const REPLAN_SYSTEM_PROMPT = `你是资深 Linux 运维工程师。上一步操作失败或产生了意外结果，请判断下一步该怎么做。

输出严格 JSON：
{
  "action": "continue" | "retry" | "replan" | "abort",
  "reason": "判断理由（中文）",
  "steps": [ { "description": "...", "command": "...", "explanation": "..." } ]
}

- action=continue：失败可忽略，继续后续步骤（steps 留空数组）
- action=retry：换一条命令重试失败的操作（steps 填新命令）
- action=replan：原计划已不适用，需要重新规划剩余工作（steps 填新的后续步骤）
- action=abort：无法继续，必须停下来让用户处理（steps 留空数组）

只在确实必要的时候才选择 retry/replan，优先考虑 continue。`;

/**
 * 重规划时保留专家的人格与方法论。
 *
 * 为什么不能直接用 REPLAN_SYSTEM_PROMPT：如果只保留通用提示词，
 * 失败后模型会退回"随便试试"的默认行为 —— 恰恰是专家设定要避免的
 * （SRE 会先想回滚、安全专家会先想怎么别锁死自己）。
 * 这里把专家人格追加在后面，但把 JSON 格式约束再重申一次。
 */
function buildReplanSystemPrompt(ctx: RunCtx): string {
  if (!ctx.profile.expertId) return REPLAN_SYSTEM_PROMPT;
  const custom = listCustomExperts();
  const expert = findExpert(custom, ctx.profile.expertId);
  if (!expert?.prompt) return REPLAN_SYSTEM_PROMPT;
  return [
    REPLAN_SYSTEM_PROMPT,
    '',
    '---',
    '',
    `## 你的角色：${expert.name}`,
    expert.prompt,
    '',
    '判断"下一步怎么办"时，请遵循上面的角色设定。仍然必须输出规定的严格 JSON。',
  ].join('\n');
}

/* ============ JSON 解析容错 ============ */

function extractJson(text: string): any {
  let t = text.trim();
  // 去掉 markdown 代码块包裹
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // 去掉可能的前后说明文字，截取第一个 { 到最后一个 }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/* ============ 主流程 ============ */

/** 生成计划 */
export async function startRun(params: {
  hostId: string;
  task: string;
  approvalMode?: ApprovalMode;
  /** 本次使用的专家 id；不传则用设置里的默认专家 */
  expertId?: string | null;
  /** 本次启用的技能及其参数 */
  skills?: SkillSelection[];
}): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const settings = getSettings();
  if (!params.task || !params.task.trim()) {
    return { ok: false, error: '请先描述你要完成的任务' };
  }
  if (!settings.activeModelId) {
    return { ok: false, error: '尚未配置模型，请先在「设置」中添加一个模型' };
  }
  const model = getModel(settings.activeModelId);
  if (!model) return { ok: false, error: '当前选定的模型配置不存在，请重新设置' };

  const host = getHost(params.hostId);
  if (!host) return { ok: false, error: '主机不存在' };

  // Agent 需要一条活着的连接
  if (!ssh.getConn(params.hostId) || ssh.getConn(params.hostId)?.status !== 'connected') {
    return { ok: false, error: '与服务器的连接已断开，请重新连接后再试' };
  }

  // 解析专家与技能（这里就固化下来，运行过程中不再变化）
  const expert = resolveExpert(params.expertId);
  const skills = resolveSkills(params.skills);

  const systemPrompt = composeSystemPrompt({
    basePrompt: PLAN_SYSTEM_PROMPT,
    expert,
    skills: skills.map((s) => ({ skill: s, values: s.__values })),
  });

  const runId = shortId('run_');
  const approvalMode =
    params.approvalMode ?? expert?.suggestedApprovalMode ?? settings.defaultApprovalMode;

  const ctx: RunCtx = {
    runId,
    hostId: params.hostId,
    task: params.task,
    approvalMode,
    steps: [],
    pendingApproval: null,
    aborted: false,
    history: [],
    profile: buildProfile(expert, skills),
    systemPrompt,
  };
  runs.set(runId, ctx);

  // 异步跑，立刻返回 runId 让前端订阅事件
  void runPlanning(ctx, model.id, host).catch((e) => {
    ctxStepPhase(ctx, 'error', e?.message ?? String(e));
  });

  return { ok: true, runId };
}

/** 解析本次要用的专家：显式指定 > 设置默认 > 内置通用 */
function resolveExpert(explicitId?: string | null) {
  const custom = listCustomExperts();
  if (explicitId !== undefined) {
    return findExpert(custom, explicitId);
  }
  const settings = getSettings();
  return findExpert(custom, settings.defaultExpertId) ?? findExpert(custom, 'expert_general');
}

/** 解析本次要用的技能（含参数值），跳过找不到或已禁用的 */
function resolveSkills(selections?: SkillSelection[]): (SkillConfig & { __values: Record<string, string> })[] {
  if (!selections || selections.length === 0) return [];
  const custom = listCustomSkills();
  const out: (SkillConfig & { __values: Record<string, string> })[] = [];
  for (const sel of selections) {
    const skill = findSkill(custom, sel.skillId);
    if (!skill) continue;
    // 参数值先按定义补默认值，再覆盖用户填的
    const values: Record<string, string> = {};
    for (const p of skill.params ?? []) {
      if (p.defaultValue) values[p.key] = p.defaultValue;
    }
    for (const [k, v] of Object.entries(sel.values ?? {})) {
      if (v !== undefined && v !== null) values[k] = String(v);
    }
    out.push(Object.assign({}, skill, { __values: values }));
  }
  return out;
}

function ctxStepPhase(ctx: RunCtx, phase: any, error?: string) {
  broadcast({ type: 'phase', runId: ctx.runId, phase });
  if (error) broadcast({ type: 'error', runId: ctx.runId, error });
}

async function runPlanning(
  ctx: RunCtx,
  modelId: string,
  host: NonNullable<ReturnType<typeof getHost>>
): Promise<void> {
  const model = getModel(modelId)!;
  ctxStepPhase(ctx, 'planning');
  broadcast({ type: 'profile', runId: ctx.runId, profile: ctx.profile });
  broadcast({
    type: 'thinking',
    runId: ctx.runId,
    text: ctx.profile.skillNames.length
      ? `正在以「${ctx.profile.expertName}」的身份，结合 ${ctx.profile.skillNames.length} 项技能分析需求…`
      : `正在以「${ctx.profile.expertName}」的身份分析需求并生成执行计划…`,
  });

  const hostInfo = `IP: ${host.host}:${host.port}\n用户: ${host.username}\n别名: ${host.name}\n默认目录: ${host.defaultCwd || '(未设置)'}`;

  let raw: string;
  try {
    raw = await chat(model, buildPlanMessages(ctx.task, hostInfo, ctx.systemPrompt), {
      temperature: 0.1,
      jsonMode: true,
    });
  } catch (e: any) {
    ctxStepPhase(ctx, 'error', `生成计划失败: ${e?.message ?? e}`);
    return;
  }

  let parsed: any;
  try {
    parsed = extractJson(raw);
  } catch {
    ctxStepPhase(ctx, 'error', '模型返回的计划不是有效 JSON，请重试或更换模型');
    return;
  }

  const rawSteps: any[] = Array.isArray(parsed?.steps) ? parsed.steps : [];
  if (rawSteps.length === 0) {
    ctxStepPhase(ctx, 'error', '模型没有生成任何步骤，请把需求描述得更具体一些');
    return;
  }

  const settings = getSettings();
  ctx.steps = rawSteps.slice(0, 25).map((s, i) => {
    const command = String(s.command ?? '').trim();
    const risk = assessRisk(command, settings.extraDangerPatterns);
    return {
      id: shortId('step_'),
      index: i + 1,
      description: String(s.description ?? '').trim() || `步骤 ${i + 1}`,
      command,
      explanation: String(s.explanation ?? '').trim() || '（模型未提供说明）',
      risk,
      status: 'pending' as const,
      // 模型可选给出回滚方式；只读命令一般不会给
      rollback: String(s.rollback ?? '').trim() || undefined,
    };
  });

  broadcast({ type: 'plan', runId: ctx.runId, steps: ctx.steps });

  // 计划级审批
  if (ctx.approvalMode === 'plan_once') {
    ctxStepPhase(ctx, 'awaiting_approval');
    // 由前端调用 approvePlan 触发执行
    return;
  }

  // 逐步审批模式：直接开始执行循环，每步执行前挂起等审批
  void executeLoop(ctx, model.id, host);
}

/** 批准整份计划并开始执行 */
export function approvePlan(runId: string): { ok: boolean; error?: string } {
  const ctx = runs.get(runId);
  if (!ctx) return { ok: false, error: '运行不存在' };
  const host = getHost(ctx.hostId);
  if (!host) return { ok: false, error: '主机不存在' };
  const settings = getSettings();
  const model = getModel(settings.activeModelId!);
  if (!model) return { ok: false, error: '模型配置不存在' };
  void executeLoop(ctx, model.id, host);
  return { ok: true };
}

/** 人工对某一步做决策 */
export function decideStep(
  runId: string,
  stepId: string,
  decision: { approved: boolean; editedCommand?: string }
): { ok: boolean; error?: string } {
  const ctx = runs.get(runId);
  if (!ctx) return { ok: false, error: '运行不存在' };
  if (!ctx.pendingApproval || ctx.pendingApproval.stepId !== stepId) {
    return { ok: false, error: '当前没有等待批准的步骤' };
  }
  const resolve = ctx.pendingApproval.resolve;
  ctx.pendingApproval = null;
  resolve(decision);
  return { ok: true };
}

/** 中止运行 */
export function abortRun(runId: string): { ok: boolean } {
  const ctx = runs.get(runId);
  if (!ctx) return { ok: false };
  ctx.aborted = true;
  if (ctx.pendingApproval) {
    ctx.pendingApproval.resolve({ approved: false });
    ctx.pendingApproval = null;
  }
  broadcast({ type: 'phase', runId, phase: 'aborted' });
  return { ok: true };
}

function waitApproval(
  ctx: RunCtx,
  step: PlanStep
): Promise<{ approved: boolean; editedCommand?: string }> {
  return new Promise((resolve, reject) => {
    ctx.pendingApproval = { stepId: step.id, resolve };
    broadcast({ type: 'phase', runId: ctx.runId, phase: 'awaiting_approval' });
    // 挂一个心跳检查，用户中止时能立刻解开
    const checker = setInterval(() => {
      if (ctx.aborted) {
        clearInterval(checker);
        ctx.pendingApproval = null;
        reject(new Error('已中止'));
      }
    }, 400);
    const origResolve = resolve;
    ctx.pendingApproval.resolve = (d) => {
      clearInterval(checker);
      origResolve(d);
    };
  });
}

async function executeLoop(
  ctx: RunCtx,
  modelId: string,
  host: NonNullable<ReturnType<typeof getHost>>
): Promise<void> {
  const settings = getSettings();
  ctxStepPhase(ctx, 'executing');

  for (let i = 0; i < ctx.steps.length; i++) {
    if (ctx.aborted) break;
    const step = ctx.steps[i];

    if (step.status !== 'pending') continue;

    // 硬拦截
    if (step.risk.blocked) {
      step.status = 'rejected';
      step.error = `安全策略拦截：${step.risk.reasons.join('；')}`;
      broadcast({
        type: 'step_done',
        runId: ctx.runId,
        stepId: step.id,
        status: 'rejected',
        exitCode: null,
        error: step.error,
      });
      logAudit(ctx, host, step, false, null, 0);
      continue;
    }

    // 是否需要人工审批
    const needApproval =
      ctx.approvalMode === 'every_step' ||
      (ctx.approvalMode === 'auto_readonly' && step.risk.requiresApproval) ||
      (ctx.approvalMode === 'plan_once' && step.risk.requiresApproval && step.risk.level === 'critical');

    if (needApproval) {
      let decision: { approved: boolean; editedCommand?: string };
      try {
        decision = await waitApproval(ctx, step);
      } catch {
        break; // 已中止
      }
      if (!decision.approved) {
        step.status = 'rejected';
        broadcast({
          type: 'step_done',
          runId: ctx.runId,
          stepId: step.id,
          status: 'rejected',
          exitCode: null,
          error: '用户拒绝执行',
        });
        logAudit(ctx, host, step, false, null, 0);
        continue;
      }
      // 用户可能修改了命令，重新评估风险
      if (decision.editedCommand && decision.editedCommand !== step.command) {
        step.command = decision.editedCommand;
        step.risk = assessRisk(step.command, settings.extraDangerPatterns);
        if (step.risk.blocked) {
          step.status = 'rejected';
          step.error = '修改后的命令被安全策略拦截';
          broadcast({
            type: 'step_done',
            runId: ctx.runId,
            stepId: step.id,
            status: 'rejected',
            exitCode: null,
            error: step.error,
          });
          logAudit(ctx, host, step, false, null, 0);
          continue;
        }
      }
    }

    // 执行
    step.status = 'running';
    broadcast({ type: 'step_start', runId: ctx.runId, stepId: step.id });

    const result: ExecResult = await ssh.exec(ctx.hostId, step.command, {
      cwd: host.defaultCwd || undefined,
      timeoutSec: settings.commandTimeoutSec,
      maxChars: settings.maxOutputChars * 8,
    });

    step.exitCode = result.exitCode;
    step.output = result.stdout + (result.stderr ? `\n[stderr] ${result.stderr}` : '');
    step.status = result.ok ? 'success' : 'failed';

    broadcast({ type: 'step_done', runId: ctx.runId, stepId: step.id, status: step.status, exitCode: result.exitCode });
    logAudit(ctx, host, step, true, result.exitCode, result.durationMs, result.stdout);

    ctx.history.push({
      command: step.command,
      output: truncate(step.output, settings.maxOutputChars),
      exitCode: result.exitCode,
    });

    // 失败则询问模型如何继续
    if (!result.ok && !ctx.aborted) {
      const action = await askReplan(ctx, modelId, step, result);
      if (action === 'abort') {
        ctxStepPhase(ctx, 'error', `步骤 ${step.index} 执行失败，模型建议中止：${step.error ?? ''}`);
        return;
      }
      if (Array.isArray((ctx as any)._newSteps) && (ctx as any)._newSteps.length) {
        const added = (ctx as any)._newSteps as PlanStep[];
        let idx = ctx.steps.length;
        for (const s of added) {
          s.index = ++idx;
          ctx.steps.push(s);
        }
        broadcast({ type: 'plan', runId: ctx.runId, steps: ctx.steps });
        (ctx as any)._newSteps = [];
      }
    }
  }

  if (ctx.aborted) {
    ctxStepPhase(ctx, 'aborted');
    return;
  }

  // 汇总
  ctxStepPhase(ctx, 'summarizing');
  broadcast({ type: 'thinking', runId: ctx.runId, text: '正在汇总执行结果…' });
  let summary = '';
  try {
    summary = await summarize(ctx, modelId);
  } catch (e: any) {
    summary = `（汇总失败：${e?.message ?? e}）`;
  }
  broadcast({ type: 'summary', runId: ctx.runId, summary });
  ctxStepPhase(ctx, 'done');
  runs.delete(ctx.runId);
}

async function askReplan(
  ctx: RunCtx,
  modelId: string,
  failedStep: PlanStep,
  result: ExecResult
): Promise<'continue' | 'retry' | 'replan' | 'abort'> {
  const model = getModel(modelId);
  if (!model) return 'continue';

  const settings = getSettings();
  const historyText = ctx.history
    .map((h, i) => `[${i + 1}] $ ${h.command}\n退出码: ${h.exitCode}\n输出: ${h.output}`)
    .join('\n\n');

  broadcast({ type: 'thinking', runId: ctx.runId, text: `步骤 ${failedStep.index} 失败，正在判断如何继续…` });

  try {
    const raw = await chat(
      model,
      [
        { role: 'system', content: buildReplanSystemPrompt(ctx) },
        {
          role: 'user',
          content: `用户目标：${ctx.task}\n\n已执行历史：\n${historyText}\n\n失败步骤：\n$ ${failedStep.command}\n退出码: ${result.exitCode}\nstderr: ${truncate(result.stderr, 2000)}\nstdout: ${truncate(result.stdout, 2000)}`,
        },
      ],
      { temperature: 0.1, jsonMode: true }
    );

    const parsed = extractJson(raw);
    const action = parsed?.action ?? 'continue';

    if (action === 'retry' || action === 'replan') {
      const rawSteps: any[] = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const newSteps: PlanStep[] = rawSteps.slice(0, 10).map((s) => {
        const command = String(s.command ?? '').trim();
        return {
          id: shortId('step_'),
          index: 0,
          description: String(s.description ?? '').trim(),
          command,
          explanation: String(s.explanation ?? '').trim(),
          risk: assessRisk(command, settings.extraDangerPatterns),
          status: 'pending' as const,
        };
      });
      if (newSteps.length > 0) {
        (ctx as any)._newSteps = newSteps;
        return action;
      }
    }

    if (action === 'abort') return 'abort';
    return 'continue';
  } catch {
    return 'continue';
  }
}

async function summarize(ctx: RunCtx, modelId: string): Promise<string> {
  const model = getModel(modelId);
  if (!model) return '';
  const settings = getSettings();

  const stepsText = ctx.steps
    .map((s) => {
      const icon =
        s.status === 'success' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'rejected' ? '⊘' : '·';
      const rollback = s.rollback ? `\n  回滚方式: ${s.rollback}` : '';
      return `${icon} 步骤${s.index} ${s.description}\n  命令: ${s.command}\n  退出码: ${s.exitCode ?? '-'}${rollback}\n  输出摘要: ${truncate(s.output ?? '', 1200)}`;
    })
    .join('\n\n');

  const persona = ctx.profile.expertId
    ? `你现在的身份是「${ctx.profile.expertName}」。总结时保持这个身份的语言风格（例如 SRE 会强调变更与回滚，新手向导会解释得详细些）。`
    : '';

  const raw = await chat(
    model,
    [
      {
        role: 'system',
        content: `你是运维助手。根据执行记录，用中文给用户一份简洁的总结报告。${persona}

格式要求：
1. 一句话说明整体是否成功
2. 实际做了什么（不要重复命令原文，说人话）
3. 关键结果 / 需要用户注意的事项
4. 如果本次有修改系统的操作，说明怎么回滚
5. 如果有失败或被拦截的步骤，给出后续建议

控制在 400 字以内，不要用 markdown 标题，用短段落。`,
      },
      { role: 'user', content: `用户目标：${ctx.task}\n\n执行记录：\n${stepsText}` },
    ],
    { temperature: 0.2, maxTokens: Math.min(settings.maxOutputChars, 2000) }
  );

  return raw.trim();
}

/* ============ 工具函数 ============ */

function truncate(s: string, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…（已截断，原长 ${s.length} 字符）`;
}

function logAudit(
  ctx: RunCtx,
  host: { id: string; name: string },
  step: PlanStep,
  approved: boolean,
  exitCode: number | null,
  durationMs: number,
  stdout?: string
): void {
  const settings = getSettings();
  if (!settings.auditEnabled) return;
  try {
    insertAudit({
      ts: Date.now(),
      hostId: host.id,
      hostName: host.name,
      source: 'agent',
      action: step.description,
      command: step.command,
      exitCode,
      risk: step.risk.level,
      approved,
      outputSummary: truncate(stdout ?? step.output ?? step.error ?? '', 4000),
      durationMs,
    });
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 手工执行命令（也走安全评估 + 审计） */
export async function runManualCommand(
  hostId: string,
  command: string,
  opts: { cwd?: string; recordAudit?: boolean } = {}
): Promise<ExecResult & { risk: ReturnType<typeof assessRisk> }> {
  const settings = getSettings();
  const risk = assessRisk(command, settings.extraDangerPatterns);
  const host = getHost(hostId);

  if (risk.blocked) {
    return {
      ok: false,
      stdout: '',
      stderr: `安全策略拦截：${risk.reasons.join('；')}`,
      exitCode: null,
      durationMs: 0,
      risk,
    };
  }

  const result = await ssh.exec(hostId, command, {
    cwd: opts.cwd,
    timeoutSec: settings.commandTimeoutSec,
    maxChars: settings.maxOutputChars * 8,
  });

  if (opts.recordAudit !== false && host) {
    try {
      insertAudit({
        ts: Date.now(),
        hostId,
        hostName: host.name,
        source: 'manual',
        action: '手动执行命令',
        command,
        exitCode: result.exitCode,
        risk: risk.level,
        approved: null,
        outputSummary: truncate(result.stdout + result.stderr, 4000),
        durationMs: result.durationMs,
      });
    } catch {
      /* ignore */
    }
  }

  return { ...result, risk };
}

/** 探测服务器基础环境，作为 Agent 的上下文 */
export async function probeHost(hostId: string): Promise<string> {
  const cmd = [
    'echo "=== OS ==="; (cat /etc/os-release 2>/dev/null | head -3) || uname -a',
    'echo "=== KERNEL ==="; uname -r',
    'echo "=== USER ==="; whoami; id',
    'echo "=== CPU/MEM ==="; nproc; free -h 2>/dev/null | head -2',
    'echo "=== DISK ==="; df -h / 2>/dev/null | tail -1',
    'echo "=== PKG ==="; (command -v apt >/dev/null && echo apt) || (command -v dnf >/dev/null && echo dnf) || (command -v yum >/dev/null && echo yum) || echo unknown',
    'echo "=== CWD ==="; pwd',
  ].join('; ');

  const r = await ssh.exec(hostId, cmd, { timeoutSec: 30, maxChars: 20000 });
  return r.stdout || r.stderr;
}

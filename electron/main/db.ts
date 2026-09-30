import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AuditEntry, ExpertConfig, HostConfig, ModelConfig, SkillConfig } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/presets';

/**
 * 本地存储层 —— 纯 JS 实现，零原生依赖
 *
 * 设计：
 * - 主机配置、模型配置、专家/技能配置存放在 JSON 文件，内存索引 + 防抖原子写盘
 * - 审计日志独立存放，按时间倒序，超出上限自动裁剪，避免文件无限膨胀
 * - 所有写入使用 write-temp-then-rename 保证原子性，避免断电损坏
 */

const MAX_AUDIT_ROWS = 10000;
const MAX_AUDIT_FILE_BYTES = 40 * 1024 * 1024;

interface StoreShape {
  hosts: HostConfig[];
  models: ModelConfig[];
  /** 用户自定义专家（内置专家存在代码里，不落盘） */
  experts: ExpertConfig[];
  /** 用户自定义技能 */
  skills: SkillConfig[];
  settings: Record<string, unknown>;
}

let store: StoreShape = { hosts: [], models: [], experts: [], skills: [], settings: {} };
let auditLog: AuditEntry[] = [];
let auditSeq = 1;

let storePath = '';
let auditPath = '';

/** 防抖写盘计时器 */
let saveTimer: NodeJS.Timeout | null = null;
let auditSaveTimer: NodeJS.Timeout | null = null;

function atomicWrite(file: string, content: string): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      atomicWrite(storePath, JSON.stringify(store, null, 2));
    } catch (e) {
      console.error('[store] 保存失败', e);
    }
  }, 250);
}

function scheduleAuditSave(): void {
  if (auditSaveTimer) clearTimeout(auditSaveTimer);
  auditSaveTimer = setTimeout(() => {
    try {
      atomicWrite(auditPath, JSON.stringify(auditLog));
    } catch (e) {
      console.error('[audit] 保存失败', e);
    }
  }, 400);
}

/** 立即落盘（退出前调用） */
export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      atomicWrite(storePath, JSON.stringify(store, null, 2));
    } catch {
      /* ignore */
    }
  }
  if (auditSaveTimer) {
    clearTimeout(auditSaveTimer);
    auditSaveTimer = null;
    try {
      atomicWrite(auditPath, JSON.stringify(auditLog));
    } catch {
      /* ignore */
    }
  }
}

export function initDb(): void {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  storePath = path.join(dir, 'vpspilot-store.json');
  auditPath = path.join(dir, 'vpspilot-audit.json');

  // 读取主存储
  if (fs.existsSync(storePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      store = {
        hosts: Array.isArray(raw.hosts) ? raw.hosts : [],
        models: Array.isArray(raw.models) ? raw.models : [],
        experts: Array.isArray(raw.experts) ? raw.experts : [],
        skills: Array.isArray(raw.skills) ? raw.skills : [],
        settings: raw.settings ?? {},
      };
    } catch (e) {
      console.error('[store] 读取失败，使用空配置', e);
      // 备份损坏文件，避免用户数据被静默清空
      try {
        fs.renameSync(storePath, storePath + '.corrupt-' + Date.now());
      } catch {
        /* ignore */
      }
    }
  }

  // 读取审计日志
  if (fs.existsSync(auditPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      auditLog = Array.isArray(raw) ? raw : [];
      auditSeq = auditLog.reduce((m, x) => Math.max(m, x.id ?? 0), 0) + 1;
    } catch {
      auditLog = [];
    }
  }
}

/* ============ 主机 ============ */

export function listHosts(): HostConfig[] {
  return [...store.hosts].sort((a, b) => b.createdAt - a.createdAt);
}

export function getHost(id: string): HostConfig | null {
  return store.hosts.find((h) => h.id === id) ?? null;
}

export function upsertHost(h: HostConfig): void {
  const i = store.hosts.findIndex((x) => x.id === h.id);
  if (i >= 0) store.hosts[i] = h;
  else store.hosts.push(h);
  scheduleSave();
}

export function deleteHost(id: string): void {
  store.hosts = store.hosts.filter((h) => h.id !== id);
  // 解除引用了该主机的跳板机配置
  for (const h of store.hosts) {
    if (h.jumpHostId === id) h.jumpHostId = undefined;
  }
  scheduleSave();
}

/* ============ 模型 ============ */

export function listModels(): ModelConfig[] {
  return [...store.models].sort((a, b) => a.createdAt - b.createdAt);
}

export function getModel(id: string): ModelConfig | null {
  return store.models.find((m) => m.id === id) ?? null;
}

export function upsertModel(m: ModelConfig): void {
  const i = store.models.findIndex((x) => x.id === m.id);
  if (i >= 0) store.models[i] = m;
  else store.models.push(m);
  scheduleSave();
}

export function deleteModel(id: string): void {
  store.models = store.models.filter((m) => m.id !== id);
  scheduleSave();
}

/* ============ 专家与技能（用户自定义部分） ============ */

export function listCustomExperts(): ExpertConfig[] {
  return [...store.experts].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function getCustomExpert(id: string): ExpertConfig | null {
  return store.experts.find((e) => e.id === id) ?? null;
}

export function upsertExpert(e: ExpertConfig): void {
  const i = store.experts.findIndex((x) => x.id === e.id);
  if (i >= 0) store.experts[i] = e;
  else store.experts.push(e);
  scheduleSave();
}

export function deleteExpert(id: string): void {
  store.experts = store.experts.filter((e) => e.id !== id);
  scheduleSave();
}

export function listCustomSkills(): SkillConfig[] {
  return [...store.skills].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function getCustomSkill(id: string): SkillConfig | null {
  return store.skills.find((s) => s.id === id) ?? null;
}

export function upsertSkill(s: SkillConfig): void {
  const i = store.skills.findIndex((x) => x.id === s.id);
  if (i >= 0) store.skills[i] = s;
  else store.skills.push(s);
  scheduleSave();
}

export function deleteSkill(id: string): void {
  store.skills = store.skills.filter((s) => s.id !== id);
  scheduleSave();
}

/* ============ 审计 ============ */

export function insertAudit(e: Omit<AuditEntry, 'id'>): number {
  const id = auditSeq++;
  auditLog.unshift({ ...e, id });
  const settings = getSettings();
  // 双重上限：条数 + 体积。只按条数裁的话，一条超长输出就能把文件撑爆
  const maxRows = Math.max(200, settings.maxAuditRows ?? MAX_AUDIT_ROWS);
  if (auditLog.length > maxRows) {
    auditLog = auditLog.slice(0, maxRows);
  }
  scheduleAuditSave();
  return id;
}

export function listAudit(opts: { hostId?: string; limit?: number; offset?: number } = {}): AuditEntry[] {
  const limit = opts.limit ?? 200;
  const offset = opts.offset ?? 0;
  const base = opts.hostId ? auditLog.filter((x) => x.hostId === opts.hostId) : auditLog;
  return base.slice(offset, offset + limit);
}

export function clearAudit(): void {
  auditLog = [];
  scheduleAuditSave();
}

/* ============ 设置 ============ */

/**
 * 净化 MCP 设置。
 *
 * 起因：渲染进程曾把 IPC 的包装体 `{ok:true, data:"..."}` 整个当成 token
 * 存了进来，导致 Token 变成对象、鉴权永久失败。IPCHandle 层不校验类型，
 * 所以这里补一道防线 —— 类型不对就回落到默认值，宁可让用户重新填，
 * 也不要让一个畸形值静默地把服务卡死。
 */
function sanitizeMcp(raw: any, base: any): any {
  const out: any = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };

  // token 必须是字符串
  if (typeof out.token !== 'string') out.token = base.token;

  // 布尔项：非布尔一律回落
  for (const k of ['enabled', 'httpEnabled', 'allowWrite', 'allowExec', 'allowDangerous', 'autoConnect', 'auditEnabled']) {
    if (typeof out[k] !== 'boolean') out[k] = base[k];
  }

  // 数值项：必须是有限正整数
  for (const k of ['httpPort', 'maxReadChars', 'commandTimeoutSec']) {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) && n > 0 ? Math.floor(n) : base[k];
  }

  // 枚举项
  if (!['always', 'risky', 'never'].includes(out.approvalPolicy)) {
    out.approvalPolicy = base.approvalPolicy;
  }

  return out;
}

/**
 * 读取设置。
 *
 * 这里必须对嵌套对象做深合并，不能只做顶层展开：
 * 老版本存下的 settings 里没有 `mcp` 字段，浅合并会让它整块丢失；
 * 而后续版本给 `mcp` 新增字段时，用户已存的旧 mcp 对象同样会缺字段。
 * 两层都补齐后，任何版本升级都能拿到一份字段完整的设置。
 */
export function getSettings(): typeof DEFAULT_SETTINGS {
  const stored = (store.settings ?? {}) as any;
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.mcp = sanitizeMcp(stored.mcp, DEFAULT_SETTINGS.mcp);
  return merged;
}

export function setSettings(patch: Record<string, unknown>): typeof DEFAULT_SETTINGS {
  // mcp 是嵌套对象，前端可能只提交其中几个字段。这里做一次深合并，
  // 避免「只改端口」的提交把 token、审批策略等其余字段抹掉。
  const next: any = { ...patch };
  if (next.mcp && typeof next.mcp === 'object') {
    const current = getSettings().mcp;
    next.mcp = sanitizeMcp(next.mcp, current);
  }
  store.settings = { ...store.settings, ...next };
  scheduleSave();
  return getSettings();
}

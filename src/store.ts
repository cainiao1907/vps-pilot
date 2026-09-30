import { useSyncExternalStore } from 'react';
import type { AppSettings, ExpertConfig, SkillConfig } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/presets';

/**
 * 极简全局 store（避免引入状态库）
 * 用 useSyncExternalStore 订阅
 */

export interface ModelView {
  id: string;
  label: string;
  providerId: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

/**
 * 一级导航（左侧图标栏）
 *
 * 信息架构的分层依据是「使用频率 + 是否依赖当前主机」：
 *  - workspace  依赖选中主机，是日常高频区（终端 / Agent / 文件）
 *  - hosts      主机清单，次高频
 *  - audit      回顾性查看
 *  - library    专家 / 技能，低频配置
 *  - settings   模型 / 代理 / 通用，低频配置
 *
 * 关键是：**没有任何一个导航项会卸载工作区**。workspace 的标签页（含终端实例）
 * 必须常驻挂载，切走只是视觉隐藏 —— 否则终端会被 dispose，正在跑的远程命令
 * 和滚回历史全部丢失。
 */
export type NavGroup = 'workspace' | 'hosts' | 'audit' | 'library' | 'settings';

/**
 * 二级导航（仅 library / settings 有值）
 * 之所以放在 store 而不是组件内 state：侧栏在 App 里渲染，页面在别处渲染，
 * 两者需要共享同一个「当前子页」。
 */
export type SubNav = string;

export interface AppState {
  hosts: any[];
  models: ModelView[];
  /** 专家列表（内置 + 自定义，已应用启用状态） */
  experts: ExpertConfig[];
  /** 技能列表（内置 + 自定义，已应用启用状态） */
  skills: SkillConfig[];
  settings: AppSettings;
  /** 当前选中的主机 id */
  activeHostId: string | null;
  /** 已连接的主机 id 集合 */
  connected: Record<string, 'disconnected' | 'connecting' | 'connected' | 'error'>;
  /** 一级导航：当前激活的分组 */
  nav: NavGroup;
  /** 二级导航：library / settings 下当前激活的子页 */
  subNav: SubNav;
}

let state: AppState = {
  hosts: [],
  models: [],
  experts: [],
  skills: [],
  settings: DEFAULT_SETTINGS as AppSettings,
  activeHostId: null,
  connected: {},
  nav: 'workspace',
  subNav: '',
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  // 第三个参数是 Server Snapshot：React 18 在服务端渲染 / 静态渲染时必须要有它，
  // 否则 useSyncExternalStore 会直接抛错（Missing getServerSnapshot）。
  // 客户端渲染时它不会被调用，所以传同一个 selector 在语义上完全等价。
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

/** 刷新主机列表 */
export async function refreshHosts(): Promise<void> {
  const r = await window.vps.listHosts();
  if (r?.ok) setState({ hosts: r.data });
}

/** 刷新模型列表 */
export async function refreshModels(): Promise<void> {
  const r = await window.vps.listModels();
  if (r?.ok) setState({ models: r.data });
}

/** 刷新设置 */
export async function refreshSettings(): Promise<void> {
  const r = await window.vps.getSettings();
  if (r?.ok) setState({ settings: r.data });
}

/** 刷新专家列表 */
export async function refreshExperts(): Promise<void> {
  const r: any = await window.vps.listExperts();
  if (r?.ok) setState({ experts: r.data });
}

/** 刷新技能列表 */
export async function refreshSkills(): Promise<void> {
  const r: any = await window.vps.listSkills();
  if (r?.ok) setState({ skills: r.data });
}

/* ============ 导航 ============ */

/** 各分组的默认子页 —— 切到某个分组时如果没有记住的子页，就用这个 */
export const DEFAULT_SUB_NAV: Record<NavGroup, string> = {
  workspace: '',
  hosts: '',
  audit: '',
  library: 'experts',
  settings: 'models',
};

/** 记住每个分组上次停留的子页，来回切换不会把用户弹回第一项 */
const lastSubNav: Partial<Record<NavGroup, string>> = {};

/** 切换一级导航。切走工作区时不会卸载工作区内容，只是视觉隐藏 */
export function gotoNav(nav: NavGroup, subNav?: string): void {
  const next = subNav ?? lastSubNav[nav] ?? DEFAULT_SUB_NAV[nav];
  if (!subNav) lastSubNav[nav] = next;
  setState({ nav, subNav: next });
}

/** 切换二级导航（只改子页，不动一级） */
export function gotoSubNav(subNav: string): void {
  lastSubNav[state.nav] = subNav;
  setState({ subNav });
}

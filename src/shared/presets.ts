import type { ProxyConfig, ProviderPreset } from './types';

/** 模型供应商预设（全部走 OpenAI 兼容协议） */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    needsKey: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic (兼容网关)',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    needsKey: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0905-preview',
    needsKey: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    needsKey: true,
  },
  {
    id: 'dashscope',
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:14b',
    needsKey: false,
  },
  {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'your-model',
    needsKey: true,
  },
];

/** 默认全局代理配置：不启用代理 */
export const DEFAULT_PROXY: ProxyConfig = {
  type: 'none',
  host: '127.0.0.1',
  port: 7890,
  username: '',
  hasPassword: false,
};

/**
 * 常见本地代理端口速查（一键诊断时用于扫描）
 *
 * 这些端口覆盖了市面上绝大多数代理软件 / 客户端的默认监听端口：
 * Clash、Clash Verge、Mihomo、v2rayN、Shadowsocks、Surge、Fiddler 等。
 */
export const COMMON_PROXY_PORTS: Array<{ port: number; hint: string }> = [
  { port: 7890, hint: 'Clash / Clash Verge 混合端口' },
  { port: 7891, hint: 'Clash SOCKS5' },
  { port: 7897, hint: 'Clash Verge (新版)' },
  { port: 1080, hint: '通用 SOCKS5' },
  { port: 10808, hint: 'v2rayN SOCKS5' },
  { port: 10809, hint: 'v2rayN HTTP' },
  { port: 1087, hint: 'V2Ray / Clash HTTP' },
  { port: 8118, hint: 'Privoxy' },
  { port: 8888, hint: 'Fiddler / 通用 HTTP' },
  { port: 8080, hint: '通用 HTTP 代理' },
  { port: 1086, hint: 'Shadowsocks HTTP' },
];

/** 默认设置 */
export const DEFAULT_SETTINGS = {
  activeModelId: null as string | null,
  defaultApprovalMode: 'auto_readonly' as const,
  maxOutputChars: 8000,
  commandTimeoutSec: 120,
  auditEnabled: true,
  /** 审计日志最多保留条数（同时受文件体积上限约束） */
  maxAuditRows: 10000,
  extraDangerPatterns: [] as string[],
  defaultProxy: DEFAULT_PROXY,
  connectTimeoutMs: 20000,
  /** 默认使用「通用运维工程师」专家 */
  defaultExpertId: 'expert_general' as string | null,
  /** 默认不预启用任何技能，由用户在 Agent 面板按需勾选 */
  defaultSkillIds: [] as string[],
  disabledExpertIds: [] as string[],
  disabledSkillIds: [] as string[],
  /**
   * MCP 默认配置：默认关闭。
   *
   * 这一项会对外暴露「远程控制本机终端」的能力，属于高敏感开关，
   * 因此默认 enabled=false —— 必须由用户在设置页显式打开。
   */
  mcp: {
    enabled: false,
    httpEnabled: true,
    httpPort: 39321,
    token: '',
    approvalPolicy: 'risky' as const,
    allowWrite: true,
    allowExec: true,
    /** 高危命令默认不放行，即使选了免审批策略 */
    allowDangerous: false,
    autoConnect: true,
    maxReadChars: 30000,
    commandTimeoutSec: 120,
    auditEnabled: true,
  },
};

/** MCP 默认配置的独立导出，便于测试与重置 */
export const DEFAULT_MCP_SETTINGS = DEFAULT_SETTINGS.mcp;

/** MCP 默认监听端口（仅绑定 127.0.0.1） */
export const DEFAULT_MCP_PORT = 39321;

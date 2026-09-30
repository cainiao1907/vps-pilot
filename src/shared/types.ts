/**
 * 共享类型定义 —— 主进程与渲染进程共用
 */

/** SSH 认证方式 */
export type AuthType = 'password' | 'privateKey' | 'agent';

/** ============ 代理相关 ============ */

/** 代理协议类型 */
export type ProxyType = 'none' | 'socks5' | 'http';

/** 代理配置（全局默认） */
export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  /** 加密存储的代理密码（只在主进程解密，渲染进程拿不到明文） */
  encryptedPassword?: string;
  /** 代理是否启用密码认证 */
  hasPassword?: boolean;
}

/** 代理配置输入（含明文密码，主进程加密后落盘） */
export interface ProxyInput {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  /** 传空串表示清除，传 undefined 表示保持原值 */
  password?: string;
}

/** 单主机代理覆盖策略 */
export type ProxyMode =
  /** 跟随全局设置（默认） */
  | 'global'
  /** 这台主机不走代理，强制直连 */
  | 'direct'
  /** 这台主机使用独立代理配置 */
  | 'custom';

/** 诊断步骤状态 */
export type DiagStatus = 'ok' | 'fail' | 'warn' | 'skip';

/** 诊断中的单个步骤 */
export interface DiagStep {
  /** 步骤标识 */
  key: string;
  /** 步骤名（白话） */
  label: string;
  status: DiagStatus;
  /** 详细说明：看到了什么、为什么这样判断 */
  detail: string;
  /** 关键指标（如耗时 ms） */
  ms?: number;
}

/** 连接诊断报告 */
export interface DiagReport {
  ok: boolean;
  /** 一句话结论 */
  conclusion: string;
  /** 分步结果 */
  steps: DiagStep[];
  /** 定位到的问题环节 */
  failedAt?: string;
  /** 可操作的建议 */
  suggestions: string[];
  /** 实际使用的代理描述，'直连' 表示未走代理 */
  usedProxy: string;
}

/** 本机检测到的代理候选 */
export interface DetectedProxy {
  type: ProxyType;
  host: string;
  port: number;
  /** 来源：环境变量名 / 常见端口 */
  source: string;
  /** 该端口当前是否可连接 */
  reachable: boolean;
}

/** 代理可用性测试结果 */
export interface ProxyTestResult {
  ok: boolean;
  message: string;
  ms?: number;
}

/** 主机配置 */
export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  /** 加密存储的密码（仅在主进程内解密使用，渲染进程拿不到明文） */
  encryptedPassword?: string;
  /** 私钥路径 */
  privateKeyPath?: string;
  /** 加密存储的私钥口令 */
  encryptedPassphrase?: string;
  /** 跳板机（Jump Host）配置 */
  jumpHostId?: string;
  /** 代理策略：跟随全局 / 强制直连 / 独立配置 */
  proxyMode?: ProxyMode;
  /** proxyMode === 'custom' 时使用的独立代理配置 */
  proxy?: ProxyConfig;
  /** 标签 / 分组 */
  tags?: string[];
  /** 备注 */
  note?: string;
  /** 默认工作目录 */
  defaultCwd?: string;
  createdAt: number;
  updatedAt: number;
}

/** 新建/编辑主机时的输入（含明文凭据，会被主进程加密后落盘） */
export interface HostInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHostId?: string;
  proxyMode?: ProxyMode;
  proxy?: ProxyInput;
  tags?: string[];
  note?: string;
  defaultCwd?: string;
}

/** 连接状态 */
export type ConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** 连接信息（不含凭据） */
export interface ConnectionInfo {
  sessionId: string;
  hostId: string;
  hostName: string;
  status: ConnStatus;
  error?: string;
  connectedAt?: number;
}

/** 终端会话创建结果 */
export interface SessionCreated {
  sessionId: string;
  hostId: string;
}

/** 命令执行结果 */
export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** 是否被安全策略截断 */
  truncated?: boolean;
  /** 执行耗时 ms */
  durationMs: number;
}

/** SFTP 文件项 */
export interface SftpEntry {
  name: string;
  path: string;
  /** 'd' 目录 / 'f' 文件 / 'l' 链接 */
  type: 'd' | 'f' | 'l';
  size: number;
  mtime: number;
  mode: string;
}

/** 审计日志条目 */
export interface AuditEntry {
  id: number;
  ts: number;
  hostId: string | null;
  hostName: string | null;
  /**
   * 来源：
   * - `agent`  ：内置 Agent 引擎自动执行
   * - `manual` ：用户在界面上手敲
   * - `mcp`    ：外部本地 Agent（WorkBuddy / 豆包 / ZCode / Kimi…）通过 MCP 下发
   */
  source: 'agent' | 'manual' | 'mcp';
  /** 操作类型 */
  action: string;
  /** 执行的命令 */
  command: string;
  /** 退出码 */
  exitCode: number | null;
  /** 风险等级 */
  risk: RiskLevel;
  /** 用户是否批准 */
  approved: boolean | null;
  /** 审批由谁做出：'user' 界面人工 / 'mcp' 客户端按策略自动放行 */
  approvedBy?: 'user' | 'mcp';
  /** 来源客户端自报标识（MCP 时填，如 workbuddy / doubao / zcode / kimi） */
  client?: string;
  /** 输出摘要（截断存储） */
  outputSummary: string;
  durationMs: number;
}

/** 风险等级 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** 风险判定结果 */
export interface RiskAssessment {
  level: RiskLevel;
  /** 命中的规则说明（白话） */
  reasons: string[];
  /** 是否被硬拦截（不可执行） */
  blocked: boolean;
  /** 是否需要人工确认 */
  requiresApproval: boolean;
  /** 是否写操作 */
  isWrite: boolean;
}

/** ============ Agent 相关 ============ */

/** Agent 计划中的单个步骤 */
export interface PlanStep {
  id: string;
  /** 步骤序号 */
  index: number;
  /** 自然语言描述：这一步要做什么 */
  description: string;
  /** 具体命令 */
  command: string;
  /** 白话解释：这条命令会对服务器做什么 */
  explanation: string;
  /** 风险判定 */
  risk: RiskAssessment;
  /** 执行状态 */
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'rejected';
  /** 执行输出 */
  output?: string;
  /** 退出码 */
  exitCode?: number | null;
  /** 失败原因 */
  error?: string;
  /**
   * 回滚方式：如果这一步改了系统，怎么退回去。
   * 由模型在生成计划时给出（对只读操作通常为空）。
   */
  rollback?: string;
}

/** Agent 运行阶段 */
export type AgentPhase =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'summarizing'
  | 'done'
  | 'error'
  | 'aborted';

/** Agent 会话 */
export interface AgentRun {
  id: string;
  hostId: string;
  /** 用户的自然语言任务 */
  task: string;
  phase: AgentPhase;
  /** 计划步骤 */
  steps: PlanStep[];
  /** 最终总结 */
  summary?: string;
  /** 错误信息 */
  error?: string;
  /** 审批模式 */
  approvalMode: ApprovalMode;
  startedAt: number;
  finishedAt?: number;
}

/** 审批模式 */
export type ApprovalMode =
  /** 每一步都要人工批准 */
  | 'every_step'
  /** 计划级批准：批准整个计划后自动执行（高危仍然拦截） */
  | 'plan_once'
  /** 只读操作自动放行，写操作需批准 */
  | 'auto_readonly';

/** Agent 运行时事件（主进程 -> 渲染进程流式推送） */
export type AgentEvent =
  | { type: 'phase'; runId: string; phase: AgentPhase }
  | { type: 'profile'; runId: string; profile: AgentProfile }
  | { type: 'plan'; runId: string; steps: PlanStep[] }
  | { type: 'step_start'; runId: string; stepId: string }
  | { type: 'step_output'; runId: string; stepId: string; chunk: string }
  | { type: 'step_done'; runId: string; stepId: string; status: PlanStep['status']; exitCode: number | null; error?: string }
  | { type: 'summary'; runId: string; summary: string }
  | { type: 'error'; runId: string; error: string }
  | { type: 'thinking'; runId: string; text: string };

/** ============ LLM / BYOK 相关 ============ */

/** 模型供应商预设 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** 是否需要 API Key（本地 Ollama 不需要） */
  needsKey: boolean;
}

/** 用户配置的模型 */
export interface ModelConfig {
  id: string;
  /** 显示名 */
  label: string;
  /** 供应商预设 id，或 'custom' */
  providerId: string;
  baseUrl: string;
  /** 加密存储的 API Key */
  encryptedApiKey?: string;
  /** 是否有 key（给渲染进程判断用，不下发明文） */
  hasApiKey?: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  createdAt: number;
}

/** 保存模型时的输入 */
export interface ModelInput {
  id?: string;
  label: string;
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/** 设置项 */
export interface AppSettings {
  /** 默认使用的模型配置 id */
  activeModelId: string | null;
  /** 默认审批模式 */
  defaultApprovalMode: ApprovalMode;
  /** 命令输出喂给模型前的最大字符数 */
  maxOutputChars: number;
  /** 单条命令超时（秒） */
  commandTimeoutSec: number;
  /** 是否记录审计日志 */
  auditEnabled: boolean;
  /** 审计日志最多保留条数 */
  maxAuditRows?: number;
  /** 用户自定义的额外危险命令正则 */
  extraDangerPatterns: string[];
  /** 全局默认代理配置（除被主机单独覆盖外，所有连接都走它） */
  defaultProxy: ProxyConfig;
  /** SSH 连接握手超时（毫秒） */
  connectTimeoutMs: number;
  /** 默认选中的专家 id；null 表示用内置的「通用运维工程师」口吻 */
  defaultExpertId: string | null;
  /** 默认启用的技能 id 列表 */
  defaultSkillIds: string[];
  /** 禁用的内置专家 id（用户把内置专家关掉时记录在这里） */
  disabledExpertIds: string[];
  /** 禁用的内置技能 id */
  disabledSkillIds: string[];
  /** MCP 服务配置：让本地 Agent（WorkBuddy / 豆包 / ZCode / Kimi）反向控制本软件 */
  mcp: McpSettings;
}

/* ============ MCP（Model Context Protocol）服务 ============ */

/** MCP 传输方式 */
export type McpTransport = 'stdio' | 'http';

/**
 * MCP 服务的审批策略。
 *
 * - `always`   ：任何写类操作（发终端输入、执行命令）都要人在界面上点确认
 * - `risky`    ：只有被评估为 high / critical 才要确认，其余放行（推荐）
 * - `never`    ：免审批。critical 级仍然硬拒绝，但 high 级直接执行。
 *                适合无人值守场景，风险由用户自行承担。
 */
export type McpApprovalPolicy = 'always' | 'risky' | 'never';

/** MCP 服务配置 */
export interface McpSettings {
  /** 总开关。关闭时 stdio 不注册、HTTP 不监听 */
  enabled: boolean;
  /** 是否开启 Streamable HTTP 传输（可被多个客户端常驻连接） */
  httpEnabled: boolean;
  /** HTTP 监听端口，仅绑定 127.0.0.1 */
  httpPort: number;
  /** HTTP 访问令牌（Bearer）。空字符串表示不校验 —— 仅在纯本机可信环境使用 */
  token: string;
  /** 审批策略 */
  approvalPolicy: McpApprovalPolicy;
  /** 是否允许 MCP 向终端写入（键盘输入 / 交互式命令） */
  allowWrite: boolean;
  /** 是否允许 MCP 执行命令（exec 通道，拿完整 stdout/stderr/exitCode） */
  allowExec: boolean;
  /** 是否允许 MCP 执行高危命令（critical 级）。默认 false，且不受 approvalPolicy=never 影响 */
  allowDangerous: boolean;
  /** MCP 调用 connect_host 时是否自动通过 SSH 建立连接 */
  autoConnect: boolean;
  /** 单次读取终端输出返回的最大字符数 */
  maxReadChars: number;
  /** MCP 工具执行命令的超时（秒） */
  commandTimeoutSec: number;
  /** 是否把 MCP 的调用记入审计日志 */
  auditEnabled: boolean;
}

/** MCP 服务运行状态 */
export interface McpStatus {
  /** 总开关状态 */
  enabled: boolean;
  /** stdio 通道是否可用 */
  stdioReady: boolean;
  /** HTTP 服务是否在监听 */
  httpListening: boolean;
  /** 实际监听端口（可能是用户配置的口径） */
  httpPort: number | null;
  /** 最近一次错误信息 */
  lastError: string | null;
  /** 服务启动时间 */
  startedAt: number | null;
  /** 当前活跃的 MCP 会话数 */
  sessions: number;
  /** 已暴露的工具数量 */
  toolCount: number;
  /** 累计工具调用次数 */
  callCount: number;
  /** 待人工审批的请求数 */
  pendingApprovals: number;
}

/** MCP 客户端配置片段 */
export interface McpClientSnippet {
  /** 客户端标识 */
  key: string;
  /** 展示名 */
  label: string;
  /** 接入方式说明 */
  hint: string;
  /** 可直接粘贴的配置内容（JSON 或命令行） */
  config: string;
  /** 配置语言：json / bash / toml */
  lang: 'json' | 'bash' | 'toml';
}

/** 待人工审批的 MCP 请求 */
export interface McpPendingApproval {
  id: string;
  hostId: string;
  hostName: string;
  /** 调用来源的工具名 */
  tool: string;
  /** 即将执行的内容（命令或输入） */
  command: string;
  /** 风险等级 */
  risk: RiskLevel;
  /** 风险原因 */
  reasons: string[];
  /** 发起时间 */
  ts: number;
  /** 来源客户端标识（MCP 客户端自报，可能为空） */
  client?: string;
}

/** MCP 服务事件（推送给渲染进程） */
export type McpEvent =
  | { type: 'status'; status: McpStatus }
  | { type: 'call'; tool: string; hostId?: string; ok: boolean; ts: number; durationMs: number }
  | { type: 'approval'; pending: McpPendingApproval }
  | { type: 'approval_done'; id: string; approved: boolean }
  | { type: 'error'; message: string; ts: number };

/** 通用 IPC 响应包 */
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/* ============ 专家（Persona / Expert） ============ */

/**
 * 专家 = 一套人格化的系统提示词 + 行为约束。
 *
 * 它决定 Agent「以什么身份、用什么方法论、按什么风格」来规划命令。
 * 内置专家是预设模板，用户可以「复制为自定义」后随意改；
 * 自定义专家则完全由用户维护。
 */
export interface ExpertConfig {
  id: string;
  /** 显示名，例如「资深 SRE」 */
  name: string;
  /** 一句话说明这个专家擅长什么 */
  description: string;
  /** 图标（emoji 或符号） */
  icon: string;
  /** 分类，用于设置页分组展示 */
  category: string;
  /**
   * 注入到系统提示词里的「人格 + 方法论」正文。
   * 会拼接在 PLAN_SYSTEM_PROMPT 之后，覆盖默认的通用工程师口吻。
   */
  prompt: string;
  /**
   * 该专家默认建议的审批模式。
   * 只是「建议」—— 用户在 Agent 面板里可以随时改。
   */
  suggestedApprovalMode?: ApprovalMode;
  /** true = 内置预设（不可编辑/删除，但可复制）；false = 用户自定义 */
  builtin: boolean;
  /** 是否在 Agent 面板里可见可选 */
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** 新建/编辑专家时的输入 */
export interface ExpertInput {
  id?: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  prompt: string;
  suggestedApprovalMode?: ApprovalMode;
  enabled?: boolean;
}

/* ============ 技能（Skill） ============ */

/**
 * 技能 = 一段可复用的「任务配方」。
 *
 * 和专家的区别：
 *  - 专家改的是「谁来干」（人格、方法论、风格）
 *  - 技能补的是「怎么干」（具体场景的标准步骤、必查项、命令范式、坑）
 *
 * 技能可以带参数占位符 {{name}}，在 UI 上填好后固化成任务描述。
 * 支持两种组织方式：
 *  - steps 非空：按固定步骤注入计划，保证不漏关键检查点
 *  - 否则只用 instructions 作为专业知识注入
 */
export interface SkillParam {
  /** 占位符名，在 body 里写作 {{key}} */
  key: string;
  /** 表单里显示的标签 */
  label: string;
  /** 提示语，例如「例如：example.com」 */
  placeholder?: string;
  /** 是否必填 */
  required?: boolean;
  /** 默认值 */
  defaultValue?: string;
}

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  /**
   * 技能正文：写给模型看的专业指导。
   * 可以是「先确认发行版再选包管理器」这类判断规则，也可以是注意事项 / 坑。
   */
  instructions: string;
  /** 可选的固定步骤模板，每项是一条要点的自然语言描述（不是最终命令） */
  steps?: string[];
  /** 参数占位符定义 */
  params?: SkillParam[];
  /**
   * 适用的命令关键字。当用户任务里出现这些词时，Agent 面板会把该技能
   * 标记为「推荐」，用户可以一键启用。
   */
  triggers?: string[];
  /** 该技能涉及写操作时需要额外提醒的风险点 */
  riskNotes?: string[];
  builtin: boolean;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** 新建/编辑技能时的输入 */
export interface SkillInput {
  id?: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  instructions: string;
  steps?: string[];
  params?: SkillParam[];
  triggers?: string[];
  riskNotes?: string[];
  enabled?: boolean;
}

/**
 * 一次运行实际使用的专家与技能快照。
 * 存档到运行上下文里，便于事后追溯「这次是哪个专家、用了哪些技能」。
 */
export interface AgentProfile {
  expertId: string | null;
  expertName: string;
  skillIds: string[];
  skillNames: string[];
}


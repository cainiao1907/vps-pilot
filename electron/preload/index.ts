import { contextBridge, ipcRenderer } from 'electron';

/**
 * 预加载脚本 —— 只暴露白名单 API，渲染进程无法直接访问 Node/Electron
 */

const invoke = (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args);

/** 订阅事件，返回取消订阅函数 */
function subscribe(channel: string, cb: (payload: any) => void): () => void {
  const listener = (_e: unknown, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api = {
  /* 应用 */
  appInfo: () => invoke('app:info'),

  /* 主机 */
  listHosts: () => invoke('host:list'),
  saveHost: (input: any) => invoke('host:save', input),
  deleteHost: (id: string) => invoke('host:delete', id),
  hostHasCredential: (id: string) => invoke('host:hasCredential', id),

  /* 连接 */
  connect: (hostId: string) => invoke('conn:connect', hostId),
  disconnect: (hostId: string) => invoke('conn:disconnect', hostId),
  connStatus: (hostId: string) => invoke('conn:status', hostId),
  probeHost: (hostId: string) => invoke('conn:probe', hostId),

  /* 代理 */
  getProxy: () => invoke('proxy:get'),
  saveProxy: (input: any) => invoke('proxy:save', input),
  testProxy: (input?: any) => invoke('proxy:test', input),
  detectProxy: () => invoke('proxy:detect'),
  describeProxy: (hostId: string) => invoke('proxy:describe', hostId),

  /* 连接诊断 */
  diagnose: (hostId: string) => invoke('diag:run', hostId),

  /* 剪贴板（终端粘贴用 —— navigator.clipboard 需要安全上下文，file:// 下不可靠） */
  clipboardRead: () => invoke('clipboard:read'),
  clipboardWrite: (text: string) => invoke('clipboard:write', text),

  /* 终端 */
  termOpen: (hostId: string, cols: number, rows: number) => invoke('term:open', hostId, cols, rows),
  termWrite: (hostId: string, data: string) => invoke('term:write', hostId, data),
  termResize: (hostId: string, cols: number, rows: number) => invoke('term:resize', hostId, cols, rows),
  onTermData: (cb: (p: { hostId: string; chunk: string }) => void) => subscribe('term:data', cb),
  onTermClose: (cb: (p: { hostId: string; code?: number }) => void) => subscribe('term:close', cb),

  /* 命令 */
  exec: (hostId: string, command: string, cwd?: string) => invoke('cmd:exec', hostId, command, cwd),
  assess: (command: string) => invoke('cmd:assess', command),

  /* Agent */
  agentRun: (params: {
    hostId: string;
    task: string;
    approvalMode?: string;
    expertId?: string | null;
    skills?: { skillId: string; values?: Record<string, string> }[];
  }) => invoke('agent:run', params),
  agentApprovePlan: (runId: string) => invoke('agent:approvePlan', runId),
  agentDecide: (runId: string, stepId: string, decision: { approved: boolean; editedCommand?: string }) =>
    invoke('agent:decide', runId, stepId, decision),
  agentAbort: (runId: string) => invoke('agent:abort', runId),
  onAgentEvent: (cb: (e: any) => void) => subscribe('agent:event', cb),

  /* 专家（Persona） */
  listExperts: () => invoke('expert:list'),
  saveExpert: (input: any) => invoke('expert:save', input),
  duplicateExpert: (id: string) => invoke('expert:duplicate', id),
  deleteExpert: (id: string) => invoke('expert:delete', id),
  setExpertEnabled: (id: string, enabled: boolean) => invoke('expert:setEnabled', id, enabled),

  /* 技能（Skill） */
  listSkills: () => invoke('skill:list'),
  saveSkill: (input: any) => invoke('skill:save', input),
  duplicateSkill: (id: string) => invoke('skill:duplicate', id),
  deleteSkill: (id: string) => invoke('skill:delete', id),
  setSkillEnabled: (id: string, enabled: boolean) => invoke('skill:setEnabled', id, enabled),
  recommendSkills: (task: string) => invoke('skill:recommend', task),

  /* SFTP */
  sftpList: (hostId: string, dir: string) => invoke('sftp:list', hostId, dir),
  sftpMkdir: (hostId: string, p: string) => invoke('sftp:mkdir', hostId, p),
  sftpRemove: (hostId: string, p: string, isDir: boolean) => invoke('sftp:remove', hostId, p, isDir),
  sftpRename: (hostId: string, from: string, to: string) => invoke('sftp:rename', hostId, from, to),
  sftpRead: (hostId: string, p: string) => invoke('sftp:read', hostId, p),
  sftpWrite: (hostId: string, p: string, content: string) => invoke('sftp:write', hostId, p, content),
  sftpDownload: (hostId: string, remotePath: string) => invoke('sftp:download', hostId, remotePath),
  sftpUpload: (hostId: string, remoteDir: string) => invoke('sftp:upload', hostId, remoteDir),
  pickKeyFile: () => invoke('sftp:pickKeyFile'),

  /* 模型 */
  listModels: () => invoke('model:list'),
  saveModel: (input: any) => invoke('model:save', input),
  deleteModel: (id: string) => invoke('model:delete', id),
  testModel: (id: string) => invoke('model:test', id),
  testModelDraft: (input: any) => invoke('model:testDraft', input),

  /* 设置 */
  getSettings: () => invoke('settings:get'),
  setSettings: (patch: Record<string, unknown>) => invoke('settings:set', patch),

  /* 审计 */
  listAudit: (opts?: any) => invoke('audit:list', opts),
  clearAudit: () => invoke('audit:clear'),

  /* 快捷问答 */
  quickChat: (prompt: string, hostId?: string) => invoke('chat:quick', prompt, hostId),

  /* MCP 服务 —— 让本地 Agent（WorkBuddy / 豆包 / ZCode / Kimi…）反向控制本软件 */
  mcpStatus: () => invoke('mcp:status'),
  mcpSnippets: () => invoke('mcp:snippets'),
  mcpGenerateToken: () => invoke('mcp:generateToken'),
  mcpRestart: () => invoke('mcp:restart'),
  mcpTools: () => invoke('mcp:tools'),
  mcpPending: () => invoke('mcp:pending'),
  mcpDecideApproval: (id: string, approve: boolean) => invoke('mcp:decideApproval', id, approve),
  onMcpEvent: (cb: (e: any) => void) => subscribe('mcp:event', cb),
};

contextBridge.exposeInMainWorld('vps', api);

export type VpsApi = typeof api;

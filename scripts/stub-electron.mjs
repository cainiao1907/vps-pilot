/**
 * electron 模块桩 —— 仅供纯 Node 环境下的单元测试使用
 *
 * 真实应用里 secure-store.ts 会从 electron 拿到 safeStorage 与 app；
 * 这里返回一个"永远不可用"的实现，让 decryptSecret 走 fallback 分支
 * （也就是测试里用 __plain__ 前缀直接返回明文的路径）。
 */

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('桩实现不支持加密');
  },
  decryptString: () => {
    throw new Error('桩实现不支持解密');
  },
};

export const app = {
  getPath: (name) => {
    const os = require('node:os');
    const path = require('node:path');
    return path.join(os.tmpdir(), 'vpspilot-test-' + (name ?? 'userData'));
  },
  /**
   * 应用根目录。MCP 的 clientSnippets 用它来定位 scripts/vps-pilot-mcp.js。
   * 测试里指向真实仓库根目录，这样"路径确实存在"这类断言才有意义。
   */
  getAppPath: () => {
    const path = require('node:path');
    const url = require('node:url');
    return path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  },
  getVersion: () => '0.0.0-test',
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {},
  commandLine: { appendSwitch: () => {} },
  disableHardwareAcceleration: () => {},
};

/**
 * BrowserWindow 桩。
 *
 * 主进程的 agent.ts 会 import { BrowserWindow } 来广播事件。
 * 纯 Node 测试里没有窗口，这里给出一个「永远没有任何窗口」的实现，
 * 让 broadcast 的循环自然空转，不抛错。
 */
export const BrowserWindow = {
  getAllWindows: () => [],
  fromWebContents: () => null,
};

/** ipcMain 桩：只记录注册过的通道，不真的处理 */
export const ipcMain = {
  handle: () => {},
  on: () => {},
  removeHandler: () => {},
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showMessageBox: async () => ({ response: 0 }),
};

export const shell = {
  openExternal: async () => {},
};

export const clipboard = {
  readText: () => '',
  writeText: () => {},
};

export const Menu = {
  setApplicationMenu: () => {},
  buildFromTemplate: () => ({}),
};

export default {
  safeStorage,
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
};

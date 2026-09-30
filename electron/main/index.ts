import { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type {
  HostInput,
  HostConfig,
  ModelConfig,
  ModelInput,
  IpcResult,
  ProxyInput,
  ProxyConfig,
  ExpertInput,
  ExpertConfig,
  SkillInput,
  SkillConfig,
} from '@shared/types';
import {
  PROVIDER_PRESETS,
  DEFAULT_SETTINGS,
  DEFAULT_PROXY,
} from '@shared/presets';
import { BUILTIN_EXPERTS, BUILTIN_SKILLS } from '@shared/experts';
import { assessRisk, isReadonlyCommand } from '@shared/risk';
import * as db from './db';
import * as ssh from './ssh';
import * as agent from './agent';
import * as registry from './registry';
import { encryptSecret, shortId } from './secure-store';
import { chat, chatStream, testModel } from './llm';
import { testProxy } from './proxy';
import { diagnose, detectLocalProxies, describeProxy } from './diagnose';
import { normalizeProxy, resolveProxyForHost } from './proxy-resolve';
import { terminalBuffer } from './terminal-buffer';
import * as mcp from './mcp';

/** 渲染进程 / dev server 地址 */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
process.env.DIST = path.join(__dirname, '../../dist');
const INDEX_HTML = path.join(process.env.DIST, 'index.html');

let win: BrowserWindow | null = null;

const isDev = !!DEV_SERVER_URL;

/** 本次启动是否处于"被动降级到软件渲染"状态 */
let usingSoftwareFallback = false;

/**
 * GPU 渲染策略
 *
 * 背景：在没有可用显卡驱动的环境（云服务器、部分虚拟机、远程桌面、容器）里，
 * Chromium 的 GPU 进程会反复崩溃，最终直接 FATAL 退出，窗口根本创建不出来。
 *
 * 难点：这类崩溃发生在窗口创建阶段，同一个进程内无法"失败后重试"，
 * 所以必须在这之前就做出判断。这里用四层保险（自上而下，命中即生效）：
 *
 *   0. 自动探测 —— 系统里查不到任何可用显示适配器时，直接走软件渲染，
 *      让用户第一次启动就不必经历"崩溃一次再重试"
 *   1. 环境变量 VPSPILOT_SOFTWARE_RENDER=1 —— 用户显式指定，优先级最高
 *   2. 偏好文件 —— 之前确认过需要软件渲染，之后每次启动直接走软件渲染
 *   3. 崩溃标记文件 —— 上次启动失败过，这次直接走软件渲染
 *
 * 启动脚本还提供第 5 层：第一次尝试若失败，自动带 --software-render 参数重试，
 * 并在成功后把偏好写下来，避免下次再失败一次。
 *
 * 正常有显卡的机器不会命中任何一条，仍然使用硬件加速。
 */

/**
 * 检测系统是否存在可用的显示适配器。
 *
 * 说明：这里只做"是否存在"的粗判，不评估驱动质量 —— 有显卡但驱动损坏的情况
 * 交给第 3、5 层兜底。目的是覆盖"云服务器 / 无头容器 / 部分虚拟机"这类
 * 压根没有显卡的环境，让它们第一次启动就成功。
 *
 * 重要：探测失败时的取舍。代码会去调用 wmic / PowerShell 查询显卡列表，
 * 但在受限环境（沙箱、精简系统）里这些命令可能直接 spawn 失败（EBUSY）。
 * 此时**保守地返回 true（认为有显卡）**，把判断权交回给上层：
 * 如果真有显卡，走硬件加速是对的；如果没有，第 3/5 层（崩溃标记 + 启动脚本
 * 自动重试）依然能兜住，只是多花一次重试的时间。反过来若探测失败就贸然
 * 判定"没显卡"，会让所有正常机器都退化成软件渲染，明显更糟。
 */
function hasDisplayAdapter(): boolean {
  if (process.platform !== 'win32') return true; // 只对 Windows 做这项探测
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    // wmic 在较新系统上可能缺失，退回到 PowerShell 查询
    const probes: Array<[string, string[]]> = [
      ['wmic', ['path', 'win32_VideoController', 'get', 'Name']],
      [
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_VideoController | Measure-Object).Count',
        ],
      ],
    ];
    for (const [cmd, args] of probes) {
      try {
        const out = execFileSync(cmd, args, { timeout: 4000, encoding: 'utf8', windowsHide: true });
        const text = String(out).trim();
        if (!text) continue;
        if (cmd === 'powershell') {
          const n = Number(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop());
          return Number.isFinite(n) ? n > 0 : true;
        }
        // wmic 输出形如 "Name\r\nIntel(R) UHD Graphics\r\n\r\n"，去掉表头与空行
        const meaningful = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !/^name$/i.test(l));
        return meaningful.length > 0;
      } catch {
        /* 换下一个探测方式 */
      }
    }
  } catch {
    /* 探测整体失败，保守认为有显卡，交给上层兜底 */
  }
  return true;
}

function configureRendering(): boolean {
  const forceByEnv = process.env.VPSPILOT_SOFTWARE_RENDER === '1';
  const forceByArg = process.argv.includes('--software-render');
  const prefPath = path.join(app.getPath('userData'), '.software-render-pref');
  const crashFlag = path.join(app.getPath('userData'), '.gpu-crash-flag');
  const hasPref = fs.existsSync(prefPath);
  const hasCrashFlag = fs.existsSync(crashFlag);

  // 第 0 层：只在前面几层都没命中时才做探测，避免白跑一次子进程
  const noAdapter =
    !forceByEnv && !forceByArg && !hasPref && !hasCrashFlag && !hasDisplayAdapter();

  const software = forceByEnv || forceByArg || hasPref || hasCrashFlag || noAdapter;
  const why = forceByEnv
    ? '环境变量'
    : forceByArg
      ? '启动参数'
      : hasPref
        ? '已记住的偏好'
        : hasCrashFlag
          ? '上次启动失败'
          : noAdapter
            ? '未检测到可用显卡'
            : '';

  if (software) {
    // 无 GPU 环境下的稳定组合：完全禁用 GPU 与合成器，走 CPU 光栅化
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-gpu-rasterization');
    app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
    app.commandLine.appendSwitch('no-sandbox');
    app.disableHardwareAcceleration();
    console.log(`[render] 软件渲染模式（${why}）`);
  } else {
    console.log('[render] 硬件加速模式');
  }

  // 本次启动后若窗口没能成功渲染就退出，标记会保留到下次启动
  try {
    fs.writeFileSync(crashFlag, String(Date.now()));
  } catch {
    /* ignore */
  }

  // 返回"是否该记住软件渲染偏好"：
  // - 参数/环境变量是用户当前这一次的选择，不该固化成偏好
  // - 偏好文件已存在则无需重复写
  // - 崩溃标记（上次失败过）与探测结论（没有显卡）都值得记下来，省掉下次的探测或试错
  return hasCrashFlag || noAdapter;
}

/** 窗口成功渲染后的收尾：清除崩溃标记，必要时记住软件渲染偏好 */
function onFirstPaint(wasFallback: boolean): void {
  try {
    const dir = app.getPath('userData');
    const crashFlag = path.join(dir, '.gpu-crash-flag');
    const prefPath = path.join(dir, '.software-render-pref');

    if (fs.existsSync(crashFlag)) fs.unlinkSync(crashFlag);

    // 用兼容模式跑通了，说明这台机器确实需要软件渲染，记下来省得下次再失败一遍
    if (wasFallback && !fs.existsSync(prefPath)) {
      fs.writeFileSync(prefPath, String(Date.now()));
      console.log('[render] 已记住软件渲染偏好，后续启动将直接使用');
    }
  } catch {
    /* ignore */
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1117',
    title: 'VPS Pilot',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win?.show();
    // 窗口真正渲染出来了，说明渲染链路正常
    onFirstPaint(usingSoftwareFallback);
    if (isDev) win?.webContents.openDevTools({ mode: 'detach' });
  });

  // 兜底：ready-to-show 只在「页面首次准备好绘制」时触发一次。
  // 如果渲染进程加载失败（开发模式下 dev server 没起来、或 HTML 报错），
  // 这个事件永远不会来 —— 窗口会一直停在 show:false 状态，
  // 用户看到的就是「双击了但什么都没发生」，进程却还活着。
  // 所以这里加一个超时兜底，无论如何都把窗口亮出来，
  // 让用户至少能看到界面或错误页，而不是对着空屏猜。
  const showFallback = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      console.warn('[window] ready-to-show 超时未触发，强制显示窗口以暴露问题');
      win.show();
    }
  }, 8000);
  win.once('closed', () => clearTimeout(showFallback));

  // 页面加载失败时明确报出来，而不是静默留白
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[render] 页面加载失败 (${code} ${desc}): ${url}`);
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  });

  agent.registerWindow(win);

  // 渲染进程崩溃诊断
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render] 渲染进程异常退出:', JSON.stringify(details));
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error('[preload] 加载失败:', p, err?.message);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`[console:${level}]`, message);
  });

  if (isDev) {
    win.loadURL(DEV_SERVER_URL!);
  } else {
    win.loadFile(INDEX_HTML);
  }

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    win = null;
  });
}

/* ============ IPC 辅助 ============ */

function ok<T>(data?: T): IpcResult<T> {
  return { ok: true, data };
}
function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function handle(channel: string, fn: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      const r = await fn(...args);
      if (r && typeof r === 'object' && 'ok' in r) return r;
      return ok(r);
    } catch (e) {
      console.error(`[ipc:${channel}]`, e);
      return fail(e);
    }
  });
}

/* ============ 注册所有 IPC ============ */

function registerIpc(): void {
  /* ---- 应用 ---- */
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    presets: PROVIDER_PRESETS,
  }));

  /* ---- 主机 ---- */
  handle('host:list', () => db.listHosts());

  handle('host:save', (input: HostInput) => {
    const now = Date.now();
    const existing = input.id ? db.getHost(input.id) : null;
    const id = input.id ?? shortId('h_');

    // 单主机代理覆盖：只在 mode === 'custom' 时处理密码加密
    const proxyMode = input.proxyMode ?? existing?.proxyMode ?? 'global';
    let proxy: ProxyConfig | undefined;
    if (proxyMode === 'custom' && input.proxy) {
      const p: ProxyInput = input.proxy;
      proxy = {
        type: p.type ?? 'socks5',
        host: (p.host ?? '').trim(),
        port: Number(p.port) || 7890,
        username: p.username?.trim() ?? '',
        // 传了新密码就加密覆盖；传空串清除；不传则保留
        encryptedPassword:
          p.password !== undefined && p.password !== ''
            ? encryptSecret(p.password)
            : p.password === ''
              ? undefined
              : existing?.proxy?.encryptedPassword,
      };
      proxy.hasPassword = !!proxy.encryptedPassword;
    } else if (proxyMode === 'custom' && !input.proxy) {
      proxy = existing?.proxy;
    }

    const host: HostConfig = {
      id,
      name: input.name.trim() || input.host,
      host: input.host.trim(),
      port: Number(input.port) || 22,
      username: input.username.trim() || 'root',
      authType: input.authType,
      // 密码：传了新值就加密覆盖，没传则保留原值
      encryptedPassword:
        input.password !== undefined && input.password !== ''
          ? encryptSecret(input.password)
          : existing?.encryptedPassword,
      privateKeyPath: input.privateKeyPath?.trim() || undefined,
      encryptedPassphrase:
        input.passphrase !== undefined && input.passphrase !== ''
          ? encryptSecret(input.passphrase)
          : existing?.encryptedPassphrase,
      jumpHostId: input.jumpHostId || undefined,
      proxyMode,
      proxy,
      tags: input.tags ?? [],
      note: input.note ?? '',
      defaultCwd: input.defaultCwd ?? '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    // 防止把自己设为跳板机导致循环
    if (host.jumpHostId === host.id) host.jumpHostId = undefined;

    db.upsertHost(host);
    return db.listHosts();
  });

  handle('host:delete', (id: string) => {
    ssh.disconnect(id);
    db.deleteHost(id);
    return db.listHosts();
  });

  handle('host:hasCredential', (id: string) => {
    const h = db.getHost(id);
    return { hasPassword: !!h?.encryptedPassword, hasPassphrase: !!h?.encryptedPassphrase };
  });

  /* ---- 连接 ---- */
  handle('conn:connect', (hostId: string) => ssh.connect(hostId));
  handle('conn:disconnect', (hostId: string) => {
    ssh.disconnect(hostId);
    return true;
  });
  handle('conn:status', (hostId: string) => {
    const c = ssh.getConn(hostId);
    return c ? { status: c.status, error: c.error } : { status: 'disconnected' as const };
  });
  handle('conn:probe', (hostId: string) => agent.probeHost(hostId));

  /* ---- 代理 ---- */
  handle('proxy:get', () => {
    const s = db.getSettings();
    return { ...normalizeProxy(s.defaultProxy), hasPassword: !!s.defaultProxy?.encryptedPassword };
  });

  handle('proxy:save', (input: ProxyInput) => {
    const s = db.getSettings();
    const prev = s.defaultProxy;
    const next = {
      type: input.type ?? 'none',
      host: (input.host ?? '').trim(),
      port: Number(input.port) || 7890,
      username: input.username?.trim() ?? '',
      encryptedPassword:
        input.password !== undefined && input.password !== ''
          ? encryptSecret(input.password)
          : input.password === ''
            ? undefined
            : prev?.encryptedPassword,
    };
    db.setSettings({ defaultProxy: next });
    return { ...normalizeProxy(next), hasPassword: !!next.encryptedPassword };
  });

  handle('proxy:test', async (input?: ProxyInput) => {
    let cfg: ProxyConfig;
    if (input && input.type !== undefined) {
      // 测试草稿配置（用户还没保存）
      const s = db.getSettings();
      cfg = {
        type: input.type,
        host: (input.host ?? '').trim(),
        port: Number(input.port) || 7890,
        username: input.username?.trim() ?? '',
        encryptedPassword:
          input.password !== undefined && input.password !== ''
            ? encryptSecret(input.password)
            : input.password === ''
              ? undefined
              : s.defaultProxy?.encryptedPassword,
      };
    } else {
      cfg = normalizeProxy(db.getSettings().defaultProxy);
    }
    return testProxy(cfg);
  });

  handle('proxy:detect', () => detectLocalProxies());

  handle('proxy:describe', (hostId: string) => {
    const h = db.getHost(hostId);
    if (!h) return { text: '直连', type: 'none' as const };
    const p = resolveProxyForHost(h);
    return { text: describeProxy(p), type: p.type };
  });

  /* ---- 连接诊断 ---- */
  handle('diag:run', async (hostId: string) => {
    const host = db.getHost(hostId);
    if (!host) return { ok: false, error: '主机不存在' } as any;
    return diagnose(host);
  });

  /* ==== 剪贴板（终端粘贴用） ==== */
  handle('clipboard:read', () => clipboard.readText());
  handle('clipboard:write', (text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  /* ---- 终端 ---- */
  handle('term:open', async (hostId: string, cols: number, rows: number) => {
    const c = ssh.getConn(hostId);
    if (c?.shell) return { sessionId: hostId };
    await ssh.openShell(
      hostId,
      cols,
      rows,
      (chunk) => {
        // 服务端留一份副本：MCP 工具「读取终端输出」依赖它，否则历史只存在于
        // 渲染进程的 xterm 里，外部 Agent 无从查起。tee 是无副作用的旁路，
        // 即使缓冲内部出错也不能影响终端本身的显示。
        try {
          terminalBuffer.append(hostId, chunk);
        } catch (e) {
          console.error('[term:buffer]', e);
        }
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('term:data', { hostId, chunk });
        }
      },
      (code) => {
        try {
          terminalBuffer.close(hostId);
        } catch (e) {
          console.error('[term:buffer]', e);
        }
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('term:close', { hostId, code });
        }
      }
    );
    return { sessionId: hostId };
  });
  handle('term:write', (hostId: string, data: string) => {
    ssh.writeShell(hostId, data);
    return true;
  });
  handle('term:resize', (hostId: string, cols: number, rows: number) => {
    ssh.resizeShell(hostId, cols, rows);
    return true;
  });

  /* ---- 专家（Persona） ---- */
  handle('expert:list', () => registry.listExperts(db.listCustomExperts()));

  handle('expert:save', (input: ExpertInput) => {
    const existing = input.id ? db.getCustomExpert(input.id) : null;
    // 内置专家不允许被直接改写 —— 前端应该走「复制为自定义」
    if (existing?.builtin) {
      return { ok: false, error: '内置专家不可编辑，请先「复制为自定义」' };
    }
    const rec = registry.normalizeExpertInput(input, existing);
    rec.id = rec.id || shortId('exp_');
    db.upsertExpert(rec);
    return { ok: true, data: rec };
  });

  /** 把任意专家（含内置）复制成一份可编辑的自定义专家 */
  handle('expert:duplicate', (id: string) => {
    const src = registry.findExpert(db.listCustomExperts(), id);
    if (!src) return { ok: false, error: '专家不存在' };
    const copy: ExpertConfig = {
      ...src,
      id: shortId('exp_'),
      name: `${src.name}（副本）`,
      builtin: false,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.upsertExpert(copy);
    return { ok: true, data: copy };
  });

  handle('expert:delete', (id: string) => {
    if (BUILTIN_EXPERTS.some((e) => e.id === id)) {
      return { ok: false, error: '内置专家不可删除，只能停用' };
    }
    db.deleteExpert(id);
    // 如果删掉的正是默认专家，回退到内置通用
    const s = db.getSettings();
    if (s.defaultExpertId === id) db.setSettings({ defaultExpertId: 'expert_general' });
    return { ok: true, data: registry.listExperts(db.listCustomExperts()) };
  });

  /** 启用/停用专家（内置走 disabledExpertIds，自定义直接改记录） */
  handle('expert:setEnabled', (id: string, enabled: boolean) => {
    const isBuiltin = BUILTIN_EXPERTS.some((e) => e.id === id);
    if (isBuiltin) {
      const s = db.getSettings();
      const off = new Set(s.disabledExpertIds ?? []);
      if (enabled) off.delete(id);
      else off.add(id);
      db.setSettings({ disabledExpertIds: Array.from(off) });
      // 停用中的专家如果正被设为默认，回退到通用
      if (!enabled && s.defaultExpertId === id) {
        db.setSettings({ defaultExpertId: 'expert_general' });
      }
    } else {
      const rec = db.getCustomExpert(id);
      if (rec) db.upsertExpert({ ...rec, enabled, updatedAt: Date.now() });
    }
    return { ok: true, data: registry.listExperts(db.listCustomExperts()) };
  });

  /* ---- 技能（Skill） ---- */
  handle('skill:list', () => registry.listSkills(db.listCustomSkills()));

  handle('skill:save', (input: SkillInput) => {
    const existing = input.id ? db.getCustomSkill(input.id) : null;
    if (existing?.builtin) {
      return { ok: false, error: '内置技能不可编辑，请先「复制为自定义」' };
    }
    const rec = registry.normalizeSkillInput(input, existing);
    rec.id = rec.id || shortId('sk_');
    db.upsertSkill(rec);
    return { ok: true, data: rec };
  });

  handle('skill:duplicate', (id: string) => {
    const src = registry.findSkill(db.listCustomSkills(), id);
    if (!src) return { ok: false, error: '技能不存在' };
    const copy: SkillConfig = {
      ...src,
      id: shortId('sk_'),
      name: `${src.name}（副本）`,
      builtin: false,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.upsertSkill(copy);
    return { ok: true, data: copy };
  });

  handle('skill:delete', (id: string) => {
    if (BUILTIN_SKILLS.some((s) => s.id === id)) {
      return { ok: false, error: '内置技能不可删除，只能停用' };
    }
    db.deleteSkill(id);
    const s = db.getSettings();
    db.setSettings({ defaultSkillIds: (s.defaultSkillIds ?? []).filter((x) => x !== id) });
    return { ok: true, data: registry.listSkills(db.listCustomSkills()) };
  });

  handle('skill:setEnabled', (id: string, enabled: boolean) => {
    const isBuiltin = BUILTIN_SKILLS.some((s) => s.id === id);
    if (isBuiltin) {
      const s = db.getSettings();
      const off = new Set(s.disabledSkillIds ?? []);
      if (enabled) off.delete(id);
      else off.add(id);
      db.setSettings({ disabledSkillIds: Array.from(off) });
    } else {
      const rec = db.getCustomSkill(id);
      if (rec) db.upsertSkill({ ...rec, enabled, updatedAt: Date.now() });
    }
    return { ok: true, data: registry.listSkills(db.listCustomSkills()) };
  });

  /** 按任务描述推荐技能（关键词匹配，结果可解释） */
  handle('skill:recommend', (task: string) =>
    registry.recommendSkills(db.listCustomSkills(), task).map((r) => ({
      id: r.skill.id,
      name: r.skill.name,
      matched: r.matched,
    }))
  );

  /* ---- 命令执行 ---- */
  handle('cmd:exec', (hostId: string, command: string, cwd?: string) =>
    agent.runManualCommand(hostId, command, { cwd })
  );
  handle('cmd:assess', (command: string) => {
    const s = db.getSettings();
    return { risk: assessRisk(command, s.extraDangerPatterns), readonly: isReadonlyCommand(command) };
  });

  /* ---- Agent ---- */
  handle('agent:run', (params: any) =>
    agent.startRun({
      hostId: params.hostId,
      task: params.task,
      approvalMode: params.approvalMode,
      expertId: params.expertId,
      skills: params.skills,
    })
  );
  handle('agent:approvePlan', (runId: string) => agent.approvePlan(runId));
  handle('agent:decide', (runId: string, stepId: string, decision: any) =>
    agent.decideStep(runId, stepId, decision)
  );
  handle('agent:abort', (runId: string) => agent.abortRun(runId));

  /* ---- SFTP ---- */
  handle('sftp:list', (hostId: string, dir: string) => ssh.listDir(hostId, dir));
  handle('sftp:mkdir', (hostId: string, p: string) => ssh.mkdirRemote(hostId, p).then(() => true));
  handle('sftp:remove', (hostId: string, p: string, isDir: boolean) =>
    ssh.removeRemote(hostId, p, isDir).then(() => true)
  );
  handle('sftp:rename', (hostId: string, from: string, to: string) =>
    ssh.renameRemote(hostId, from, to).then(() => true)
  );
  handle('sftp:read', (hostId: string, p: string) => ssh.readRemoteFile(hostId, p));
  handle('sftp:write', (hostId: string, p: string, content: string) =>
    ssh.writeRemoteFile(hostId, p, content).then(() => true)
  );
  handle('sftp:download', async (hostId: string, remotePath: string) => {
    const name = path.basename(remotePath);
    const result = await dialog.showSaveDialog({
      defaultPath: name,
      title: '保存到本地',
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await ssh.downloadFile(hostId, remotePath, result.filePath);
    return { canceled: false, path: result.filePath };
  });
  handle('sftp:upload', async (hostId: string, remoteDir: string) => {
    const result = await dialog.showOpenDialog({
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return { canceled: true, uploaded: [] };
    const uploaded: string[] = [];
    for (const p of result.filePaths) {
      const target = remoteDir.replace(/\/$/, '') + '/' + path.basename(p);
      await ssh.uploadFile(hostId, p, target);
      uploaded.push(target);
    }
    return { canceled: false, uploaded };
  });
  handle('sftp:pickKeyFile', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择私钥文件',
      properties: ['openFile'],
      filters: [{ name: '私钥', extensions: ['pem', 'key', 'ppk', '*'] }],
    });
    return { canceled: r.canceled, path: r.filePaths[0] };
  });

  /* ---- 模型 ---- */
  handle('model:list', () =>
    db.listModels().map((m) => ({ ...m, encryptedApiKey: undefined, hasApiKey: !!m.encryptedApiKey }))
  );

  handle('model:save', (input: ModelInput) => {
    const existing = input.id ? db.getModel(input.id) : null;
    const id = input.id ?? shortId('m_');
    const mc: ModelConfig = {
      id,
      label: input.label.trim() || input.model,
      providerId: input.providerId,
      baseUrl: input.baseUrl.trim(),
      encryptedApiKey:
        input.apiKey !== undefined && input.apiKey !== ''
          ? encryptSecret(input.apiKey)
          : existing?.encryptedApiKey,
      model: input.model.trim(),
      temperature: input.temperature ?? 0.2,
      maxTokens: input.maxTokens ?? 4096,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    db.upsertModel(mc);
    // 第一个模型自动设为当前
    const s = db.getSettings();
    if (!s.activeModelId) db.setSettings({ activeModelId: id });
    return db.listModels().map((m) => ({ ...m, encryptedApiKey: undefined, hasApiKey: !!m.encryptedApiKey }));
  });

  handle('model:delete', (id: string) => {
    db.deleteModel(id);
    const s = db.getSettings();
    if (s.activeModelId === id) {
      const rest = db.listModels();
      db.setSettings({ activeModelId: rest[0]?.id ?? null });
    }
    return db.listModels().map((m) => ({ ...m, encryptedApiKey: undefined, hasApiKey: !!m.encryptedApiKey }));
  });

  handle('model:test', async (id: string) => {
    const mc = db.getModel(id);
    if (!mc) return { ok: false, error: '模型配置不存在' };
    return testModel(mc);
  });

  handle('model:testDraft', async (input: ModelInput) => {
    const mc: ModelConfig = {
      id: 'draft',
      label: 'draft',
      providerId: input.providerId,
      baseUrl: input.baseUrl,
      encryptedApiKey: input.apiKey ? encryptSecret(input.apiKey) : undefined,
      model: input.model,
      temperature: 0.2,
      maxTokens: 64,
      createdAt: Date.now(),
    };
    return testModel(mc);
  });

  /* ---- 设置 ---- */
  handle('settings:get', () => {
    const s = db.getSettings();
    // 下发给渲染进程时剥掉密文，只保留"有没有密码"
    return {
      ...s,
      defaultProxy: {
        ...normalizeProxy(s.defaultProxy),
        encryptedPassword: undefined,
        hasPassword: !!s.defaultProxy?.encryptedPassword,
      },
    };
  });
  handle('settings:set', async (patch: Record<string, unknown>) => {
    const before = db.getSettings();
    const after = db.setSettings(patch);
    // MCP 的开关 / 端口 / Token 变化需要重启监听才能生效。
    // 只改审批策略或权限开关则无需重启 —— 工具门控每次调用都读最新设置。
    if (patch && typeof patch === 'object' && 'mcp' in patch) {
      try {
        await mcp.applySettings(after.mcp);
      } catch (e: any) {
        console.error('[mcp] 应用设置失败', e);
      }
    } else if (before.mcp?.enabled !== after.mcp?.enabled) {
      try {
        await mcp.applySettings(after.mcp);
      } catch (e: any) {
        console.error('[mcp] 应用设置失败', e);
      }
    }
    return after;
  });

  /* ---- MCP 服务 ---- */
  handle('mcp:status', () => ({
    status: mcp.getState(),
    settings: db.getSettings().mcp,
  }));

  handle('mcp:snippets', () => mcp.clientSnippets(db.getSettings().mcp));

  handle('mcp:generateToken', () => mcp.generateToken());

  /** 一键重启：端口被占用或状态卡住时用 */
  handle('mcp:restart', async () => {
    await mcp.stop('手动重启');
    const s = db.getSettings().mcp;
    await mcp.start(s);
    return { status: mcp.getState(), settings: s };
  });

  /** 界面上的审批按钮回调 —— 与 MCP 工具 decide_approval 等价 */
  handle('mcp:decideApproval', (id: string, approve: boolean) => mcp.decideApproval(id, approve));

  /** 工具清单预览（界面上展示「外部 Agent 能用哪些能力」） */
  handle('mcp:tools', () => mcp.availableTools(db.getSettings().mcp));

  /** 待审批列表 */
  handle('mcp:pending', () => mcp.listPendingApprovals());

  /* ---- 审计 ---- */
  handle('audit:list', (opts: any) => db.listAudit(opts ?? {}));
  handle('audit:clear', () => {
    db.clearAudit();
    return true;
  });

  /* ---- 对话式直连（不生成计划，纯问答辅助） ---- */
  handle('chat:quick', async (prompt: string, hostId?: string) => {
    const s = db.getSettings();
    if (!s.activeModelId) return { ok: false, error: '未配置模型' };
    const mc = db.getModel(s.activeModelId);
    if (!mc) return { ok: false, error: '模型配置不存在' };
    const host = hostId ? db.getHost(hostId) : null;
    const ctxText = host ? `当前服务器：${host.name} (${host.host})，登录用户 ${host.username}` : '';
    const reply = await chat(mc, [
      { role: 'system', content: `你是 Linux 运维专家，回答简洁准确。${ctxText}` },
      { role: 'user', content: prompt },
    ]);
    return { ok: true, reply };
  });
}

/* ============ 生命周期 ============ */

// 单实例锁
//
// 踩过的坑：锁拿不到时直接 app.quit() 是完全静默的 —— 窗口不出现、
// 进程瞬间消失、控制台也没有任何输出。用户看到的只有「双击了，没反应」，
// 根本无从判断是崩溃、卡死，还是被另一个实例顶掉了。
// 所以这里在退出前把原因和解法打印出来。
//
// 开发模式下尤其容易踩：如果上一个 dev 实例没退干净（比如 dev server
// 还在、Electron 主进程被 Ctrl+C 打断后残留），新实例就会一直拿不到锁。
// 因此 dev 环境下额外打印强杀命令。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  const isDevEnv = !app.isPackaged;
  console.error('');
  console.error('  [启动中止] 已有一个 VPS Pilot 实例正在运行，本进程已退出。');
  console.error('');
  console.error('  这是正常的单实例保护：同一时间只允许一个实例，');
  console.error('  避免两个进程同时操作同一份数据库和 SSH 会话。');
  console.error('');
  if (isDevEnv) {
    console.error('  如果那个实例的窗口已经不见了（残留进程），请先在');
    console.error('  任务管理器结束所有 electron.exe，或执行：');
    console.error('      taskkill /F /IM electron.exe');
    console.error('  然后重新运行「开发模式.bat」。');
  } else {
    console.error('  请切换到已打开的窗口，或关闭它之后重新启动。');
  }
  console.error('');
  app.quit();
} else {
  usingSoftwareFallback = configureRendering();

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    db.initDb();
    // registry 需要读设置来判断哪些内置专家/技能被停用。
    // 用注入而不是直接 import，是为了让 registry 能在纯 Node 测试里跑起来。
    registry.setSettingsProvider(() => db.getSettings());
    // agent 内部也会经由 registry 读设置，同样在启动时接上
    agent.initAgent();

    // MCP 服务的广播口：把状态、工具调用、待审批请求推给界面。
    // 不能直接用 BrowserWindow，因为 service 层要在测试环境可跑 —— 走回调注入。
    mcp.setBroadcaster((e) => {
      if (e?.type === 'term_data' && e.hostId) {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('term:data', { hostId: e.hostId, chunk: e.chunk });
        }
        return;
      }
      if (e?.type === 'term_close' && e.hostId) {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('term:close', { hostId: e.hostId });
        }
        return;
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('mcp:event', e);
      }
    });

    registerIpc();
    createWindow();

    // 按设置启动 MCP 服务。失败不阻塞应用启动 —— 用户能在设置页看到原因。
    void mcp.start(db.getSettings().mcp).catch((e) => {
      console.error('[mcp] 启动失败', e);
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    db.flush();
    ssh.disconnectAll();
    void mcp.stop('应用窗口已关闭');
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    db.flush();
    ssh.disconnectAll();
    void mcp.stop('应用退出中');
  });
}

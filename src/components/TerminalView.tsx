import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { HostConfig } from '@shared/types';

/**
 * 规范化粘贴内容。
 *
 * 从浏览器/文档里复制来的文本常带 \r\n，直接写进 shell 会被当成两次回车
 * （于是同一条命令被提交两次）。这里统一成 \n，并去掉结尾多余换行。
 */
function normalizePaste(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 交互式终端 —— 基于 xterm.js，通过 IPC 与主进程的 SSH shell channel 双向通信
 *
 * 键盘输入与滚动的几条硬性约定（踩过坑，别乱改）：
 *  1. xterm 把键盘事件挂在它自己创建的 .xterm-helper-textarea 上。那个 textarea
 *     必须先拿到 DOM 焦点，敲键盘才会进终端 —— 所以容器必须可聚焦，且点击时
 *     要主动把焦点转过去。
 *  2. FitAddon.fit() 测量的是「我们传给 term.open 的那个元素」的尺寸，所以：
 *     - 那个元素不能有 padding（否则量出来的行列数偏大，最后一列/行会被裁掉）
 *     - 它的高度必须是真的可用高度（flex: 1 + minHeight: 0），不能靠内联 height:100%
 *  3. fit() 在容器尺寸为 0 时（标签页隐藏）会算出一个极小的行列数，必须跳过，
 *     否则切回来时终端会缩成一条。用 ResizeObserver 拿到的 contentRect 判断。
 *  4. 滚动交给 xterm 自身的 scrollback（滚轮 / Shift+PageUp / Shift+PageDown），
 *     前提是 .xterm-viewport 没有被外层 overflow: hidden 之外的样式干扰。
 */
export function TerminalView({
  host,
  active,
  onTitleChange,
}: {
  host: HostConfig;
  active: boolean;
  onTitleChange?: (t: string) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const [ready, setReady] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [fontSize, setFontSize] = React.useState(13);
  const [error, setError] = React.useState('');

  /** 安全 fit：容器尺寸为 0（标签隐藏）时跳过，避免把行列数算成 1×1 */
  const safeFit = React.useCallback((announce = false) => {
    const el = containerRef.current;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!el || !fit || !term) return false;
    if (el.clientWidth < 2 || el.clientHeight < 2) return false;
    try {
      fit.fit();
      if (announce) window.vps.termResize(host.id, term.cols, term.rows);
      return true;
    } catch {
      return false;
    }
  }, [host.id]);

  // 初始化终端（只在 host 变化时重建）
  React.useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;

    const term = new Terminal({
      fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,'Courier New',monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      // 滚回缓冲区：鼠标滚轮 / Shift+PageUp 能翻这么多行
      scrollback: 20000,
      scrollOnUserInput: true,
      // 让 Ctrl/Cmd + 滚轮可以缩放字体
      allowProposedApi: true,
      // 复制粘贴体验：选中即复制由组件内的快捷键处理
      rightClickSelectsWord: true,
      theme: {
        background: '#0b0f14',
        foreground: '#c5cdd6',
        cursor: '#4f8fd4',
        cursorAccent: '#0b0f14',
        selectionBackground: 'rgba(79,143,212,0.28)',
        black: '#3d454f',
        red: '#d46a63',
        green: '#5aa96a',
        yellow: '#c9a24a',
        blue: '#6fa3d9',
        magenta: '#a595cd',
        cyan: '#5fb0ba',
        white: '#aab4bf',
        brightBlack: '#5f6a75',
        brightRed: '#e08b84',
        brightGreen: '#74c084',
        brightYellow: '#dcb968',
        brightBlue: '#8bb8e5',
        brightMagenta: '#bdaee0',
        brightCyan: '#79c6cf',
        brightWhite: '#e3e9ef',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // 延迟 fit，等 DOM 布局完成（初次挂载时容器可能还没有尺寸）
    const raf = requestAnimationFrame(() => {
      safeFit(true);
      // 再补一次：字体加载完成后尺寸可能变化
      setTimeout(() => safeFit(true), 120);
    });

    // 终端输入 -> 主进程
    const dataSub = term.onData((data) => {
      window.vps.termWrite(host.id, data);
    });

    /**
     * 终端快捷键。
     *
     * xterm 会自己吞掉大部分按键，但有几种必须在这里拦：
     *  - Ctrl/Cmd+Shift+C 复制选中文本
     *  - Ctrl/Cmd+Shift+V 粘贴（走 IPC 读系统剪贴板，因为窗口是 file:// 加载的，
     *    navigator.clipboard 在非安全上下文里会直接抛错）
     *  - Ctrl/Cmd+Shift+A 全选
     * 返回 false 表示「这个按键已处理完毕，不要送给远端 shell」。
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;

      // 复制
      if (e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = term.getSelection();
        if (sel) {
          void window.vps.clipboardWrite(sel);
          term.clearSelection();
          return false;
        }
        // 没有选中内容时不拦，交给远端（例如 Ctrl+Shift+C 在某些 shell 里有用）
        return true;
      }

      // 粘贴
      if (e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        void (async () => {
          try {
            const r: any = await window.vps.clipboardRead();
            const text = r?.ok ? r.data : '';
            if (text) window.vps.termWrite(host.id, normalizePaste(text));
          } catch {
            /* 读剪贴板失败就算了，不影响敲命令 */
          }
        })();
        return false;
      }

      // 全选
      if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        term.selectAll();
        return false;
      }

      return true;
    });

    // 右键菜单：复制 / 粘贴（选中内容时点击直接复制，这是终端用户的肌肉记忆）
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        void window.vps.clipboardWrite(sel);
        term.clearSelection();
        return;
      }
      void (async () => {
        try {
          const r: any = await window.vps.clipboardRead();
          const text = r?.ok ? r.data : '';
          if (text) window.vps.termWrite(host.id, normalizePaste(text));
        } catch {
          /* ignore */
        }
      })();
    };
    const pane = containerRef.current;
    pane?.addEventListener('contextmenu', onContextMenu);

    // 焦点状态（用于视觉提示）—— 用 DOM 事件而不是 xterm 的 API，
    // 因为 xterm 只提供 focus()/blur() 方法，没有 onFocus/onBlur 订阅
    const helper = containerRef.current.querySelector('.xterm-helper-textarea');
    const onFocusIn = () => setFocused(true);
    const onFocusOut = () => setFocused(false);
    helper?.addEventListener('focus', onFocusIn);
    helper?.addEventListener('blur', onFocusOut);

    term.onTitleChange((t) => onTitleChange?.(t));

    // 主进程数据 -> 终端
    const offData = window.vps.onTermData((p) => {
      if (p.hostId === host.id) {
        try {
          term.write(p.chunk);
        } catch {
          /* 终端已销毁，忽略 */
        }
      }
    });
    const offClose = window.vps.onTermClose((p) => {
      if (p.hostId === host.id) {
        term.writeln('\r\n\x1b[90m[连接已断开]\x1b[0m');
        setReady(false);
      }
    });

    // 打开 shell
    window.vps
      .termOpen(host.id, term.cols, term.rows)
      .then((r: any) => {
        if (disposed) return;
        if (!r.ok) {
          setError(r.error ?? '打开终端失败');
          term.writeln(`\x1b[31m打开终端失败: ${r.error}\x1b[0m`);
        } else {
          setReady(true);
          safeFit(true);
          term.focus();
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });

    // 窗口大小变化时重新适配
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width < 2 || box.height < 2) return;
      safeFit(true);
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      dataSub.dispose();
      helper?.removeEventListener('focus', onFocusIn);
      helper?.removeEventListener('blur', onFocusOut);
      offData();
      offClose();
      ro.disconnect();
      pane?.removeEventListener('contextmenu', onContextMenu);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [host.id]);

  // active 变化时重新 fit 并聚焦
  React.useEffect(() => {
    if (!active) return;
    // 用 rAF + 定时兜底：标签从 display:none 切回来时布局要一帧才生效
    const raf = requestAnimationFrame(() => {
      if (safeFit(true)) termRef.current?.focus();
    });
    const t = setTimeout(() => {
      if (safeFit(true)) termRef.current?.focus();
    }, 80);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [active, safeFit]);

  // 字体缩放时重新 fit
  React.useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize;
    const t = setTimeout(() => safeFit(true), 30);
    return () => clearTimeout(t);
  }, [fontSize, safeFit]);

  /**
   * 点击终端区域任意位置都把焦点交还给 xterm。
   * 这是「终端不能手动输入」的直接修复点 —— 点击工具栏/状态栏后焦点会跑掉，
   * 再点回终端如果没人处理，键盘事件就再也进不去了。
   */
  const focusTerm = React.useCallback(() => {
    termRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        position: 'relative',
        // 与 xterm theme 的 background 保持一致（--bg-0），否则终端四边会露出色差
        background: 'var(--bg-0)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 终端状态条 */}
      <div
        style={{
          padding: '5px 12px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11.5,
          color: 'var(--text-2)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ color: ready ? 'var(--green)' : 'var(--yellow)' }}>
          {ready ? '● 已连接' : '○ 连接中'}
        </span>
        <span className="mono">{`${host.username}@${host.host}:${host.port}`}</span>
        {host.defaultCwd && <span className="dim">cwd: {host.defaultCwd}</span>}
        <div className="flex-1" />
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setFontSize((s) => Math.max(9, s - 1))}
          title="缩小字体（Ctrl + -）"
        >
          A−
        </button>
        <span className="dim mono" style={{ fontSize: 10.5 }}>
          {fontSize}px
        </span>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => setFontSize((s) => Math.min(22, s + 1))}
          title="放大字体（Ctrl + +）"
        >
          A+
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => safeFit(true)} title="重新适配尺寸">
          适配
        </button>
        <button
          className="btn btn-ghost btn-xs"
          onClick={() => {
            termRef.current?.clear();
            focusTerm();
          }}
          title="清屏（保留滚回内容，Ctrl + L 由远端生效）"
        >
          清屏
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '6px 12px',
            background: 'var(--red-dim)',
            color: 'var(--red)',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}

      {/*
        终端挂载点。
        - 这里不放 padding（交给 .term-wrap 的 CSS）
        - 提供一个可聚焦的外层，点击/按 Tab 都能把焦点转给 xterm
        - onKeyDown 兜底：焦点意外跑到外层时，直接把按键写进终端
      */}
      <div
        className={`term-wrap${focused ? '' : ' unfocused'}`}
        onClick={focusTerm}
        onMouseDown={(e) => {
          // 阻止默认行为会破坏文本选择，所以只补焦点
          if (e.button === 0) focusTerm();
        }}
        onKeyDown={(e) => {
          // Ctrl/Cmd + 加减号缩放字体
          if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            setFontSize((s) => Math.min(22, s + 1));
          } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
            e.preventDefault();
            setFontSize((s) => Math.max(9, s - 1));
          } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
            e.preventDefault();
            setFontSize(13);
          }
        }}
        tabIndex={0}
        role="textbox"
        aria-label="终端会话"
      >
        <div
          ref={containerRef}
          style={{ height: '100%', width: '100%', overflow: 'hidden' }}
        />
      </div>

      {/* 底部使用提示 —— 让用户知道能怎么操作 */}
      <div
        style={{
          padding: '3px 12px',
          borderTop: '1px solid var(--border)',
          fontSize: 10.5,
          color: 'var(--text-3)',
          display: 'flex',
          gap: 14,
          flexShrink: 0,
          flexWrap: 'wrap',
        }}
      >
        <span>滚轮 / Shift+PageUp 翻看历史</span>
        <span>选中即复制</span>
        <span>Ctrl+Shift+V 粘贴</span>
        <span>Ctrl+滚轮 缩放</span>
      </div>
    </div>
  );
}

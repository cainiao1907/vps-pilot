import React from 'react';
import type { HostConfig, RiskLevel } from '@shared/types';
import { RISK_META } from '@shared/risk';

export { RISK_META };

/** 风险徽章 */
export function RiskBadge({ level, small }: { level: RiskLevel; small?: boolean }) {
  const m = RISK_META[level];
  return (
    <span
      className="badge"
      style={{ background: m.bg, color: m.color, fontSize: small ? 10 : 11 }}
      title={m.label}
    >
      {m.label}
    </span>
  );
}

/** 连接状态点 */
export function StatusDot({ status }: { status: string }) {
  const map: Record<string, { c: string; t: string }> = {
    connected: { c: 'var(--green)', t: '已连接' },
    connecting: { c: 'var(--yellow)', t: '连接中' },
    error: { c: 'var(--red)', t: '连接失败' },
    disconnected: { c: 'var(--text-3)', t: '未连接' },
  };
  const s = map[status] ?? map.disconnected;
  return (
    <span
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: s.c,
        boxShadow: status === 'connected' ? `0 0 6px ${s.c}` : 'none',
        flexShrink: 0,
      }}
      className={status === 'connecting' ? 'pulsing' : ''}
      title={s.t}
    />
  );
}

/**
 * 模态框
 *
 * 【务必保留下面的事件约定，否则会静默破坏终端输入】
 * 这里在 window 上挂 keydown 监听器来处理 Escape。window 上的监听器处于
 * 事件流的冒泡末端，但 xterm 把键盘事件挂在它自己的 .xterm-helper-textarea 上 ——
 * 两者都会收到按键。曾经这里的实现是「只要 key 是 Escape 就关」，看似无害，
 * 实际有两个问题：
 *
 *   1. 每次开关模态框都注册一次监听器，dispose 一旦漏掉就累积成 N 个幽灵监听器，
 *      终端里每次敲 Escape 都会触发一串「幽灵模态框关闭」；
 *   2. 更关键的是它让「终端某次按键没反应」这类问题极难定位 —— 因为监听器
 *      本身不阻止冒泡，却在被卸载的组件上调用 setState。
 *
 * 现在的规则：**只有当焦点确实落在本模态框内部时才响应 Escape**。
 * 焦点在别处（比如终端）时，这个监听器必须完全透明 —— 不 preventDefault、
 * 不 stopPropagation、不做任何状态变更。
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  // 用 ref 保存最新的 onClose：避免调用方每次渲染传入新函数都重新注册监听器
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const root = rootRef.current;
      const active = document.activeElement as Node | null;
      // 焦点不在本模态框内 → 这个按键属于别的区域（通常是终端），不要动它
      if (!root || !active || !root.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // 打开时把焦点移进模态框，这样上面的 Escape 判断才有意义，
  // 同时也避免焦点留在终端里导致「模态框开着但快捷键仍在发给远端」
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = root.querySelector<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, button, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
    return () => {
      // 关闭后把焦点还回去，否则焦点会掉到 body 上，终端再也收不到键盘事件
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="modal-mask"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * 单行文本输入弹窗。
 *
 * Electron **不支持 window.prompt()**（调用直接抛异常），所以「新建目录」「改名」
 * 这类需要用户输入一个小值的场景必须用模态框实现。确认键支持 Enter 直提。
 */
export function InputModal({
  title,
  label,
  initialValue = '',
  placeholder,
  confirmText = '确定',
  onClose,
  onSubmit,
}: {
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmText?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = React.useState(initialValue);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onClose();
  };
  return (
    <Modal title={title} onClose={onClose} width={420}>
      <div className="field" style={{ marginBottom: 0 }}>
        {label && <label className="field-label">{label}</label>}
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>
      <div className="row gap-8" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={!value.trim()}>
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}

/** 空状态 */
export function Empty({
  icon,
  title,
  desc,
  action,
}: {
  icon?: string;
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div style={{ fontSize: 34, opacity: 0.35 }}>{icon}</div>}
      <div className="empty-title">{title}</div>
      {desc && <div style={{ maxWidth: 400, fontSize: 12.5, lineHeight: 1.7 }}>{desc}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

/** 复制按钮 */
export function CopyBtn({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      className="btn btn-ghost btn-xs"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      title="复制到剪贴板"
    >
      {done ? '已复制' : label}
    </button>
  );
}

/** 格式化字节 */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 格式化时间 */
export function fmtTime(ts: number | undefined): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间 */
export function fmtRel(ts: number | undefined): string {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/** 主机显示名 */
export function hostLabel(h: HostConfig): string {
  return `${h.username}@${h.host}${h.port !== 22 ? ':' + h.port : ''}`;
}

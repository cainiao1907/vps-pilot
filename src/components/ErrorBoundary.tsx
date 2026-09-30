import React from 'react';

/**
 * 错误边界
 *
 * 为什么必须有：React 18 里，任何一个组件在渲染期间抛错，React 会卸载
 * **整棵** 子树。没有错误边界时，这棵子树的根就是 <App />，于是整个窗口
 * 变成一片空白 —— 用户看到的正是「窗口显示有问题，内容区全空」。
 *
 * 加上边界后，出错只会影响出错的那一块（例如某个终端的渲染），
 * 其余界面照常工作，同时把错误信息和解法直接摆给用户看。
 */

interface Props {
  children: React.ReactNode;
  /** 出错时展示的区域名，便于定位 */
  label?: string;
  /** 自定义兜底 UI；不传则用内置卡片 */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 保留组件栈，方便在 DevTools 里定位
    const stack = (info?.componentStack ?? '').split('\n').slice(0, 12).join('\n');
    this.setState({ info: stack });
    console.error('[ErrorBoundary]', this.props.label ?? '', error, stack);
  }

  reset = (): void => {
    this.setState({ error: null, info: '' });
  };

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        style={{
          height: '100%',
          overflowY: 'auto', overscrollBehavior: 'contain',
          padding: 24,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            maxWidth: 680,
            width: '100%',
            background: 'var(--bg-2)',
            border: '1px solid rgba(248,81,73,0.35)',
            borderRadius: 10,
            padding: 18,
          }}
        >
          <div className="row gap-8" style={{ marginBottom: 10 }}>
            <span style={{ fontSize: 18, color: 'var(--red)' }}>⚠</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--red)' }}>
                这块界面出错了{this.props.label ? ` · ${this.props.label}` : ''}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                其他区域不受影响，你可以点「重试」恢复，或直接切换标签页继续用。
              </div>
            </div>
            <button className="btn btn-sm btn-primary" onClick={this.reset}>
              重试
            </button>
          </div>

          <div
            style={{
              background: 'var(--bg-0)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '10px 12px',
              fontSize: 11.5,
              lineHeight: 1.7,
              color: 'var(--text-1)',
              wordBreak: 'break-word',
            }}
          >
            <div className="mono" style={{ color: 'var(--red)', marginBottom: info ? 8 : 0 }}>
              {error.message || String(error)}
            </div>
            {info && (
              <pre
                className="mono"
                style={{
                  margin: 0,
                  fontSize: 10.5,
                  color: 'var(--text-3)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 220,
                  overflowY: 'auto', overscrollBehavior: 'contain',
                }}
              >
                {info}
              </pre>
            )}
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.8 }}>
            如果反复出现，请把上面的报错内容发给我；也可以先切到别的标签页，或在设置里改用软件渲染
            （启动参数 <code className="mono">--software-render</code>）后重开应用。
          </div>
        </div>
      </div>
    );
  }
}

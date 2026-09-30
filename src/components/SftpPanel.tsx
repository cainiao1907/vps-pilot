import React from 'react';
import type { HostConfig, SftpEntry } from '@shared/types';
import { fmtSize, InputModal, Modal } from './ui';

/** 文件列表用短时间格式：本年省略年份、不带秒 —— 列宽有限，秒数对识别文件没有帮助 */
function fmtTimeShort(ts: number | undefined): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 允许直接打开编辑的最大文件体积。再大的文件多半是日志/二进制，查看就好 */
const EDITABLE_MAX_BYTES = 512 * 1024;

/** 目录排前面，同类型按名称排序（自然数字序：file2 在 file10 前） */
function sortEntries(list: SftpEntry[]): SftpEntry[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'd' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/**
 * SFTP 文件管理器
 *
 * 交互约定：
 *  - 单击选中，双击打开（目录进入，文本文件打开查看器）
 *  - Electron 不支持 window.prompt()，新建目录 / 改名一律走 InputModal
 *  - 文本文件可就地编辑（sftpWrite 写回），二进制 / 超大文件只提供查看与下载
 */
export function SftpPanel({ host, connected }: { host: HostConfig; connected: boolean }) {
  const [cwd, setCwd] = React.useState(host.defaultCwd || '/');
  const [entries, setEntries] = React.useState<SftpEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [selected, setSelected] = React.useState<SftpEntry | null>(null);
  const [viewing, setViewing] = React.useState<{ path: string; content: string } | null>(null);
  const [editing, setEditing] = React.useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = React.useState('');
  const [pathInput, setPathInput] = React.useState(cwd);
  const [mkdirOpen, setMkdirOpen] = React.useState(false);
  const [renameTarget, setRenameTarget] = React.useState<SftpEntry | null>(null);

  const flashNotice = (msg: string) => {
    setNotice(msg);
    setError('');
    setTimeout(() => setNotice((n) => (n === msg ? '' : n)), 3000);
  };

  const load = React.useCallback(
    async (dir: string) => {
      if (!connected) return;
      setLoading(true);
      setError('');
      const r: any = await window.vps.sftpList(host.id, dir);
      setLoading(false);
      if (!r.ok) {
        setError(r.error ?? '读取目录失败');
        return;
      }
      setEntries(sortEntries(r.data));
      setCwd(dir);
      setPathInput(dir);
      setSelected(null);
    },
    [host.id, connected]
  );

  React.useEffect(() => {
    if (connected) load(host.defaultCwd || '/');
  }, [connected, host.id]);

  const goUp = () => {
    if (cwd === '/') return;
    const parts = cwd.replace(/\/$/, '').split('/');
    parts.pop();
    load(parts.join('/') || '/');
  };

  /** 双击 / 点目录名时进入；文本文件打开查看器 */
  const open = (e: SftpEntry) => {
    if (e.type === 'd') {
      load(e.path);
    } else {
      setSelected(e);
      void doView(e);
    }
  };

  const doView = async (e: SftpEntry) => {
    setBusy(e.path);
    const r: any = await window.vps.sftpRead(host.id, e.path);
    setBusy('');
    if (!r.ok) {
      setError(`无法读取文件：${r.error}`);
      return;
    }
    setViewing({ path: e.path, content: r.data });
  };

  const doEdit = async (e: SftpEntry) => {
    if (e.size > EDITABLE_MAX_BYTES) {
      setError(`文件超过 ${fmtSize(EDITABLE_MAX_BYTES)}，请下载后用本地编辑器修改`);
      return;
    }
    setBusy(e.path);
    const r: any = await window.vps.sftpRead(host.id, e.path);
    setBusy('');
    if (!r.ok) {
      setError(`无法读取文件：${r.error}`);
      return;
    }
    setEditing({ path: e.path, content: r.data });
  };

  const saveEdit = async (content: string) => {
    if (!editing) return;
    setBusy(editing.path);
    const r: any = await window.vps.sftpWrite(host.id, editing.path, content);
    setBusy('');
    if (!r.ok) {
      setError(`保存失败：${r.error}`);
      return;
    }
    setEditing(null);
    if (viewing?.path === editing.path) setViewing({ path: viewing.path, content });
    flashNotice(`已保存 ${editing.path}`);
    load(cwd);
  };

  const doDownload = async (e: SftpEntry) => {
    setBusy(e.path);
    const r: any = await window.vps.sftpDownload(host.id, e.path);
    setBusy('');
    if (!r.ok) setError(r.error ?? '下载失败');
    else if (!r.data?.canceled) flashNotice(`已下载 ${e.name}`);
  };

  const doUpload = async () => {
    const r: any = await window.vps.sftpUpload(host.id, cwd);
    if (!r.ok) setError(r.error ?? '上传失败');
    else if (!r.data?.canceled) {
      flashNotice('上传完成');
      load(cwd);
    }
  };

  const doDelete = async (e: SftpEntry) => {
    if (!confirm(`确定要删除 ${e.name} 吗？${e.type === 'd' ? '（目录必须为空）' : ''}\n\n此操作不可撤销。`)) return;
    setBusy(e.path);
    const r: any = await window.vps.sftpRemove(host.id, e.path, e.type === 'd');
    setBusy('');
    if (!r.ok) setError(r.error ?? '删除失败');
    else {
      flashNotice(`已删除 ${e.name}`);
      load(cwd);
    }
  };

  const doMkdir = async (name: string) => {
    const target = cwd.replace(/\/$/, '') + '/' + name;
    const r: any = await window.vps.sftpMkdir(host.id, target);
    if (!r.ok) setError(r.error ?? '创建失败');
    else {
      flashNotice(`已创建目录 ${name}`);
      load(cwd);
    }
  };

  const doRename = async (e: SftpEntry, name: string) => {
    const target = cwd.replace(/\/$/, '') + '/' + name;
    const r: any = await window.vps.sftpRename(host.id, e.path, target);
    if (!r.ok) setError(r.error ?? '重命名失败');
    else {
      flashNotice(`已重命名为 ${name}`);
      load(cwd);
    }
  };

  if (!connected) {
    return (
      <div className="empty" style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 32, opacity: 0.35 }}>📁</div>
        <div className="empty-title">请先连接到服务器</div>
        <div style={{ fontSize: 12.5 }}>文件管理需要通过 SSH/SFTP 连接</div>
      </div>
    );
  }

  return (
    // flex: 1 + minWidth: 0 —— 标签页容器是 flex row，没有这两项面板会收缩成内容宽度
    <div className="col" style={{ height: '100%', flex: 1, minWidth: 0 }}>
      {/* 工具栏 */}
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexShrink: 0,
        }}
      >
        <button className="btn btn-sm" onClick={goUp} disabled={cwd === '/'} title="上级目录">
          ↑
        </button>
        <button className="btn btn-sm" onClick={() => load(cwd)} disabled={loading} title="刷新">
          {loading ? <span className="spinner" /> : '↻'}
        </button>
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(pathInput.trim() || '/')}
          className="mono"
          style={{ flex: 1, fontSize: 12 }}
        />
        <button className="btn btn-sm btn-accent" onClick={doUpload}>
          上传文件
        </button>
        <button className="btn btn-sm" onClick={() => setMkdirOpen(true)}>
          新建目录
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '6px 12px',
            background: 'var(--red-dim)',
            color: 'var(--red)',
            fontSize: 12,
            display: 'flex',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <span>{error}</span>
          <button className="btn btn-ghost btn-xs" onClick={() => setError('')}>
            ✕
          </button>
        </div>
      )}
      {!error && notice && (
        <div
          style={{
            padding: '6px 12px',
            background: 'var(--green-dim)',
            color: 'var(--green)',
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          ✓ {notice}
        </div>
      )}

      {/* 文件列表 + 预览：alignItems 必须 stretch，.row 默认 center 会让两侧面板收缩居中 */}
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        <div style={{ flex: viewing ? '0 0 58%' : 1, overflowY: 'auto', borderRight: viewing ? '1px solid var(--border)' : 'none', minWidth: 0 }}>
          {/*
            table-layout: fixed 是关键：
            默认的 auto 布局下，长文件名会把「名称」列越撑越宽，把 大小/时间/操作
            三列挤出可视区。固定布局 + 明确列宽后，名称列用省略号收尾，其余列宽度稳定。
          */}
          <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-1)', zIndex: 1 }}>
                <th style={th}>名称</th>
                <th style={{ ...th, width: 76 }}>大小</th>
                <th style={{ ...th, width: 132 }}>修改时间</th>
                <th style={{ ...th, width: 224, textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.path}
                  className={`sftp-row${selected?.path === e.path ? ' selected' : ''}`}
                  onClick={() => setSelected(e)}
                  onDoubleClick={() => open(e)}
                  style={{ cursor: 'pointer' }}
                >
                  <td style={{ ...td, overflow: 'hidden' }}>
                    <div className="row gap-6" style={{ minWidth: 0 }}>
                      {busy === e.path ? (
                        <span className="spinner" style={{ width: 11, height: 11, flexShrink: 0 }} />
                      ) : (
                        <span style={{ color: e.type === 'd' ? 'var(--accent)' : 'var(--text-3)', width: 14, flexShrink: 0 }}>
                          {e.type === 'd' ? '▸' : e.type === 'l' ? '↗' : '·'}
                        </span>
                      )}
                      <span
                        className="truncate"
                        title={e.name}
                        style={{
                          color: e.type === 'd' ? 'var(--accent)' : 'var(--text-0)',
                          fontWeight: e.type === 'd' ? 500 : 400,
                          minWidth: 0,
                        }}
                        onClick={(ev) => {
                          if (e.type === 'd') {
                            ev.stopPropagation();
                            open(e);
                          }
                        }}
                      >
                        {e.name}
                      </span>
                    </div>
                  </td>
                  <td style={{ ...td, color: 'var(--text-2)' }}>
                    {e.type === 'd' ? '—' : fmtSize(e.size)}
                  </td>
                  <td style={{ ...td, color: 'var(--text-3)', fontSize: 11 }}>{fmtTimeShort(e.mtime)}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', overflow: 'visible' }}>
                    {e.type === 'f' && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          doView(e);
                        }}
                        title="查看内容"
                      >
                        查看
                      </button>
                    )}
                    {e.type === 'f' && e.size <= EDITABLE_MAX_BYTES && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          doEdit(e);
                        }}
                        title="编辑并保存回服务器（请勿编辑二进制文件）"
                      >
                        编辑
                      </button>
                    )}
                    {e.type === 'f' && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          doDownload(e);
                        }}
                        title="下载到本地"
                      >
                        下载
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-xs"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setRenameTarget(e);
                      }}
                    >
                      改名
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      style={{ color: 'var(--red)' }}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        doDelete(e);
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {entries.length === 0 && !loading && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
              这个目录是空的
            </div>
          )}
        </div>

        {viewing && (
          <div className="col" style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                padding: '7px 12px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexShrink: 0,
              }}
            >
              <span className="mono truncate" style={{ flex: 1, fontSize: 11.5, color: 'var(--text-2)' }}>
                {viewing.path}
              </span>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setEditing({ path: viewing.path, content: viewing.content })}
                title="编辑这份文件并保存回服务器"
              >
                编辑
              </button>
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => navigator.clipboard.writeText(viewing.content)}
              >
                复制
              </button>
              <button className="btn btn-ghost btn-xs" onClick={() => setViewing(null)}>
                ✕
              </button>
            </div>
            <pre
              className="mono"
              style={{
                flex: 1,
                margin: 0,
                padding: 12,
                overflow: 'auto',
                fontSize: 11.5,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--text-1)',
              }}
            >
              {viewing.content || '（空文件）'}
            </pre>
          </div>
        )}
      </div>

      {/* 新建目录 / 改名：Electron 没有 window.prompt，用模态框收集输入 */}
      {mkdirOpen && (
        <InputModal
          title="新建目录"
          label="目录名称"
          placeholder="例如：logs"
          confirmText="创建"
          onClose={() => setMkdirOpen(false)}
          onSubmit={doMkdir}
        />
      )}
      {renameTarget && (
        <InputModal
          title={`重命名 · ${renameTarget.name}`}
          label="新名称"
          initialValue={renameTarget.name}
          confirmText="重命名"
          onClose={() => setRenameTarget(null)}
          onSubmit={(name) => doRename(renameTarget, name)}
        />
      )}

      {/* 编辑器 */}
      {editing && (
        <EditorModal
          path={editing.path}
          content={editing.content}
          saving={busy === editing.path}
          onClose={() => setEditing(null)}
          onSave={saveEdit}
        />
      )}
    </div>
  );
}

/** 远程文本文件编辑器：写入前确认，保存后写回服务器 */
function EditorModal({
  path,
  content,
  saving,
  onClose,
  onSave,
}: {
  path: string;
  content: string;
  saving: boolean;
  onClose: () => void;
  onSave: (content: string) => void;
}) {
  const [draft, setDraft] = React.useState(content);
  const dirty = draft !== content;
  const confirmClose = () => {
    if (!dirty || confirm('改动尚未保存，确定关闭吗？')) onClose();
  };
  return (
    <Modal title={`编辑 · ${path.split('/').pop() ?? path}`} onClose={confirmClose} width={780}>
      <div className="row gap-8" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
        <code className="mono dim" style={{ fontSize: 11, wordBreak: 'break-all' }}>
          {path}
        </code>
        {dirty && <span style={{ color: 'var(--warn)', fontSize: 11 }}>● 未保存</span>}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="mono"
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 340,
          resize: 'vertical',
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      />
      <div className="field-hint" style={{ marginTop: 8 }}>
        保存会用编辑后的内容整体覆盖远端文件。二进制文件请用下载 / 上传处理，不要在这里编辑。
      </div>
      <div className="row gap-8" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={confirmClose} disabled={saving}>
          取消
        </button>
        <button className="btn btn-primary" onClick={() => onSave(draft)} disabled={saving || !dirty}>
          {saving && <span className="spinner" />}
          保存到服务器
        </button>
      </div>
    </Modal>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '7px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-3)',
  borderBottom: '1px solid var(--border)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
};

const td: React.CSSProperties = {
  padding: '6px 12px',
  borderBottom: '1px solid var(--border-light)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

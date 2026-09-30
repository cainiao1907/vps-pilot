import React from 'react';
import type { NavGroup } from '../store';

/**
 * 左侧一级导航（图标栏）
 *
 * 设计取舍：
 *
 *  - **只放图标 + 文字标签，不做折叠**。运维场景下界面的稳定性比省空间重要 ——
 *    一个会收缩的侧栏意味着每次切换鼠标都要重新定位。固定宽度 56px 的图标栏
 *    空间成本很低（1920 宽下占 3%），换来的是位置永远不变。
 *
 *  - **图标用字符而不是 SVG**。这些符号（▮ ✦ 📁 等）在本项目的等宽字体栈里
 *    是等宽渲染的，对齐天然一致；同时也避免了引入一套图标库的打包体积。
 *    功能优先于精致，这是运维工具不是消费级 App。
 *
 *  - **排序遵循操作认知流**：工作区（最常用，依赖当前主机）打头，然后是
 *    主机清单，最后是配置类。配置类靠下是 Fitts 定律的体现 —— 高频目标
 *    放中间区域命中成本最低，低频目标放边缘不会误触。
 *
 *  - **未连接主机时「工作区」不禁用但给提示**。禁用会让用户以为功能坏了，
 *    点了没反应比灰掉更让人困惑；这里改为允许点击，页内显示「先连接一台主机」。
 */

interface NavItem {
  key: NavGroup;
  icon: string;
  label: string;
  title: string;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'workspace', icon: '▮', label: '工作区', title: '终端 / AI Agent / 文件管理' },
  { key: 'hosts', icon: '🖥', label: '主机', title: '服务器清单与连接管理' },
  { key: 'audit', icon: '☰', label: '审计', title: '命令执行历史与风险回溯' },
  { key: 'library', icon: '🧩', label: '专家库', title: '专家（Persona）与技能（Skills）' },
  { key: 'settings', icon: '⚙', label: '设置', title: '模型 / 代理 / 通用设置' },
];

export function NavRail({
  nav,
  connectedCount,
  onSelect,
}: {
  nav: NavGroup;
  connectedCount: number;
  onSelect: (key: NavGroup) => void;
}) {
  return (
    <nav className="nav-rail" aria-label="主导航">
      <div className="nav-rail-brand" title="VPS Pilot">
        <span>VPS</span>
      </div>
      {NAV_ITEMS.map((it) => {
        const active = nav === it.key;
        return (
          <button
            key={it.key}
            className={`nav-item ${active ? 'active' : ''}`}
            onClick={() => onSelect(it.key)}
            title={it.title}
            aria-current={active ? 'page' : undefined}
          >
            {/* 用 aria-hidden 包住装饰性字符，避免读屏把符号读成「实心方块」 */}
            <span className="nav-item-icon" aria-hidden="true">
              {it.icon}
            </span>
            <span className="nav-item-label">{it.label}</span>
            {it.key === 'workspace' && connectedCount > 0 && (
              <span className="nav-item-dot" title={`${connectedCount} 个已连接`} />
            )}
          </button>
        );
      })}
      <div className="flex-1" />
    </nav>
  );
}

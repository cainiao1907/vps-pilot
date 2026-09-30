import React from 'react';
import { ExpertsPanel } from './ExpertsPanel';
import { SkillsPanel } from './SkillsPanel';
import { useStore, gotoSubNav } from '../store';

/**
 * 专家库（专家 + 技能）
 *
 * 为什么把这两个从「设置」里拿出来单独成组：
 *
 *  1. **认知归属不同**。模型和代理是「本机怎么连、用哪个大脑」——纯粹的机器配置；
 *     专家和技能是「Agent 以什么身份、按什么方法论干活」——是喂给 Agent 的内容资产。
 *     混在一个页面里，用户想改模型要先在六个标签里找。
 *
 *  2. **访问频率不同**。模型 / 代理配置一次基本不动；专家和技能是要反复挑、
 *     反复调的内容。低频项不该占据导航的黄金位置。
 *
 *  3. **它依赖另一个页面**。Agent 面板要按专家/技能来规划，所以「专家库」和
 *     工作区是强关联的 —— 放在一级导航里，从「选了专家 → 去 Agent 跑任务」
 *     是一条连贯的动线，而不是「设置 → 专家 → 返回 → 工作区」。
 */

const LIBRARY_TABS: { key: string; label: string; icon: string; hint: string }[] = [
  { key: 'experts', label: '专家（Persona）', icon: '🧩', hint: '决定 Agent 以什么身份、用什么方法论来规划' },
  { key: 'skills', label: '技能（Skills）', icon: '⚡', hint: '把某类任务的标准步骤与风险提示固化成配方' },
];

export function LibraryPanel() {
  const subNav = useStore((s) => s.subNav);
  const tab = LIBRARY_TABS.some((t) => t.key === subNav) ? subNav : 'experts';
  const current = LIBRARY_TABS.find((t) => t.key === tab)!;

  return (
    <div className="col panel" style={{ height: '100%' }}>
      <div className="panel-head">
        <div>
          <div className="panel-title">专家库</div>
          <div className="panel-sub">{current.hint}</div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {LIBRARY_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => gotoSubNav(t.key)}
          >
            <span style={{ marginRight: 6 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* scroll-panel：滚轮只作用在这一层，不会穿透到背后的终端 */}
      <div className="scroll-panel" style={{ padding: 20 }}>
        {tab === 'experts' && <ExpertsPanel />}
        {tab === 'skills' && <SkillsPanel />}
      </div>
    </div>
  );
}

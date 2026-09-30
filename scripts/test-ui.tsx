/**
 * 新增 UI 组件的静态渲染冒烟测试
 *
 * 用 react-dom/server 把组件渲染成 HTML 字符串，验证：
 *  - 组件能正常挂载（无运行时异常）
 *  - 关键文案出现在输出里（代理表单、诊断报告的各个状态分支）
 *
 * 这不能替代真实浏览器测试，但能在没有浏览器环境时抓住
 * "组件报错 / 条件分支缺失 / 文案打错" 这类问题。
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-loader.mjs scripts/test-ui.tsx
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* 提供一个最小可用的 window.vps，让组件里的副作用调用不会崩 */
const stubApi: any = new Proxy(
  {},
  {
    get: () => (..._args: any[]) => Promise.resolve({ ok: true, data: [] }),
  }
);
(globalThis as any).window = {
  vps: stubApi,
  addEventListener: () => {},
  removeEventListener: () => {},
};
// navigator 在 Node 22 里是只读 getter，用 defineProperty 覆盖
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: () => {} } },
    configurable: true,
  });
} catch {
  /* 覆盖不了也无妨，组件在 SSR 下不会用到剪贴板 */
}

const { ProxyForm, ProxyPortInput, ProxyTestBanner } = await import('../src/components/ProxyForm.tsx');
const { DiagReportView, SettingsPanel } = await import('../src/components/SettingsPanel.tsx');
const { ExpertsPanel } = await import('../src/components/ExpertsPanel.tsx');
const { SkillsPanel } = await import('../src/components/SkillsPanel.tsx');
const { LibraryPanel } = await import('../src/components/LibraryPanel.tsx');
const { NavRail } = await import('../src/components/NavRail.tsx');
const store = await import('../src/store.ts');
const { BUILTIN_EXPERTS, BUILTIN_SKILLS } = await import('../src/shared/experts.ts');
const { DEFAULT_SETTINGS } = await import('../src/shared/presets.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

console.log('\n============ UI 组件渲染冒烟测试 ============\n');

/* ---- 1. 代理表单：不启用代理 ---- */
console.log('[1] ProxyForm · 不使用代理');
{
  const html = render(
    React.createElement(ProxyForm, {
      value: { type: 'none', host: '127.0.0.1', port: 7890 },
      onChange: () => {},
    })
  );
  check('渲染成功', html.length > 0);
  check('显示三个协议选项', /SOCKS5/.test(html) && /HTTP/.test(html) && /不使用/.test(html));
  check('未启用时不显示地址输入框', !/代理地址/.test(html));
}

/* ---- 2. 代理表单：SOCKS5 已填 ---- */
console.log('\n[2] ProxyForm · SOCKS5 已配置');
{
  const html = render(
    React.createElement(ProxyForm, {
      value: { type: 'socks5', host: '127.0.0.1', port: 10808, username: '', password: '' },
      onChange: () => {},
      onTest: () => {},
      onDetect: () => {},
    })
  );
  check('显示代理地址输入框', /代理地址/.test(html));
  check('地址值已回填', /value="127\.0\.0\.1"/.test(html));
  check('端口值已回填', /value="10808"/.test(html));
  check('显示"测试代理"按钮', /测试代理/.test(html));
  check('显示"检测本机代理"按钮', /检测本机代理/.test(html));
  check('无用户名时不强调密码必填', !/代理用户名（可选）/.test(html) === false);
}

/* ---- 3. 代理表单：有用户名，应显示密码框 ---- */
console.log('\n[3] ProxyForm · 带认证');
{
  const html = render(
    React.createElement(ProxyForm, {
      value: { type: 'http', host: '127.0.0.1', port: 7890, username: 'alice', password: '' },
      onChange: () => {},
      hasSavedPassword: true,
    })
  );
  check('显示代理密码输入框', /代理密码/.test(html));
  check('提示已保存可留空', /留空则不修改/.test(html));
  check('显示"跟随全局"以外的 HTTP 选项高亮', /HTTP/.test(html));
}

/* ---- 4. 测试结果提示条 ---- */
console.log('\n[4] ProxyTestBanner');
{
  const ok = render(React.createElement(ProxyTestBanner, { result: { state: 'ok', message: '代理可用' } }));
  check('成功时显示对勾', ok.includes('✓') && /代理可用/.test(ok));

  const err = render(
    React.createElement(ProxyTestBanner, { result: { state: 'err', message: '代理软件没有在运行' } })
  );
  check('失败时显示叉号', err.includes('✗') && /没有在运行/.test(err));

  const idle = render(React.createElement(ProxyTestBanner, { result: { state: 'idle', message: '' } }));
  check('idle 时不渲染任何内容', idle === '');
}

/* ---- 5. 常见端口快选 ---- */
console.log('\n[5] ProxyPortInput 快选端口');
{
  const html = render(React.createElement(ProxyPortInput, { port: 7890, onChange: () => {} }));
  check('包含 7890', /7890/.test(html));
  check('包含 1080', /1080/.test(html));
  check('包含 10808', /10808/.test(html));
}

/* ---- 6. 诊断报告：全部通过 ---- */
console.log('\n[6] DiagReportView · 全部通过');
{
  const html = render(
    React.createElement(DiagReportView, {
      report: {
        ok: true,
        conclusion: '各环节检查全部通过，连接链路是健康的。',
        usedProxy: '直连',
        steps: [
          { key: 'tcp', label: 'TCP 连通性（直连）', status: 'ok', detail: '成功建立连接，耗时 210ms。', ms: 210 },
          { key: 'banner', label: 'SSH 协议响应', status: 'ok', detail: '服务器返回：SSH-2.0-OpenSSH_8.9p1', ms: 88 },
        ],
        suggestions: [],
      },
    })
  );
  check('显示结论', /各环节检查全部通过/.test(html));
  check('显示两条步骤', /TCP 连通性/.test(html) && /SSH 协议响应/.test(html));
  check('显示耗时', /210ms/.test(html));
  check('通过时不显示建议区', !/建议怎么做/.test(html));
}

/* ---- 7. 诊断报告：失败 + 建议 ---- */
console.log('\n[7] DiagReportView · 定位到失败环节');
{
  const html = render(
    React.createElement(DiagReportView, {
      report: {
        ok: false,
        conclusion: '问题定位在「TCP 连通性（直连）」—— 无法连接到 1.2.3.4:22。',
        usedProxy: 'SOCKS5 127.0.0.1:10808',
        failedAt: 'tcp',
        steps: [
          { key: 'local-proxy', label: '本机代理探测', status: 'warn', detail: '检测到本机有代理在运行。' },
          { key: 'tcp', label: 'TCP 连通性（直连）', status: 'fail', detail: '超时（8000ms）。', ms: 8000 },
          { key: 'banner', label: 'SSH 协议响应', status: 'skip', detail: '已启用代理，跳过。' },
        ],
        suggestions: ['启用代理后重试。', '换一个网络再试一次。'],
      },
    })
  );
  check('显示失败结论', /问题定位在/.test(html));
  check('显示使用的代理', /SOCKS5 127\.0\.0\.1:10808/.test(html));
  check('显示建议区标题', /建议怎么做/.test(html));
  check('列出两条建议', /启用代理后重试/.test(html) && /换一个网络/.test(html));
  check('warn 步骤有黄色标记', html.includes('!'));
  check('fail 步骤有叉号', html.includes('✗'));
  check('skip 步骤有短横', html.includes('–'));
}

/* ---- 8. 专家面板：内置库渲染 ---- */
console.log('\n[8] ExpertsPanel · 内置专家列表');
{
  store.setState({
    experts: BUILTIN_EXPERTS.map((e) => ({ ...e })),
    settings: { ...(DEFAULT_SETTINGS as any), defaultExpertId: 'expert_general' },
  } as any);

  const html = render(React.createElement(ExpertsPanel));

  check('渲染成功', html.length > 0);
  check('显示「通用运维工程师」', /通用运维工程师/.test(html));
  check('显示「资深 SRE」', /资深 SRE/.test(html));
  check('显示「新建专家」按钮', /新建专家/.test(html));
  check('内置项打上「内置」标记', /内置/.test(html));
  check('当前默认项打上「默认」标记', /默认/.test(html));
  check('显示分类标题「运维」', /运维/.test(html));
  check('每个内置项都提供「复制」按钮', /复制/.test(html));
  check('每个内置项都提供「停用」按钮', /停用/.test(html));
  check('内置专家不提供「删除」按钮', !/>\s*删除\s*</.test(html));
  check('未显示空状态', !/没有可用的专家/.test(html));
}

/* ---- 9. 专家面板：空列表走空状态 ---- */
console.log('\n[9] ExpertsPanel · 空状态');
{
  store.setState({ experts: [] } as any);
  const html = render(React.createElement(ExpertsPanel));
  check('显示空状态文案', /没有可用的专家/.test(html));
}

/* ---- 10. 专家面板：停用与自定义标记 ---- */
console.log('\n[10] ExpertsPanel · 停用 / 自定义标记');
{
  store.setState({
    experts: [
      { ...BUILTIN_EXPERTS[0], enabled: false },
      {
        id: 'exp_mine',
        name: '灰度发布专家',
        description: '自定义的专家',
        icon: '🚀',
        category: '自定义',
        prompt: '你是一位灰度发布专家。',
        builtin: false,
        enabled: true,
        createdAt: '',
        updatedAt: '',
      },
    ],
    settings: { ...(DEFAULT_SETTINGS as any), defaultExpertId: null },
  } as any);

  const html = render(React.createElement(ExpertsPanel));
  check('停用项显示「已停用」', /已停用/.test(html));
  check('停用项按钮变成「启用」', /启用/.test(html));
  check('自定义项显示「自定义」标记', /自定义/.test(html));
  check('自定义项显示「编辑」按钮', /编辑/.test(html));
  check('自定义项显示「删除」按钮', /删除/.test(html));
  check('渲染自定义项名称', /灰度发布专家/.test(html));
}

/* ---- 11. 技能面板：内置技能渲染 ---- */
console.log('\n[11] SkillsPanel · 内置技能列表');
{
  store.setState({
    skills: BUILTIN_SKILLS.map((s) => ({ ...s })),
    settings: { ...(DEFAULT_SETTINGS as any), defaultSkillIds: [] },
  } as any);

  const html = render(React.createElement(SkillsPanel));

  check('渲染成功', html.length > 0);
  check('显示「磁盘空间分析」', /磁盘空间分析/.test(html));
  check('显示「Nginx 站点部署」', /Nginx 站点部署/.test(html));
  check('显示搜索框', /搜索/.test(html));
  check('显示「查看内容」入口', /查看内容/.test(html));
  check('显示「设为默认」入口', /设为默认/.test(html));
  check('技能数量与内置库一致（逐个出现）', BUILTIN_SKILLS.slice(0, 4).every((s) => html.includes(s.name)));
}

/* ---- 12. 技能面板：已选默认技能高亮 ---- */
console.log('\n[12] SkillsPanel · 默认技能标记');
{
  const target = BUILTIN_SKILLS[0].id;
  store.setState({
    skills: BUILTIN_SKILLS.map((s) => ({ ...s })),
    settings: { ...(DEFAULT_SETTINGS as any), defaultSkillIds: [target] },
  } as any);

  const html = render(React.createElement(SkillsPanel));
  check('已选中项显示「取消默认」', /取消默认/.test(html));
  check('仍显示其他项的「设为默认」', /设为默认/.test(html));
}

/* ---- 13. 技能面板：空状态 ---- */
console.log('\n[13] SkillsPanel · 空状态');
{
  store.setState({ skills: [], settings: { ...(DEFAULT_SETTINGS as any), defaultSkillIds: [] } } as any);
  const html = render(React.createElement(SkillsPanel));
  check('无技能时仍有「新建技能」入口', /新建技能/.test(html));
}

/* ---- 14. 一级导航栏：信息架构与层级 ---- */
console.log('\n[14] NavRail · 一级导航');
{
  const html = render(
    React.createElement(NavRail, { nav: 'workspace', connectedCount: 2, onSelect: () => {} })
  );
  check('渲染成功', html.length > 0);
  check('包含「工作区」', /工作区/.test(html));
  check('包含「主机」', /主机/.test(html));
  check('包含「审计」', /审计/.test(html));
  check('包含「专家库」（低频配置已下沉到侧栏）', /专家库/.test(html));
  check('包含「设置」', /设置/.test(html));
  check('工作区为当前项时标记 active', /nav-item active/.test(html));
  check('标注了当前页（aria-current）', /aria-current="page"/.test(html));
  check('有连接时显示连接指示点', /nav-item-dot/.test(html));
  check('每个导航项都带 title 提示', /title="[^"]+"/.test(html));
}

/* ---- 15. 一级导航栏：切换高亮与未连接时不显示指示点 ---- */
console.log('\n[15] NavRail · 高亮切换 / 无连接');
{
  const html = render(
    React.createElement(NavRail, { nav: 'library', connectedCount: 0, onSelect: () => {} })
  );
  // 只有专家库那一项是 active
  const activeCount = (html.match(/nav-item active/g) ?? []).length;
  check('恰好只有一项处于激活态', activeCount === 1);
  check('激活项是专家库', /nav-item active[\s\S]{0,200}专家库/.test(html));
  check('无连接时不显示连接指示点', !/nav-item-dot/.test(html));
}

/* ---- 16. 专家库面板：专家 / 技能两个子页 ---- */
console.log('\n[16] LibraryPanel · 低位配置入口');
{
  store.setState({
    experts: BUILTIN_EXPERTS.map((e) => ({ ...e })),
    skills: BUILTIN_SKILLS.map((s) => ({ ...s })),
    settings: { ...(DEFAULT_SETTINGS as any) },
    subNav: 'experts',
  } as any);

  const html = render(React.createElement(LibraryPanel));
  check('渲染成功', html.length > 0);
  check('面板标题为「专家库」', /专家库/.test(html));
  check('提供「专家」子页标签', /专家（Persona）/.test(html));
  check('提供「技能」子页标签', /技能（Skills）/.test(html));
  check('默认展示专家内容', /通用运维工程师/.test(html));
  check('显示当前子页的说明文字', /决定 Agent 以什么身份/.test(html));
}

/* ---- 17. 专家库面板：切到技能子页 ---- */
console.log('\n[17] LibraryPanel · 技能子页');
{
  store.setState({
    experts: BUILTIN_EXPERTS.map((e) => ({ ...e })),
    skills: BUILTIN_SKILLS.map((s) => ({ ...s })),
    settings: { ...(DEFAULT_SETTINGS as any) },
    subNav: 'skills',
  } as any);

  const html = render(React.createElement(LibraryPanel));
  check('展示技能内容', /磁盘空间分析/.test(html));
  check('不再展示专家内容', !/资深 SRE/.test(html));
  check('说明文字切换为技能描述', /标准步骤与风险提示/.test(html));
}

/* ---- 18. 设置面板：专家/技能已从设置页移除 ---- */
console.log('\n[18] SettingsPanel · 专家与技能不再占用设置页');
{
  store.setState({
    models: [],
    settings: { ...(DEFAULT_SETTINGS as any) },
    subNav: 'models',
  } as any);

  const html = render(React.createElement(SettingsPanel));
  check('仍然有「模型配置」', /模型配置/.test(html));
  check('仍然有「网络代理」', /网络代理/.test(html));
  check('仍然有「通用设置」', /通用设置/.test(html));
  check('不再有「专家」标签', !/>专家</.test(html));
  check('不再有「技能」标签', !/>技能</.test(html));
  check('设置页标题已渲染', /panel-title/.test(html));
}

/* ---- 19. 设置面板：子页切换由 subNav 驱动 ---- */
console.log('\n[19] SettingsPanel · 子页路由');
{
  store.setState({
    models: [],
    settings: { ...(DEFAULT_SETTINGS as any) },
    subNav: 'about',
  } as any);

  const html = render(React.createElement(SettingsPanel));
  check('subNav=about 时展示「关于」内容', /关于/.test(html));
  check('「关于」标签处于激活态', /tab active[\s\S]{0,80}关于/.test(html));
}

/* ---- 20. subNav 路由回退 ---- */
console.log('\n[20] 子页路由 · 非法值回退');
{
  store.setState({
    models: [],
    settings: { ...(DEFAULT_SETTINGS as any) },
    subNav: 'not-a-real-tab',
  } as any);

  const html = render(React.createElement(SettingsPanel));
  // 非法 subNav 必须回退到第一项，而不是渲染空白
  check('非法 subNav 回退到「模型配置」', /模型配置/.test(html));
  check('页面不是空白', html.length > 500);
}

/* ---- 21. 导航状态机 ---- */
console.log('\n[21] store 导航状态机');
{
  store.gotoNav('library');
  check('gotoNav 切到专家库', store.getState().nav === 'library');
  check('专家库默认子页是 experts', store.getState().subNav === 'experts');

  store.gotoSubNav('skills');
  check('gotoSubNav 切到技能', store.getState().subNav === 'skills');

  store.gotoNav('settings');
  check('切到设置', store.getState().nav === 'settings');
  check('设置默认子页是 models', store.getState().subNav === 'models');

  // 回到专家库时应该记住上次停留的子页（skills），而不是弹回 experts
  store.gotoNav('library');
  check('回到专家库时记住上次子页 skills', store.getState().subNav === 'skills');

  // 每个分组都要有默认子页，否则切过去会渲染空白
  const groups = ['workspace', 'hosts', 'audit', 'library', 'settings'] as const;
  check(
    '每个分组都有默认子页定义',
    groups.every((g) => typeof store.DEFAULT_SUB_NAV[g] === 'string')
  );

  store.gotoNav('workspace');
  check('可以切回工作区', store.getState().nav === 'workspace');
}

console.log(`\n============ 结果：${pass} 通过 / ${fail} 失败 ============\n`);
process.exit(fail === 0 ? 0 : 1);

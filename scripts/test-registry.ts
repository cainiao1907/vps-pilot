/**
 * 专家（Persona）与技能（Skill）系统自测
 *
 * 这些测试不依赖 Electron 运行时：registry.ts 通过 setSettingsProvider 注入
 * 设置读取函数（见 registry.ts 顶部注释），测试里注入一个可变对象即可。
 * 其余（预设库、模板渲染、提示词拼装）都是纯函数，可以直接验证。
 *
 * 运行：node --experimental-strip-types --import ./scripts/ts-loader.mjs scripts/test-registry.ts
 */

import { BUILTIN_EXPERTS, BUILTIN_SKILLS } from '../src/shared/experts.ts';
import type { ExpertConfig, SkillConfig } from '../src/shared/types.ts';

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

/* ---- 服务器注入口：registry 只用到这几个字段 ---- */
const settingsStub: any = {
  disabledExpertIds: [],
  disabledSkillIds: [],
  defaultExpertId: 'expert_general',
};

const registry = await import('../electron/main/registry.ts');
registry.setSettingsProvider(() => ({ ...settingsStub }));

console.log('\n============ 专家 / 技能系统自测 ============\n');

/* ---- 1. 内置库完整性 ---- */
console.log('[1] 内置库完整性');
{
  check('内置专家数量合理（>=8）', BUILTIN_EXPERTS.length >= 8, `实际 ${BUILTIN_EXPERTS.length}`);

  const ids = BUILTIN_EXPERTS.map((e) => e.id);
  check('专家 id 唯一', new Set(ids).size === ids.length);

  const skillIds = BUILTIN_SKILLS.map((s) => s.id);
  check('技能 id 唯一', new Set(skillIds).size === skillIds.length);

  check(
    '每个专家都有 id/name/prompt/category',
    BUILTIN_EXPERTS.every((e) => e.id && e.name && e.prompt && e.category)
  );
  check(
    '每个技能都有 id/name/instructions 或 steps',
    BUILTIN_SKILLS.every((s) => s.id && s.name && (s.instructions || (s.steps?.length ?? 0) > 0))
  );
  check('所有内置项标记 builtin=true', BUILTIN_EXPERTS.every((e) => e.builtin) && BUILTIN_SKILLS.every((s) => s.builtin));
  check('内置专家默认全部启用', BUILTIN_EXPERTS.every((e) => e.enabled));
  check('内置技能默认全部启用', BUILTIN_SKILLS.every((s) => s.enabled));
}

/* ---- 2. 专家提示词不越界（不能覆盖 JSON 输出格式） ---- */
console.log('\n[2] 专家提示词边界');
{
  const offenders = BUILTIN_EXPERTS.filter((e) =>
    /输出\s*(严格)?\s*JSON|response_format|json_object|"steps"\s*:/i.test(e.prompt)
  );
  check(
    '内置专家提示词不提 JSON 输出格式（避免覆盖系统的格式约束）',
    offenders.length === 0,
    offenders.map((e) => e.id).join(',')
  );

  // 通用专家必须存在，因为它是兜底
  check('存在兜底的「通用运维工程师」', BUILTIN_EXPERTS.some((e) => e.id === 'expert_general'));
}

/* ---- 3. 列表合并与启用状态 ---- */
console.log('\n[3] 列表合并');
{
  const custom: ExpertConfig[] = [
    {
      id: 'exp_custom1',
      name: '我的专家',
      description: 'test',
      icon: '🧪',
      category: '自定义',
      prompt: '你是……',
      builtin: false,
      enabled: true,
    },
  ];

  settingsStub.disabledExpertIds = [];
  settingsStub.disabledSkillIds = [];

  const list = registry.listExperts(custom);
  check('自定义专家出现在列表里', list.some((e) => e.id === 'exp_custom1'));
  check('内置专家也在列表里', list.some((e) => e.id === 'expert_general'));
  check('总数 = 内置 + 自定义', list.length === BUILTIN_EXPERTS.length + 1);

  // 停用一个内置专家
  settingsStub.disabledExpertIds = ['expert_sre'];
  const list2 = registry.listExperts(custom);
  const sre = list2.find((e) => e.id === 'expert_sre');
  check('被禁用的内置专家 enabled=false', sre?.enabled === false);
  check('未禁用的内置专家仍然 enabled', list2.find((e) => e.id === 'expert_general')?.enabled === true);
  settingsStub.disabledExpertIds = [];
}

/* ---- 4. 自定义技能不应混入 builtin 标记 ---- */
console.log('\n[4] 自定义技能');
{
  const customSkills: SkillConfig[] = [
    {
      id: 'sk_mine',
      name: '我的技能',
      description: '',
      icon: '⚡',
      category: '自定义',
      instructions: '...',
      builtin: false,
      enabled: true,
    },
  ];
  const list = registry.listSkills(customSkills);
  check('自定义技能在内置之后', list.findIndex((s) => s.id === 'sk_mine') > 0);
  check('自定义技能保持 enabled=true', list.find((s) => s.id === 'sk_mine')?.enabled === true);
}

/* ---- 5. 模板渲染 ---- */
console.log('\n[5] 技能参数模板渲染');
{
  check(
    '替换单个占位符',
    registry.renderTemplate('域名是 {{domain}}', { domain: 'a.com' }) === '域名是 a.com'
  );
  check(
    '替换多个占位符',
    registry.renderTemplate('{{a}} 和 {{b}}', { a: 'X', b: 'Y' }) === 'X 和 Y'
  );
  check(
    '未提供的占位符原样保留（提示用户还缺东西）',
    registry.renderTemplate('域名是 {{domain}}', {}) === '域名是 {{domain}}'
  );
  check(
    '空字符串视为未填',
    registry.renderTemplate('{{x}}', { x: '' }) === '{{x}}'
  );
  check(
    '同名的多个占位符全部替换',
    registry.renderTemplate('{{a}}-{{a}}', { a: 'Z' }) === 'Z-Z'
  );
}

/* ---- 6. 技能渲染成文本 ---- */
console.log('\n[6] renderSkill');
{
  const skill: SkillConfig = {
    id: 's1',
    name: '测试技能',
    description: '这是说明',
    icon: '⚡',
    category: '测试',
    instructions: '先做 {{step}}',
    steps: ['第一步：{{a}}', '第二步：固定动作'],
    riskNotes: ['小心 {{a}} 会删数据'],
    params: [
      { key: 'a', label: 'A' },
      { key: 'step', label: '步骤' },
    ],
    builtin: false,
    enabled: true,
  };
  const out = registry.renderSkill(skill, { a: 'VPS', step: '备份' });

  check('包含技能名', out.includes('测试技能'));
  check('包含说明', out.includes('这是说明'));
  check('instructions 占位符被替换', out.includes('先做 备份'));
  check('步骤被编号', out.includes('1. 第一步：VPS') && out.includes('2. 第二步：固定动作'));
  check('风险提示被列出', out.includes('小心 VPS 会删数据'));
  check('不再残留未替换的占位符', !out.includes('{{'));
}

/* ---- 7. composeSystemPrompt ---- */
console.log('\n[7] 系统提示词拼装');
{
  const base = 'BASE_PROMPT_JSON_REQUIRED';

  // 无专家无技能
  const p1 = registry.composeSystemPrompt({ basePrompt: base, expert: null, skills: [] });
  check('无专家无技能时只有基础提示词', p1.trim() === base);

  // 有专家
  const expert: ExpertConfig = {
    id: 'e1',
    name: '资深 SRE',
    description: '面向稳定性',
    icon: '📊',
    category: '稳定性',
    prompt: '你要优先考虑服务不中断。',
    builtin: false,
    enabled: true,
  };
  const p2 = registry.composeSystemPrompt({ basePrompt: base, expert, skills: [] });
  check('基础提示词在最前面', p2.startsWith(base));
  check('注入专家名', p2.includes('资深 SRE'));
  check('注入专家提示词正文', p2.includes('你要优先考虑服务不中断。'));
  check('重申 JSON 格式要求', p2.includes('仍然必须输出上面规定的严格 JSON'));

  // 有技能
  const skill: SkillConfig = {
    id: 's1',
    name: '磁盘分析',
    description: '',
    icon: '💾',
    category: '性能',
    instructions: '先 df 再 du',
    builtin: false,
    enabled: true,
  };
  const p3 = registry.composeSystemPrompt({
    basePrompt: base,
    expert,
    skills: [{ skill, values: {} }],
  });
  check('注入技能名', p3.includes('磁盘分析'));
  check('注入技能正文', p3.includes('先 df 再 du'));
  check('专家与技能都在', p3.includes('资深 SRE') && p3.includes('磁盘分析'));
  check('顺序：基础 -> 专家 -> 技能', p3.indexOf(base) < p3.indexOf('资深 SRE') && p3.indexOf('资深 SRE') < p3.indexOf('磁盘分析'));

  // 额外要求
  const p4 = registry.composeSystemPrompt({
    basePrompt: base,
    expert: null,
    skills: [],
    extraInstructions: '不要动生产数据库',
  });
  check('额外要求被附加', p4.includes('不要动生产数据库'));
  check('额外要求后重申 JSON', p4.includes('仍然必须以严格 JSON 格式输出'));

  // 空白额外要求不该产生多余段落
  const p5 = registry.composeSystemPrompt({ basePrompt: base, expert: null, skills: [], extraInstructions: '   ' });
  check('空白额外要求被忽略', p5.trim() === base);
}

/* ---- 8. profile 快照 ---- */
console.log('\n[8] AgentProfile');
{
  const expert: ExpertConfig = {
    id: 'e1',
    name: '容器专家',
    description: '',
    icon: '🐳',
    category: '容器',
    prompt: 'p',
    builtin: false,
    enabled: true,
  };
  const skills: SkillConfig[] = [
    { id: 's1', name: 'A', description: '', icon: '⚡', category: 'c', instructions: 'i', builtin: false, enabled: true },
    { id: 's2', name: 'B', description: '', icon: '⚡', category: 'c', instructions: 'i', builtin: false, enabled: true },
  ];
  const prof = registry.buildProfile(expert, skills);
  check('记录专家 id 与名称', prof.expertId === 'e1' && prof.expertName === '容器专家');
  check('记录全部技能', prof.skillIds.length === 2 && prof.skillNames.join(',') === 'A,B');

  const none = registry.buildProfile(null, []);
  check('无专家时给出占位描述', none.expertId === null && none.expertName.includes('未指定'));
}

/* ---- 9. 技能推荐 ---- */
console.log('\n[9] 技能关键词推荐');
{
  settingsStub.disabledSkillIds = [];
  const customSkills: SkillConfig[] = [
    {
      id: 'sk_custom_trig',
      name: '自定义触发技能',
      description: '',
      icon: '⚡',
      category: '自定义',
      instructions: 'x',
      triggers: ['我的专属词'],
      builtin: false,
      enabled: true,
    },
  ];

  const r1 = registry.recommendSkills(customSkills, '帮我把 nginx 站点配好并申请 https 证书');
  check('按 nginx 命中技能', r1.some((x) => x.skill.id === 'skill_nginx'));
  check('按 证书/https 命中 SSL 技能', r1.some((x) => x.skill.id === 'skill_ssl'));
  check('返回匹配到的关键词', r1.every((x) => x.matched.length > 0));

  const r2 = registry.recommendSkills(customSkills, '我的专属词场景');
  check('自定义技能的 triggers 生效', r2.some((x) => x.skill.id === 'sk_custom_trig'));

  const r3 = registry.recommendSkills(customSkills, '');
  check('空任务不推荐任何技能', r3.length === 0);

  const r4 = registry.recommendSkills(customSkills, '今天天气不错');
  check('无关键词命中时不推荐', r4.length === 0);

  // 命中的关键词越多排越前
  const r5 = registry.recommendSkills(customSkills, 'docker 容器部署，用 docker compose');
  check('多关键词命中的排序合理', r5.length > 0 && r5[0].matched.length >= 1);

  // 停用的技能不推荐
  settingsStub.disabledSkillIds = ['skill_ssl'];
  const r6 = registry.recommendSkills(customSkills, '申请 https 证书');
  check('已停用的技能不参与推荐', !r6.some((x) => x.skill.id === 'skill_ssl'));
  settingsStub.disabledSkillIds = [];
}

/* ---- 10. 内置技能里的占位符都能被参数定义覆盖 ---- */
console.log('\n[10] 内置技能占位符一致性');
{
  const problems: string[] = [];
  for (const s of BUILTIN_SKILLS) {
    const defined = new Set((s.params ?? []).map((p) => p.key));
    const body = [s.instructions, ...(s.steps ?? []), ...(s.riskNotes ?? [])].join('\n');
    for (const m of body.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!defined.has(m[1])) problems.push(`${s.id}: {{${m[1]}}} 没有参数定义`);
    }
    for (const k of defined) {
      if (!body.includes(`{{${k}}}`)) problems.push(`${s.id}: 参数 ${k} 未被使用`);
    }
  }
  check('所有内置技能的占位符与参数定义一致', problems.length === 0, problems.join('; '));
}

console.log(`\n============ 结果：${pass} 通过 / ${fail} 失败 ============\n`);
process.exit(fail === 0 ? 0 : 1);

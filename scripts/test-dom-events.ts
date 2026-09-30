/**
 * 交互回归测试：全局键盘监听器不得吞掉终端输入
 *
 * 这个文件的存在理由，是一次真实的线上故障：
 *
 *   复现路径 —— 连上终端 → 进设置页 → 点「专家」或「技能」→ 回到终端
 *   异常现象 —— 终端再也打不了字，滚轮也不响应，顶部按钮全部点不动
 *
 * 根因不是终端，而是 Modal 组件：
 *
 *   React.useEffect(() => {
 *     const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
 *     window.addEventListener('keydown', h);
 *     return () => window.removeEventListener('keydown', h);
 *   }, [onClose]);
 *
 * 两个缺陷叠加：
 *   1. `onClose` 是每次渲染都新建的函数，依赖数组里带着它 → 每次父组件重渲染
 *      都「先卸载再注册」。只要有任何一次 cleanup 没跑到，就留下一个幽灵监听器。
 *   2. 监听器挂在 window 上，xterm 的键盘处理器挂在 .xterm-helper-textarea 上。
 *      window 是冒泡链末端，两者都会收到事件。旧实现里监听器无条件调用
 *      onClose()（对一个已卸载的组件 setState），并且在一些分支上
 *      preventDefault / stopPropagation —— 这就是按键进不了终端的原因。
 *
 * 修复后的约定（本测试逐条验证）：
 *   a) 焦点不在模态框内时，监听器必须完全不响应 —— 不 preventDefault、
 *      不 stopPropagation、不调用 onClose。
 *   b) 焦点在模态框内时，Escape 正常关闭。
 *   c) 监听器只注册一次，且 onClose 变化不会导致重注册（用 ref 承接）。
 *   d) 卸载后监听器必须被移除干净（不残留）。
 *
 * 为什么要单独写一个「假 DOM」而不是引入 jsdom：
 *   我们只需要事件监听 + activeElement + contains 这三件事。
 *   引一个完整的 DOM 实现（jsdom 是 10MB+ 的依赖）只为验证这三件事，
 *   性价比太低，还会拖慢 CI。手工桩子只有 40 行，而且意图更清楚 ——
 *   测试代码里的每一行都在说明「这条约定为什么重要」。
 *
 * 运行：node --experimental-strip-types scripts/test-dom-events.ts
 */

/* ============ 极简 DOM 桩 ============ */

interface FakeNode {
  nodeName: string;
  children: FakeNode[];
  contains(other: FakeNode | null): boolean;
  descendants(): FakeNode[];
  matches(sel: string): boolean;
  focus(): void;
}

function makeNode(nodeName: string, opts: { focusable?: boolean } = {}): FakeNode {
  const node: FakeNode = {
    nodeName,
    children: [],
    contains(other) {
      if (!other) return false;
      let cur: FakeNode | null = other;
      while (cur) {
        if (cur === node) return true;
        cur = (cur as any).__parent ?? null;
      }
      return false;
    },
    descendants() {
      const out: FakeNode[] = [];
      const walk = (n: FakeNode) => {
        for (const c of n.children) {
          out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    matches(sel) {
      // 只支持这个测试用到的几个简单选择器
      if (sel === 'input:not([type="hidden"])') return nodeName === 'INPUT';
      if (sel === 'textarea') return nodeName === 'TEXTAREA';
      if (sel === 'select') return nodeName === 'SELECT';
      if (sel === 'button') return nodeName === 'BUTTON';
      if (sel === '[tabindex]:not([tabindex="-1"])') return opts.focusable === true;
      return false;
    },
    focus() {
      (globalThis as any).document.activeElement = node;
    },
  };
  return node;
}

function appendChild(parent: FakeNode, child: FakeNode): FakeNode {
  (child as any).__parent = parent;
  parent.children.push(child);
  return child;
}

/* 事件监听器登记表 —— 这是本测试要观察的核心对象 */
type Handler = (e: any) => void;
const listeners = new Map<string, Set<Handler>>();
let addCount = 0;
let removeCount = 0;

function installFakeDom() {
  (globalThis as any).window = {
    addEventListener(type: string, fn: Handler) {
      addCount++;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Handler) {
      removeCount++;
      listeners.get(type)?.delete(fn);
    },
  };
}

/** 派发一次按键事件，返回「事件对象的最终状态」用于断言是否被干预过 */
function dispatchKey(key: string) {
  const ev = {
    key,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
  for (const fn of listeners.get('keydown') ?? []) fn(ev);
  return ev;
}

function activeListenerCount(): number {
  return listeners.get('keydown')?.size ?? 0;
}

/* ============ 断言工具 ============ */
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

/* ============ 复刻 Modal 的 Escape 处理逻辑 ============
 *
 * 注意：这里刻意**不 import Modal 组件本身**。
 *
 * 原因是我们需要精确控制「哪个节点是 activeElement」以及「监听的注册/注销时机」，
 * 而 React 的渲染流程会把这部分藏起来。所以这里按修复后的实现逐行复刻一份逻辑，
 * 逐条锁住上面 a~d 四条约定。如果哪天有人在 Modal 里改坏了这个逻辑，
 * 本文件不会报警 —— 但它至少把「正确的逻辑长什么样」固化成可执行的文档，
 * 让 review 时有明确的对照物。
 *
 * 真正的端到端验证只能靠 Electron 跑起来后人工点一遍，见 README 的验证清单。
 */

function makeEscapeHandler(root: FakeNode | null, onClose: () => void, alive: { v: boolean }) {
  return (e: any) => {
    if (e.key !== 'Escape') return;
    if (!alive.v) return; // 组件已卸载
    const active = (globalThis as any).document.activeElement as FakeNode | null;
    if (!root || !active || !root.contains(active)) return; // 焦点不在框内 → 透明
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
}

console.log('\n============ 键盘事件隔离回归测试 ============\n');

/* ---- 1. 焦点在终端时，Escape 必须完全透明 ---- */
console.log('[1] 焦点在终端 · 监听器必须透明');
{
  listeners.clear();
  addCount = 0;
  removeCount = 0;
  installFakeDom();
  (globalThis as any).document = { activeElement: null };

  // 模态框根节点（此时已卸载，但监听器出于某种原因还在 —— 模拟最坏情况）
  const modalRoot = makeNode('DIV');

  // 终端：一个完全独立于模态框的节点
  const termTextarea = makeNode('TEXTAREA');
  (globalThis as any).document.activeElement = termTextarea;

  let closedTimes = 0;
  const handler = makeEscapeHandler(modalRoot, () => closedTimes++, { v: true });
  window.addEventListener('keydown', handler);

  const ev = dispatchKey('Escape');

  check('没有调用 onClose（焦点不在模态框内）', closedTimes === 0, `实际 ${closedTimes} 次`);
  check('没有 preventDefault（按键仍能进终端）', ev.defaultPrevented === false);
  check('没有 stopPropagation（事件链未被截断）', ev.propagationStopped === false);

  window.removeEventListener('keydown', handler);
}

/* ---- 2. 焦点在普通字符键上时，监听器完全无视 ---- */
console.log('\n[2] 非 Escape 按键 · 任何情况下都不干预');
{
  listeners.clear();
  installFakeDom();
  const modalRoot = makeNode('DIV');
  const inner = appendChild(modalRoot, makeNode('BUTTON'));
  (globalThis as any).document = { activeElement: inner };

  let closedTimes = 0;
  const handler = makeEscapeHandler(modalRoot, () => closedTimes++, { v: true });
  window.addEventListener('keydown', handler);

  // 终端里最常敲的这些键，一个都不能被吃掉
  for (const k of ['a', 'Enter', 'Tab', 'ArrowUp', 'Tab', 'c', '/']) {
    const ev = dispatchKey(k);
    if (ev.defaultPrevented || ev.propagationStopped) {
      check(`按键 ${k} 未被干预`, false, '被 preventDefault/stopPropagation 了');
    }
  }
  check('普通按键全部未被干预', true);
  check('没有误触发关闭', closedTimes === 0);

  window.removeEventListener('keydown', handler);
}

/* ---- 3. 焦点在模态框内时，Escape 正常关闭 ---- */
console.log('\n[3] 焦点在模态框内 · Escape 应关闭');
{
  listeners.clear();
  installFakeDom();
  const modalRoot = makeNode('DIV');
  const inner = appendChild(modalRoot, makeNode('BUTTON'));
  (globalThis as any).document = { activeElement: inner };

  let closedTimes = 0;
  const handler = makeEscapeHandler(modalRoot, () => closedTimes++, { v: true });
  window.addEventListener('keydown', handler);

  const ev = dispatchKey('Escape');
  check('调用了 onClose', closedTimes === 1, `实际 ${closedTimes} 次`);
  check('阻止了默认行为（Esc 不该冒泡到别处）', ev.defaultPrevented === true);

  window.removeEventListener('keydown', handler);
}

/* ---- 4. 组件卸载后，监听器必须彻底静默 ---- */
console.log('\n[4] 组件已卸载 · 监听器不得生效');
{
  listeners.clear();
  installFakeDom();
  const modalRoot = makeNode('DIV');
  const inner = appendChild(modalRoot, makeNode('BUTTON'));
  (globalThis as any).document = { activeElement: inner };

  let closedTimes = 0;
  const alive = { v: true };
  const handler = makeEscapeHandler(modalRoot, () => closedTimes++, alive);
  window.addEventListener('keydown', handler);

  // 模拟组件卸载（React 会同时跑 cleanup 移除监听器，这里单独验证 alive 检查）
  alive.v = false;
  dispatchKey('Escape');
  check('卸载后不再调用 onClose', closedTimes === 0, `实际 ${closedTimes} 次`);

  window.removeEventListener('keydown', handler);
}

/* ---- 5. 监听器不泄漏：注册几次就要注销几次 ---- */
console.log('\n[5] 监听器生命周期 · 不得累积');
{
  listeners.clear();
  addCount = 0;
  removeCount = 0;
  installFakeDom();
  (globalThis as any).document = { activeElement: null };
  const modalRoot = makeNode('DIV');
  const handler = makeEscapeHandler(modalRoot, () => {}, { v: true });

  // 模拟「打开 / 关闭」模态框 20 次
  for (let i = 0; i < 20; i++) {
    window.addEventListener('keydown', handler);
    window.removeEventListener('keydown', handler);
  }

  check('注册次数等于注销次数', addCount === removeCount, `${addCount} vs ${removeCount}`);
  check('没有残留监听器', activeListenerCount() === 0, `残留 ${activeListenerCount()} 个`);
}

/* ---- 6. 最坏情况：多个幽灵监听器同时存在 ---- */
console.log('\n[6] 幽灵监听器堆叠 · 焦点在终端时仍须全体静默');
{
  listeners.clear();
  installFakeDom();

  // 模拟「历史遗留」的多个模态框监听器（旧实现的真实后果）
  const ghosts: FakeNode[] = [];
  let ghostCloseCount = 0;
  for (let i = 0; i < 5; i++) {
    const root = makeNode('DIV');
    ghosts.push(root);
    window.addEventListener(
      'keydown',
      makeEscapeHandler(root, () => ghostCloseCount++, { v: true })
    );
  }

  // 用户焦点在终端
  (globalThis as any).document = { activeElement: makeNode('TEXTAREA') };

  const ev = dispatchKey('Escape');
  check('5 个幽灵监听器全部未触发关闭', ghostCloseCount === 0, `实际 ${ghostCloseCount} 次`);
  check('按键未被任何幽灵监听器拦截', !ev.defaultPrevented && !ev.propagationStopped);
  check('监听器数量确实是 5（确认测试前提成立）', activeListenerCount() === 5);
}

/* ---- 7. 焦点在模态框内的「兄弟」节点上 ---- */
console.log('\n[7] contains 判定 · 边界情况');
{
  listeners.clear();
  installFakeDom();
  const modalRoot = makeNode('DIV');
  const deep = appendChild(appendChild(appendChild(modalRoot, makeNode('DIV')), makeNode('DIV')), makeNode('BUTTON'));
  (globalThis as any).document = { activeElement: deep };

  let closedTimes = 0;
  const handler = makeEscapeHandler(modalRoot, () => closedTimes++, { v: true });
  window.addEventListener('keydown', handler);
  dispatchKey('Escape');
  check('深层嵌套的后代节点也能被识别为「在框内」', closedTimes === 1);

  // 换成一个不在框内的节点
  closedTimes = 0;
  (globalThis as any).document = { activeElement: makeNode('TEXTAREA') };
  dispatchKey('Escape');
  check('框外节点不会被误判为框内', closedTimes === 0);

  window.removeEventListener('keydown', handler);
}

/* ---- 8. activeElement 为 null 时不崩 ---- */
console.log('\n[8] 无焦点元素 · 不得抛异常');
{
  listeners.clear();
  installFakeDom();
  (globalThis as any).document = { activeElement: null };
  const modalRoot = makeNode('DIV');

  let closedTimes = 0;
  let threw = false;
  const handler = makeEscapeHandler(modalRoot, () => closedTimes++, { v: true });
  window.addEventListener('keydown', handler);
  try {
    dispatchKey('Escape');
  } catch {
    threw = true;
  }
  check('activeElement 为 null 时不抛异常', !threw);
  check('也不会误触发关闭', closedTimes === 0);

  window.removeEventListener('keydown', handler);
}

/* ---- 9. 前提校验：确认真实的 Modal 源码遵守了这些约定 ---- */
console.log('\n[9] 源码约定校验 · Modal 实现');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/components/ui.tsx', import.meta.url), 'utf8');

  check('Modal 不再直接把 onClose 放进依赖数组', !/\}, \[onClose\]\)/.test(src));
  check('Modal 用 ref 承接 onClose', /onCloseRef/.test(src));
  check('Escape 处理里做了 contains 判定', /root\.contains\(active\)/.test(src));
  check('Escape 处理里检查 key 是否 Escape', /e\.key !== 'Escape'/.test(src));
  check('Escape 处理里检查了 activeElement', /document\.activeElement/.test(src));
  check('监听器 cleanup 已注册', /removeEventListener\('keydown'/.test(src));
  check(
    '关闭时把焦点还原（否则焦点掉到 body，终端收不到键盘）',
    /document\.contains\(prev\)\) prev\.focus\(\)/.test(src)
  );
}

/* ---- 10. 源码约定校验：工作区必须常驻挂载，不得条件渲染卸载 ---- */
console.log('\n[10] 源码约定校验 · 工作区常驻');
{
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  // 这是本次故障的另一半根因：以前是 {view === 'terminal' && (...)}，
  // 进设置页就把整个标签工作区卸载掉，TerminalView 的 cleanup 会执行
  // term.dispose()，终端实例、SSH shell channel、scrollback 全部丢失。
  //
  // 只查 JSX 里的条件渲染（`{... && (`），不查普通 if 语句 ——
  // 业务逻辑里出现 `nav === 'workspace' && ...` 是正常的。
  check(
    '工作区不再用条件渲染（会卸载终端）',
    !/\{\s*(view|nav)\s*===\s*'workspace'\s*&&\s*\(/.test(app)
  );
  check('存在 WorkspaceLayer 常驻层', /function WorkspaceLayer/.test(app));
  check('隐藏层用 is-hidden 类而不是卸载', /is-hidden/.test(app));
  check('隐藏层设了 inert（焦点不会跑进看不见的终端）', /setAttribute\('inert'/.test(app));
  check('终端接收 active 状态时同时考虑 nav', /active=\{isActive && inWorkspace\}/.test(app));

  const css = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  check('CSS 里 .layer.is-hidden 是可见性隐藏而非 display:none', /\.layer\.is-hidden\s*\{[^}]*visibility:\s*hidden/.test(css));
  check('标题栏有独立 z-index 层', /--z-titlebar/.test(css));
  check('滚动面板隔离了滚轮冒泡', /\.scroll-panel[\s\S]{0,200}overscroll-behavior:\s*contain/.test(css));
}

console.log(`\n============ 结果：${pass} 通过 / ${fail} 失败 ============\n`);
process.exit(fail === 0 ? 0 : 1);

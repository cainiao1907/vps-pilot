# 贡献指南

感谢你有兴趣为 VPS Pilot 做贡献！本文档说明如何搭建开发环境、遵循的规范，以及提交改动的流程。

## 目录

- [行为准则](#行为准则)
- [开发环境](#开发环境)
- [项目结构](#项目结构)
- [开发流程](#开发流程)
- [提交规范](#提交规范)
- [测试要求](#测试要求)
- [Pull Request 流程](#pull-request-流程)
- [安全相关贡献](#安全相关贡献)

## 行为准则

参与本项目即表示你同意保持友善、尊重、专业的交流氛围。不接受人身攻击、歧视性言论或骚扰行为。

## 开发环境

### 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | >= 22 | 使用了 `--experimental-strip-types` 跑 TS 测试 |
| npm | >= 10 | 随 Node 一起安装 |
| Python | >= 3.10 | 仅部分辅助脚本需要（可选） |
| Git | 任意近期版本 | |

**无需安装 Visual Studio 构建工具**：项目已通过 `package.json` 的 `overrides` 把 `ssh2` 的可选原生依赖 `cpu-features` 替换为空包，从源头消除原生编译。详见 `package.json` 中的注释。

### 快速开始

```bash
git clone https://github.com/cainiao1907/vps-pilot.git
cd vps-pilot
npm install

# 开发模式（Vite HMR + Electron 热重载）
npm run electron:dev
```

> Windows 用户也可直接双击 `开发模式.bat`。

### 常见问题

**Q: 启动报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`**

`ELECTRON_RUN_AS_NODE` 环境变量存在（哪怕是空字符串）会让 Electron 退化成纯 Node。启动前清除它：

```bash
env -u ELECTRON_RUN_AS_NODE npm run electron:dev
```

**Q: GPU 进程崩溃 / 窗口创建不出来**

无显卡环境（云服务器、虚拟机、容器）已内置五层自动降级（软件渲染），无需手动干预。若仍异常，可强制：

```bash
VPSPILOT_SOFTWARE_RENDER=1 npm run electron:dev
```

**Q: 端口被占用 / 脚本跑一半就退出了**

应用有单实例锁，残留的 Electron 进程会让新进程直接退出。Windows 下清理：

```bash
taskkill /F /IM electron.exe
```

## 项目结构

```
electron/
  main/          # 主进程：SSH、存储、Agent 循环、MCP 服务
    mcp/         # MCP 协议实现（JSON-RPC / HTTP / stdio 转发）
  preload/       # 预加载脚本：contextBridge 暴露的 IPC 接口
src/
  components/    # React 界面组件
  shared/        # 主进程与渲染进程共享：类型、风险引擎、专家/技能库
  lib/           # 渲染进程工具（IPC 封装等）
  store.ts       # 渲染进程状态管理
scripts/         # 测试、构建、开发辅助脚本
```

**关键设计约束**（改动前务必理解）：

- `src/shared/risk.ts` 是安全核心。任何涉及命令执行的改动都必须经过它，且**硬拦截规则无豁免**。
- 工作区（终端/Agent/文件）**常驻挂载、永不卸载**。切换导航只做视觉隐藏，绝不条件渲染——否则终端会 `dispose()`，正在跑的命令变孤儿进程。`scripts/test-dom-events.ts` 有源码约定测试锁住这条。
- 明文密码与 API Key **永不落盘、永不出主进程**，渲染进程只能拿到布尔值。

## 开发流程

1. Fork 本仓库并 clone 到本地
2. 从 `main` 创建特性分支：`git checkout -b feat/your-feature`
3. 编码，**边写边跑测试**
4. 提交前跑通全量检查：`npm run test:all`
5. 推送分支并创建 Pull Request

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**type**：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore`
**scope**（可选）：`risk` / `agent` / `ssh` / `mcp` / `ui` / `proxy` / `store` 等

示例：

```
fix(risk): 修复 rm -rf / --no-preserve-root 漏判为高危

原规则的结尾锚点 \s*($|[;&|]) 要求 / 后紧跟空白再跟分隔符，
但该写法 / 后面还有参数，导致规则不命中、落入 high 级可被放行。
改为「空白或分隔符」二选一，并让 --no-preserve-root 单独成规则。
```

> 提交信息用中文或英文均可，但请说清楚**为什么改**，而不只是**改了什么**。

## 测试要求

本项目有一套零依赖的测试体系（不引入 Jest/Vitest，用 Node 原生能力直接跑源码）：

```bash
npm run test:all      # 全量：类型检查 + 全部单测（398 项）
```

| 命令 | 覆盖范围 |
|---|---|
| `npm run typecheck` | 全量 TypeScript 类型检查 |
| `npm run test:risk` | 危险命令规则引擎 |
| `npm run test:proxy` | SOCKS5 / HTTP CONNECT 协议字节流 |
| `npm run test:registry` | 专家/技能库完整性、模板渲染 |
| `npm run test:events` | 键盘事件隔离、监听器生命周期、布局源码约定 |
| `npm run test:ui` | 组件静态渲染冒烟 |
| `npm run test:mcp` | MCP 服务端到端 |

**硬性要求**：

- 修改 `src/shared/risk.ts` → 必须为每条新规则补 `scripts/test-risk.ts` 用例
- 修改终端挂载逻辑 → 必须更新 `scripts/test-dom-events.ts` 的源码约定断言
- 新增 MCP 工具 → 必须补 `scripts/test-mcp.ts` 用例
- **所有改动必须 `npm run test:all` 全绿**，CI 会强制检查

## Pull Request 流程

1. PR 标题遵循提交规范（如 `feat(mcp): 新增 SFTP 上传工具`）
2. 描述中说明：**改了什么、为什么改、怎么验证的**
3. 关联相关 Issue（`Closes #123`）
4. 确保 CI 通过、无冲突
5. 维护者会 review，可能请求修改

**小而聚焦的 PR 更容易被合并。** 一个 PR 只做一件事，避免大量无关格式化/重构混入。

## 安全相关贡献

VPS Pilot 处理 SSH 凭据与远程命令执行，安全是重中之重。

**如果你发现安全漏洞，请勿公开提交 Issue**，通过 GitHub Security Advisory 私下报告（仓库 → Security → Report a vulnerability）。

安全相关改动的额外要求：

- 涉及凭据处理、命令执行、权限校验的改动，需在 PR 中**明确说明攻击面变化**
- 新增危险命令规则时，考虑绕过手法（参数顺序、引号、变量展开、路径变体）
- 不要削弱既有的硬拦截规则；如需调整，需给出充分理由与绕过风险分析

---

再次感谢你的贡献！有任何疑问可开 Discussion 或在 Issue 中提出。

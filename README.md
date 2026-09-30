# VPS Pilot

[![Release](https://img.shields.io/github/v/release/cainiao1907/vps-pilot?color=blue&label=release)](https://github.com/cainiao1907/vps-pilot/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/cainiao1907/vps-pilot/total?color=green)](https://github.com/cainiao1907/vps-pilot/releases)
[![CI](https://github.com/cainiao1907/vps-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/cainiao1907/vps-pilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](#快速开始)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io/)


> **VPS Pilot** —— 本地运行的 AI Agent 驱动 VPS 远程运维客户端。
> 一个开源、可自托管的 SSH 终端 + 自主运维 Agent，支持 BYOK 接入任意大模型。

本地运行的 **AI Agent 驱动 VPS 远程运维客户端** —— 既是 SSH 终端工具，也是一个能理解自然语言、自主规划并执行运维任务的 AI Agent。

**English**: VPS Pilot is an open-source, local-first AI agent for VPS remote operations — an SSH/SFTP terminal client with a built-in LLM agent that plans and executes server tasks. It supports bring-your-own-key (BYOK) for any OpenAI-compatible model, ships an MCP server so external agents can drive your terminal, and gates every command through a risk engine before execution. Think of it as an open-source, self-hostable alternative to Termius + an AI copilot that runs entirely on your machine.

**关键词 / Keywords**: SSH 客户端 · VPS 管理面板 · AI 运维 Agent · 自然语言运维 · 自动化部署 · 危险命令拦截 · 服务器管理工具 · MCP Server · Model Context Protocol · Electron 桌面应用 · 多模型 BYOK · 跳板机 · SFTP · 代理隧道 · DevOps 自动化

## 为什么做这个

现有的工具都不满足「开源 + 本地桌面 + 可自接任意 LLM + 自主多步 VPS 运维」这个组合：

| 工具 | 缺口 |
|---|---|
| Termius / Xshell | 只有命令补全，没有 Agent |
| Kiro CLI | Agent 跑在服务器上，需在每台 VPS 装一堆东西，攻击面大 |
| ssh-mcp-server | 只是 MCP 能力层，没有客户端 UI |
| CtrlOps | 架构完全对，但闭源、付费、不可自托管 |
| Chaterm | 开源桌面端 Agent，但偏终端内 Copilot，绑定自家知识库体系 |

VPS Pilot 补上这个位置：**Agent 跑在你本地，只有你批准的命令才会经 SSH 发到服务器。**

## 核心能力

### 1. SSH 客户端
- 多主机管理，密码 / 私钥 / SSH Agent 三种认证
- 跳板机（Jump Host）支持
- **网络代理支持**：SOCKS5 / HTTP CONNECT，全局默认 + 单主机覆盖
- **一键连接诊断**：逐段检查链路，直接告诉你卡在哪一步
- 基于 xterm.js 的完整交互式终端，多标签
- SFTP 文件管理：浏览、查看、编辑、上传、下载、改名、删除
- 凭据使用系统级加密（Windows DPAPI / macOS Keychain）本地存储

### 2. 本地 AI Agent
- 自然语言描述目标 → 模型生成结构化执行计划
- 每个步骤包含：**命令 + 白话解释 + 风险等级**
- 三种审批模式：
  - `只读自动放行` — 查询类命令自动执行，写操作弹窗确认（推荐）
  - `每步确认` — 每条命令都要你点批准
  - `批准计划后自动执行` — 审一次整份计划，之后自动跑
- 命令可直接在界面上**编辑后再批准**
- 执行失败时自动判断：继续 / 重试 / 重新规划 / 中止
- 执行完成后生成中文总结报告

### 3. MCP 服务：让外部本地 Agent 接管终端

除了「填 API Key 用内置引擎」这一种形态，VPS Pilot 还能**被外部 Agent 驱动**。

开启后它同时是一个 **MCP（Model Context Protocol）Server**，WorkBuddy、豆包、
ZCode、Kimi 这类本地 Agent 挂上之后，就能直接连主机、往终端打字、读终端回显。

**两种传输**

| 传输 | 适用 | 特点 |
| --- | --- | --- |
| stdio | ZCode、Claude Code 等支持拉起本地进程的客户端 | 客户端自己拉起一个转发进程，无需填端口和 Token |
| Streamable HTTP | 豆包、Kimi、WorkBuddy | 常驻 `127.0.0.1:<端口>`，可被多个客户端同时连，需 Bearer Token |

**stdio 是怎么实现的**

关键约束：真正干活的 MCP 服务**必须跑在应用进程里**，因为 SSH 凭据是用
Electron `safeStorage`（Windows DPAPI / macOS Keychain）加密的，纯 Node 进程
解不开，就算拉起来也连不上服务器。

所以 `scripts/vps-pilot-mcp.js` 做的是**透明转发** —— 客户端拉起它，
它把 stdin 收到的每条 JSON-RPC 转给本机已运行的 VPS Pilot HTTP 端点，
再把响应写回 stdout。对内它自己会从应用配置里读端口和 Token，所以客户端
配置里什么都不用填：

```json
{
  "mcpServers": {
    "vps-pilot": {
      "command": "node",
      "args": ["D:/path/to/vps-pilot/scripts/vps-pilot-mcp.js"]
    }
  }
}
```

配置片段里的路径由应用在运行时算出来（`stdioScriptPath()`），
保证指向真实存在的文件。打包版会通过 `extraResources` 把脚本放到
`resources/scripts/` 下 —— 放在 asar 里的文件对普通 node 进程不是可执行的真实路径。

> 早期版本这里写的是 `npx -y vps-pilot-mcp`，但**那个包从未发布过**，
> 用户照抄必然失败。现已改成指向本地脚本，并有回归测试锁住
> （`stdio 片段不再引用未发布的 npm 包`）。

**暴露的工具**（底层原语 + 高层任务）

- 只读：`get_status`、`list_hosts`、`list_sessions`、`list_experts`、`list_skills`、`list_pending_approvals`
- 连接：`connect_host`、`disconnect_host`
- 终端：`read_terminal_output`（支持 `sinceSeq` 增量读取）、`send_terminal_input`
- 执行：`exec_command`（拿完整 stdout / stderr / 退出码）
- 高层：`run_agent_task`（把内置 Plan-Execute 引擎整个包成一个工具）、
  `get_agent_run_status`、`abort_agent_task`、`decide_approval`

**读取终端为什么能做到**

原始终端输出是主进程「零缓冲直传」给界面的，历史只活在 xterm 实例里，
外部 Agent 无从查起。为此新增了 `electron/main/terminal-buffer.ts`：
按主机分区的环形缓冲（默认 20000 行 / 4MB），在 `term:open` 的 `onData`
里同步 tee 一份。每条记录带单调递增 `seq`，调用方传回上次的 `nextSeq`
即可只拿增量，不会重复搬运历史。

**安全模型**

外部 Agent 拿到的是真终端，所以闸门必须比内置引擎更严：

1. **风险引擎照常拦**。所有写操作复用同一套 `assessRisk`。
   `critical`（`rm -rf /`、`mkfs`、fork 炸弹等）**硬拒绝，不受任何设置影响**。
2. **审批策略三选一**：`仅高风险需确认`（推荐）/ `每次都确认` / `免审批`。
3. **能力开关**：可分别关掉「写终端」「执行命令」「高危命令」「自动连接」。
   关掉的能力会**直接从工具清单里消失**，外部 Agent 不会「看得见调不动」。
4. **高危命令单独把关**。`允许执行高危命令` 默认关闭 —— 即使选了免审批，
   被评估为「高」风险的操作仍会被拒绝。
5. **审计来源标记为 `mcp`**，并记录是谁批的（界面人工 / 客户端策略自动）。
6. **HTTP 只绑 `127.0.0.1`**，Token 比较用恒定时间算法防时序侧信道。

挂起等人确认时，界面右下角会弹出审批条（带风险徽标、来源、完整命令），
无论用户当前在哪个页面都能看到并处理。

### 4. 安全闸门（关键设计）
破坏性命令被**硬拦截**，你连批准的机会都没有：

- `rm -rf /` 及系统关键目录递归删除
- `dd of=/dev/sda` 裸盘写入、`mkfs` 格式化
- Fork 炸弹、`shutdown` / `reboot`
- `iptables -F` 清空防火墙（会导致你永久失联）
- `curl ... | sh` 管道执行远程脚本
- `chmod -R 777 /`、`wipefs`、`shred /dev/*`

高危操作（递归删除、关服务、卸载包、改密码、改防火墙等）需人工确认。所有操作写入本地审计日志，可完整回溯。

### 4. BYOK 多模型
内置预设：DeepSeek、OpenAI、Anthropic、Moonshot、智谱 GLM、通义千问、Ollama 本地。也支持任意 OpenAI 兼容接口。API Key 加密存本地。

### 5. 网络代理与连接诊断

**什么时候需要代理？** 如果你遇到这种症状：

> ping 能通、TCP 看起来也连上了，但 SSH 握手就是拿不到响应，一直超时。

这通常意味着**链路中间有设备在伪造 TCP 握手**（透明代理、运营商干扰），你的流量其实根本没到达服务器。让 SSH 走代理出口绕开这段链路，问题通常立刻消失。

**配置方式**：`设置 → 网络代理`，选择 `SOCKS5` 或 `HTTP`，填上你代理软件的地址和端口。不确定端口是多少？点「检测本机代理」，会自动扫描常见端口（Clash 7890/7891、v2rayN 10808/10809、SS 1080 等）并列出正在监听的。

**单主机覆盖**：每台主机可以单独设置为「跟随全局」/「强制直连」/「单独配置」。国内服务器走代理反而更慢时，选「强制直连」。

**一键诊断**：主机概览页点「一键诊断」，会逐段验证并把结果直接摆出来：

| 检查项 | 说明 |
|---|---|
| 本机代理探测 | 有没有代理在跑、监听在哪个端口 |
| TCP 连通性 | 到目标端口能不能建立 TCP（直连口径） |
| SSH 协议响应 | 连上之后服务器有没有吐出 SSH banner |
| 代理隧道验证 | 通过代理实际打通一次完整隧道 |
| 认证方式预检 | 私钥文件在不在、是不是 .ppk、密码有没有存 |

每一步都会说明"看到了什么"，最后给出定位结论和可操作建议。代理隧道失败时还会自动补一次直连对照测试 —— 如果直连反而能通，会直接告诉你「把该主机设为直连」。

### 5. 专家（Persona）与技能（Skill）

Agent 默认是一台「什么都会一点」的通用助手。真正干活时，你往往希望它换个身份、按一套固定的方法论来。**专家**和**技能**就是给它的两副人格外挂。

**专家 —— 决定「以什么身份、用什么方法论」来规划**

同一个任务，交给不同专家，产出的计划粒度完全不同。例如「把服务跑起来」：

| 专家 | 它给出的计划特点 |
|---|---|
| 通用运维工程师 | 能跑起来就行，标准流程 |
| 资深 SRE | 会先问可观测性、回滚方案、影响面 |
| 新手向导 | 每条命令都解释一遍，告诉你为什么这么敲 |
| 合规审查员 | 会要求变更窗口、审批记录、回滚预案 |

内置 12 个专家：通用运维工程师、资深 SRE、安全加固专家、容器/Docker 专家、Web 服务与反代专家、数据库专家、故障排查专家、性能调优专家、网络专家、新手向导、变更与合规审查员、极简主义者。

每个专家还可以**建议一个审批模式** —— 选用「合规审查员」时，审批模式会自动切到「每步都需我确认」，你仍然可以手动改回去。

**技能 —— 把「这件事该怎么做」的专业配方喂给 Agent**

技能是一份可复用、带参数的操作手册。比如「Nginx 站点部署」技能里写死了工程师多年踩坑总结的顺序：先确认端口占用 → 再写配置 → `nginx -t` 校验 → 平滑 reload，以及「配置错误会导致 reload 后整个 nginx 挂掉」这类风险提示。

技能支持**参数占位符**：在技能正文里写 `{{domain}}`、`{{port}}`，Agent 面板选中该技能后会就地渲染出输入框，你填什么，配方里就替换成什么。

内置 12 个技能：磁盘空间分析、Nginx 站点部署、Docker 应用部署、HTTPS 证书配置、防火墙配置、SSH 安全加固、创建系统服务、数据备份与恢复、性能瓶颈定位、Node.js 应用部署、用户与权限管理、日志分析与排查。

**怎么用**

1. 「设置 → 专家 / 技能」浏览内置库，可以「设为默认」（每次新任务自动带上）、「停用」、「复制成自定义」后编辑
2. 在 Agent 面板顶部的下拉里临时切换专家；技能区点「+ 技能」按分类挑选
3. 界面上会实时**推荐技能** —— 你在任务描述里提到「nginx」「证书」这类词，匹配到的技能会浮在输入框上方，点一下就加上
4. 运行时步骤列表顶部会显示当前使用的「专家 + 技能」组合，方便回溯这次计划是怎么来的

**关于内置与自定义的取舍**：内置专家和技能**不能直接编辑，只能复制**。这不是限制，而是为了保护你 —— 内置内容会随版本升级持续改进，如果允许原地修改，你的改动会在升级时被覆盖，或者你永远停在旧版本。用「复制成自定义」，你的定制和官方的更新就互不干扰。

## 设计规范

这是一个「长时间盯屏」的运维工具，终端会占满大部分视野，内容本身（日志、命令输出）
已经是高信息密度的。所以 UI 的配色原则是**退到内容后面去**，而不是抢眼。

**色板**

| 角色 | 变量 | 色彩 | 用途 |
|---|---|---|---|
| 品牌/强调 | `--accent` `#4f8fd4` | 低饱和蓝 | 当前选中、可点击。原 `#58a6ff` 明度太高，在纯黑终端旁会形成刺眼光斑 |
| 成功 | `--ok` `#3d9c52` | 绿 | 连接正常、执行成功 |
| 警告 | `--warn` `#b8892a` | 黄 | 需要留意（未配置模型、只读自动放行） |
| 危险 | `--danger` `#c1443c` | 红 | 破坏性操作、硬拦截 |
| 灰阶 | `--bg-0`~`--bg-4` | 5 级 | `bg-0` 最深（终端）→ `bg-4` 最浅（浮层） |

**按钮颜色表达操作优先级，不表达状态。** 所以默认按钮是中性灰，只有「当前场景的主操作」
才上色；成功/失败由状态点、徽章、提示条承担 —— 避免语义串台（否则「保存」和
「执行成功」撞色，用户会误读状态）。

四级层级：`.btn`（中性，次级操作）→ `.btn-primary`（主操作，场景里只能有一个）→
`.btn-accent`（品牌色，新建/跳转）→ `.btn-danger`（破坏性，删除/强制断开）。
另有 `.btn-danger-ghost` 用于「不该抢焦点但必须能一眼认出是危险操作」的场景。

**z-index 体系**集中在 `global.css` 顶部，不再散落硬编码数字：

```
--z-layer 1        内容层（工作区 / 各功能页）
--z-rail 10        左侧导航栏
--z-aside 10       主机列表
--z-titlebar 100   标题栏（常驻，永远压在上面）
--z-statusbar 100  状态栏
--z-modal 1000     模态框
--z-toast 2000     提示条
```

**交互规范**

- 所有可点击元素有 hover / active / focus-visible 三态。用 `:focus-visible` 而不是
  `:focus` —— 鼠标点击不留焦点环（视觉噪音），键盘 Tab 必须看得见当前在哪
- 微动效：按钮按下 `translateY(1px)`、卡片 hover 抬升 1px、导航项按下 `scale(0.96)`。
  全部控制在 100–150ms，运维场景下动画是为了提供反馈，不是为了表演
- 主机列表项的操作按钮**默认隐藏、hover/聚焦才显形** —— 列表静止时极干净
  （一屏扫完所有主机），按钮又出现在鼠标已停住的位置（Fitts 定律）
- 尊重系统「减少动态效果」偏好（`prefers-reduced-motion`）

## 技术栈

- **外壳**：Electron 33 + Vite 6 + React 18 + TypeScript
- **终端**：xterm.js + fit/web-links 插件
- **SSH/SFTP**：ssh2（支持跳板机、exec channel、shell channel）
- **代理**：自研 SOCKS5（RFC 1928）/ HTTP CONNECT 隧道，经 ssh2 的 `ConnectConfig.sock` 注入
- **存储**：JSON 文件 + 原子写盘（临时文件 + rename），内存索引提速
- **加密**：Electron safeStorage（DPAPI/Keychain），降级 AES-256-GCM
- **Agent**：自研 Plan-Execute 循环，OpenAI 兼容 chat completions
- **专家/技能**：内置模板库 + 用户自定义，分层拼装系统提示词，`{{key}}` 占位符模板渲染

## 快速开始

### 方式一：直接下载安装包（推荐，零配置）

Windows 用户直接下载安装即可，**无需安装 Node.js**：

👉 **[下载 VPS Pilot v0.1.0 安装包](https://github.com/cainiao1907/vps-pilot/releases/latest)**

> ⚠️ 当前版本未做代码签名，Windows SmartScreen 可能提示「未知发布者」。
> 点击「更多信息」→「仍要运行」即可。源码完全公开，可自行审查或从源码构建。

### 方式二：双击启动文件（从源码运行）

项目根目录有三个批处理文件，**双击即可**：

| 文件 | 用途 |
|---|---|
| `启动.bat` | 日常使用。自动检查依赖、按需编译、启动应用 |
| `开发模式.bat` | 改代码时用，界面热重载，无需重启 |
| `打包exe.bat` | 生成 Windows 安装包，产物在 `release/` 目录 |

`启动.bat` 是幂等的：依赖装过就跳过，编译产物在就跳过，可以直接反复双击。

首次双击会自动执行 `npm install`（约 3-5 分钟，取决于网速），之后每次都是秒开。

> 仅需系统已安装 Node.js（https://nodejs.org）。脚本会自己检测，缺了会提示。

### 方式三：命令行

```bash
npm install
npm run electron:dev    # 开发模式（Vite HMR + Electron）
```

### 首次使用

1. 「设置」→「模型配置」→ 添加一个模型（填 API Key，点「测试连接」验证）
2. 左侧「+ 添加」录入你的 VPS
3. 点「连接」→ 打开「AI Agent」
4. 输入自然语言任务，例如：
   - `在 /www/wwwroot 下部署一个 Nginx 静态站点并反代到 3000 端口`
   - `检查磁盘和内存使用，找出占用最大的目录`
   - `安装 Docker 并把我的 Node 应用跑起来`
   - `排查 80 端口为什么访问不了`

## 打包

```bash
npm run electron:build   # 产物在 release/
```

或直接双击 `打包exe.bat`。

## 关于无显卡环境的处理（重要）

在没有独立显卡驱动的机器上（云服务器、部分虚拟机、远程桌面、容器），
Chromium 的 GPU 进程会反复崩溃，最终 `FATAL` 直接杀掉进程，窗口根本创建不出来。

应用为此设计了**五层保险**，全自动、无需手动干预：

1. **显卡探测** —— 系统里查不到任何显示适配器时，直接走软件渲染
2. **环境变量** `VPSPILOT_SOFTWARE_RENDER=1` —— 用户显式指定
3. **偏好文件** —— 之前确认过需要软件渲染，之后启动直接复用
4. **崩溃标记** —— 上次启动崩过，本次直接软件渲染
5. **启动脚本自动重试** —— `启动.bat` 第一次失败后自动带 `--software-render` 重试

有显卡的正常机器不会命中任何一条，仍然使用硬件加速。

实际表现：**全新机器上第一次启动约需多花 2 秒**（探测 → 命中兜底 → 重试成功），
成功后会记住偏好，**之后每次启动都是秒开**。

## 项目结构

```
electron/
  main/
    index.ts          # 主进程入口 + 全部 IPC 注册 + 渲染策略
    db.ts             # JSON 存储：主机/模型/审计/设置/自定义专家/自定义技能（原子写盘）
    secure-store.ts   # 凭据加密
    ssh.ts            # SSH 连接池、shell、exec、SFTP（含代理/跳板机接入）
    proxy.ts          # SOCKS5 + HTTP CONNECT 隧道，产出 ssh2 可用的 Duplex
    proxy-resolve.ts  # 代理三层优先级解析（全局 / 强制直连 / 单独配置）
    diagnose.ts       # 连接诊断：代理探测 / TCP / banner / 隧道 / 认证预检
    llm.ts            # BYOK LLM 客户端（含流式）
    registry.ts       # 专家/技能注册表：内置+自定义合并、模板渲染、提示词分层拼装
    agent.ts          # Agent 引擎：规划 → 审批 → 执行 → 重规划 → 汇总
    terminal-buffer.ts # 终端输出环形缓冲（按主机分区 + seq 增量读取 + ANSI 剥离）
    mcp/              # MCP Server：让外部本地 Agent 反向控制本软件
      index.ts        #   统一启停入口 + 设置热重载 + 客户端配置片段生成
      server.ts       #   会话状态机 + 方法分发（initialize / tools/list / tools/call）
      jsonrpc.ts      #   JSON-RPC 2.0 编解码与标准错误码
      tools.ts        #   工具定义与门控（被关掉的工具不出现在清单里）
      handlers.ts     #   工具实现：安全闸门 + 审批挂起 + 审计（source='mcp'）
      stdio.ts        #   stdio 传输（日志一律走 stderr，不污染协议流）
      http.ts         #   Streamable HTTP 传输（仅绑回环 + Bearer Token + SSE）
  preload/index.ts    # 白名单 API 桥
src/
  shared/
    types.ts          # 共享类型
    risk.ts           # 危险命令规则引擎（核心安全模块）
    presets.ts        # 模型供应商预设 + 常见代理端口表 + 默认设置
    experts.ts        # 内置专家库（12 个）+ 内置技能库（12 个）
  components/         # NavRail（一级导航） / LibraryPanel（专家库）
                      # / HostManager / ProxyForm / TerminalView / AgentPanel
                      # / SftpPanel / AuditPanel / SettingsPanel
                      # / ExpertsPanel / SkillsPanel / ErrorBoundary
  styles/global.css   # 设计令牌（色板 / z-index 体系）+ 布局骨架
  App.tsx             # 三段式布局 + 常驻工作区
  store.ts            # 状态 + 导航状态机
scripts/
  make-launchers.py   # 生成三个 .bat 启动文件
  electron-dev.mjs    # 开发模式启动器
  test-risk.ts        # 风险引擎单元测试（53 项）
  test-proxy.ts       # 代理协议自测（13 项，起假代理服务器验证握手字节流）
  test-registry.ts    # 专家/技能系统自测（52 项）
  test-dom-events.ts  # 键盘事件隔离 + 源码约定回归（32 项）
  test-ui.tsx         # UI 组件静态渲染冒烟测试（97 项）
  test-mcp.ts         # MCP 服务端到端自测（137 项，假客户端驱动真实 Server + 真实 HTTP）
  e2e-test.js         # 端到端测试（18 项）
  check-host.ts       # 对真实主机跑一次诊断，排查链路问题用
  ts-loader.mjs       # 纯 Node 跑 TS 源码的 loader（补扩展名 + 还原 @shared 别名）
  ts-resolve-hook.mjs
  stub-electron.mjs   # electron 桩，供上述 loader 在无 Electron 环境下使用
```

## 界面结构

```
┌──────────────────────────────────────────────────────────┐
│ 标题栏：品牌 · 连接数 · 当前模型          (z: 100, 常驻)  │
├────┬──────────────┬──────────────────────────────────────┤
│ ▮  │              │ 标签栏  终端 / Agent / 文件           │
│ 🖥  │  主机列表     ├──────────────────────────────────────┤
│ ☰  │  (仅主机相关   │                                      │
│ 🧩 │   分组显示)   │  工作区 —— 常驻挂载，永不卸载         │
│ ⚙  │              │  (z: 1)                              │
├────┴──────────────┴──────────────────────────────────────┤
│ 状态栏：主机数 · 连接数 · 错误信息          (z: 100)      │
└──────────────────────────────────────────────────────────┘
```

**一级导航分组**（左侧图标栏）：

| 分组 | 内容 | 频率 |
|---|---|---|
| 工作区 | 终端 · AI Agent · 文件管理（多标签） | 高频，依赖当前主机 |
| 主机 | 服务器清单、连接、配置 | 次高频 |
| 审计 | 命令执行历史与风险回溯 | 中频 |
| 专家库 | 专家（Persona）· 技能（Skills） | 低频配置 |
| 设置 | 模型 · 代理 · 通用 | 低频配置 |

**为什么专家/技能不在设置页**：模型和代理是「本机怎么连、用哪个大脑」的机器配置；
专家和技能是「Agent 以什么身份、按什么方法论干活」的内容资产。混在一起时，想改模型
要先在六个标签里找；而且专家/技能需要被反复挑选和调整，低频项不该占导航黄金位。
现在从「选专家 → 去 Agent 跑任务」是一条连贯动线。

**工作区常驻是硬性约束**。切换导航只做视觉隐藏（`visibility: hidden` +
`pointer-events: none` + 原生 `inert`），绝不条件渲染卸载。原因：`TerminalView`
的 cleanup 会执行 `term.dispose()`，一旦卸载，正在服务器上跑的命令变成孤儿进程、
滚回历史（20000 行）全部丢失，重新挂载还要重走 `termOpen`。
`scripts/test-dom-events.ts` 第 10 组用源码约定断言锁住了这条。

**滚轮隔离**：所有可滚动面板带 `overscroll-behavior: contain`。在设置页滚到底
再继续滚，不会让背后的终端一起动。

## 自带测试

```bash
npm run test:all   # 类型检查 + 全部单测（398 项）
```

| 命令 | 覆盖范围 |
|---|---|
| `npm run typecheck` | 全量 TypeScript 类型检查 |
| `npm run test:risk` | 危险命令规则引擎（57 项） |
| `npm run test:proxy` | SOCKS5 / HTTP CONNECT 协议字节流（13 项） |
| `npm run test:registry` | 专家/技能库完整性、模板渲染、提示词拼装顺序（52 项） |
| `npm run test:events` | 键盘事件隔离、监听器生命周期、布局源码约定（32 项） |
| `npm run test:ui` | 组件静态渲染冒烟：导航、专家库、设置路由、代理表单、诊断报告（97 项） |
| `npm run test:mcp` | MCP 服务端到端：JSON-RPC、终端缓冲、生命周期、工具调用、HTTP 鉴权、客户端片段（147 项） |

`test:mcp` 用「假 MCP 客户端」驱动**真实 Server**，并且真的起一个 HTTP 服务
去打（端口传 `0` 让系统分配，避免和开发环境抢端口）。它覆盖了协议错误码、
工具门控、`critical` 命令硬拒绝、Token 鉴权、SSE 响应、会话头下发等路径。
最后一组是**源码约定校验** —— 用正则断言关键实现没被悄悄改掉，比如
「写操作必须走 `gateOperation`」「HTTP 必须绑 `127.0.0.1`」「stdio 日志不许进 stdout」。

`test:ui` 用 `react-dom/server` 把组件渲染成 HTML 字符串再断言关键文案。它不能替代真实浏览器测试，
但能在没有图形环境（CI、服务器、容器）时抓住「组件抛错 / 条件分支缺失 / 文案打错」这类问题 ——
本项目就是在这一步抓出了 `useStore` 缺少 `getServerSnapshot` 导致的 SSR 崩溃。

`test:events` 用 40 行的假 DOM 精确控制「焦点在哪个元素上」，验证全局键盘监听器
不会吞掉终端输入。它同时校验 `Modal` 和工作区的**源码实现**是否遵守约定 ——
因为这类 bug 的形态是「逻辑悄悄退化」，光靠行为测试容易被绕过。

## 故障复盘：终端在切换页面后失效

**现象**：连上终端 → 进设置页点「专家」或「技能」→ 回到终端。终端再也打不了字、
滚轮不响应、顶部按钮全部点不动，只能回主界面。

这是**两个独立缺陷叠加**的结果，两个都修了。

### 缺陷一：工作区被条件渲染卸载

原实现按 `view` 条件渲染整个工作区：

```tsx
{view === 'terminal' && ( /* 标签栏 + 终端 */ )}
```

切到设置页时 `view` 变成 `'settings'`，整棵子树被卸载，`TerminalView` 的 cleanup
执行 `term.dispose()` + `termRef.current = null`。后果：

- SSH shell channel 还连着，但没有任何人接收输出 → 正在跑的命令成孤儿
- 20000 行 scrollback 全丢
- 回到工作区时重新挂载、重新 `termOpen`，而主进程侧的旧 channel 可能还没清理干净

**修法**：工作区改为常驻挂载，切换只做视觉隐藏（`visibility: hidden` +
`pointer-events: none` + 原生 `inert`）。用 `inert` 是必要的 —— 否则 Tab 键会跑进
看不见的终端里，用户会陷入「焦点消失了」的困惑。

### 缺陷二：全局键盘监听器吃掉终端输入

`Modal` 用 `window` 上的监听器处理 Escape：

```tsx
React.useEffect(() => {
  const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
  window.addEventListener('keydown', h);
  return () => window.removeEventListener('keydown', h);
}, [onClose]);   // ← 依赖数组里放着每次渲染都新建的 onClose
```

两个问题：

1. `onClose` 每次父组件渲染都是新函数，依赖数组带着它 → 反复「先卸载再注册」。
   任何一次 cleanup 没跑到，就留下一个幽灵监听器。
2. 监听器在 `window`（冒泡链末端），xterm 的处理器在 `.xterm-helper-textarea`。
   两者都会收到事件 —— 而旧实现无条件调用 `onClose()`（对已卸载组件 setState）。

**修法**：

- 用 `ref` 承接 `onClose`，依赖数组留空 → 一个生命周期只注册一次
- **只在焦点确实落在模态框内时才响应 Escape**，其余情况完全透明：
  不 `preventDefault`、不 `stopPropagation`、不做任何状态变更
- 打开时把焦点移进模态框，关闭时还回去 —— 否则关闭后焦点掉到 `body`，
  终端同样收不到键盘事件

### 为什么这两条现在锁住了

`scripts/test-dom-events.ts`（32 项）用 40 行假 DOM 精确控制「焦点在哪个元素上」，
覆盖：焦点在终端时监听器必须透明、幽灵监听器堆叠时必须全体静默、
监听器注册/注销次数必须相等、`activeElement` 为 null 时不崩。

同时校验 `Modal` 和工作区的**源码实现**是否遵守约定（正则匹配关键语句）——
这类 bug 的形态是「逻辑悄悄退化」，纯行为测试容易被绕过。
不引入 jsdom 是刻意的：只需要「事件监听 + activeElement + contains」三件事，
为验证它们引入 10MB 依赖不划算，手写桩子反而让每条约定都写在明面上。

> **人工验证清单**（自动化测试覆盖不到 Electron 真实渲染）：
> 1. 连上主机打开终端，敲几条命令确认有回显
> 2. 切到「专家库 → 专家」，打开一个专家的「编辑」弹窗，按 Esc 关掉
> 3. 切回「工作区」—— 终端应该**保留着之前的输出**，且能立即打字
> 4. 在终端里滚轮翻历史，确认能滚动
> 5. 在设置页滚到底后继续滚，确认背后的终端没跟着动
> 6. 顶部标题栏的连接数、模型名始终可见可点
>
> **MCP 专项验证**（需要另一个能连 MCP 的客户端）：
> 1. 设置 → MCP 服务，打开总开关，生成 Token，确认状态灯变绿、端口在监听
> 2. 浏览器访问 `http://127.0.0.1:<端口>/health` 应返回 `{"ok":true,...}`
> 3. 用外部客户端连上（或用 `curl -H "Authorization: Bearer <token>" ...` 手工打），
>    调用 `list_hosts` 应能拿到主机列表
> 4. 让外部客户端调 `exec_command` 执行 `ls`，此时界面右下角**应弹出审批条**，
>    批准后客户端拿到输出；刷新「审计」页应看到来源为 `mcp` 的记录
> 5. 让外部客户端执行 `rm -rf /` 或 `rm -rf / --no-preserve-root`，
>    确认被**硬拒绝**（`isError: true`）且界面无弹窗（根本不给批准机会）
> 6. 关掉「允许写入终端」再让客户端调 `send_terminal_input`，应报工具不可用
> 7. 改端口后保存，确认服务自动重启并监听新端口

不想手工敲的话，有三个现成脚本。都必须在**同一次进程生命周期内**跑完 ——
GUI 应用没法被后台拉起后在后续命令里访问。

```bash
npm run mcp:live        # 断言式回归（HTTP 通道）：9 组检查
npm run mcp:stdio-test  # 断言式回归（stdio 通道）：8 组检查，模拟外部客户端拉起转发脚本
npm run mcp:demo        # 展示式演练：12 步，把每步的真实请求/响应数据全打出来
```

`mcp:stdio-test` 验的是 ZCode / 只支持 stdio 的客户端实际会走的那条路：
它用 `spawn` 把 `vps-pilot-mcp.js` 当外部客户端拉起来，通过 stdin/stdout 说话，
确认转发、会话保持、危险命令拦截、错误码、退出行为都正确。

`mcp:demo` 适合配合界面一起看，它会依次演示：监听确认、协议握手、工具清单、
主机列表、危险命令拦截（打印协议层 `isError` 与结构化 `risk`）、连接真机、
读终端、写终端、增量读取、`exec` 通道、会话与审计、断开连接。

三个脚本都会自己把 `userData` 指回真实应用目录（裸脚本启动时 `app.getName()`
会退化成 `"Electron"`，配置会读错地方），所以不需要额外传参。

> 跑之前有两个坑：
> 1. `ELECTRON_RUN_AS_NODE` 必须**不存在**，空字符串也算存在。
>    Bash 下用 `env -u ELECTRON_RUN_AS_NODE npm run mcp:demo`。
> 2. 确认**没有残留的 Electron 进程占着端口**。应用有单实例锁，
>    残留实例会让新启动的进程直接 `app.quit()`，表现是「脚本跑一半就没了」。
>    Windows 下 `taskkill /F /IM electron.exe` 清一下再跑。

### 真机联调抓到的两个静默失败

这两条都只在「真实 HTTP 打真实 Server」时才暴露，单测和类型检查都看不出来：

**一、`isError` 被吞在 `data` 里**

工具定义普遍写成 `return { text: msg, data: result }`，而被安全闸门拒绝时
`result` 是 `{ ok: false, isError: true, ... }`。但 `tools/call` 早期只读
`result.isError` —— 工具层对象上并没有这个字段，于是协议层返回
`isError: false`。**命令明明没执行，外部 Agent 却收到「调用成功」。**

修法：失败判定同时看两处。

```ts
const failed = result.isError === true || result.data?.isError === true;
// ...
return { response: ok(id, { content, isError: failed }) };
```

**二、`rm -rf / --no-preserve-root` 漏判为 `high`**

`rm-system-path` 原来的结尾是 `\s*($|[;&|])` —— 要求 `/` 后面紧跟空白再跟分隔符。
但 `rm -rf / --no-preserve-root` 里 `/` 后面还有别的参数，`\s*` 匹配失败，
规则整体不命中，命令落进 `high` 级；而 `high` 是可以被「允许高危命令」放行的。
**破坏性最强的写法反而比 `rm -rf /` 更容易通过。**

修法：结尾改成「空白 **或** 分隔符」，并让 `--no-preserve-root` 单独成规则、
不关心路径怎么写。`scripts/test-risk.ts` 加了 4 条回归用例锁住。

> 教训：安全规则的**边界锚点**要用「或」而不是「必须」。
> `\s*(A|B)` 和 `(\s|A|B)` 看起来只差一个字符，实际是完全不同的拦截强度。

## 安全边界

- 明文密码与 API Key **永不落盘**，也永不出主进程；渲染进程只能拿到「是否已设置」的布尔值
- 代理密码同样走系统级加密存储，规则与 SSH 密码完全一致
- 渲染进程开启 `contextIsolation`，关闭 `nodeIntegration`，CSP 限制脚本来源
- Agent 生成的每条命令都经过风险引擎评估，硬拦截规则无豁免
- **MCP 通道与内置 Agent 共用同一套风险引擎**：`critical` 级命令无论来自界面、
  内置 Agent 还是外部 MCP 客户端，一律硬拒绝，没有任何设置能豁免
- MCP 的 HTTP 传输只绑定 `127.0.0.1`，不监听外部网卡；Token 比较使用恒定时间算法
- MCP 的每项能力（写终端 / 执行命令 / 高危命令 / 自动连接）都可独立关闭，
  关闭后对应工具会从 `tools/list` 中移除，而非仅靠运行时校验
- 外部 Agent 的高危写操作默认需要人工在界面上确认，审批记录连同「谁批的」一并入库
- 专家提示词不能覆盖输出格式约束 —— 系统提示词按「基础规则 → 专家人格 → 技能配方 → 用户要求」固定顺序拼装，
  并在专家段末尾重新声明 JSON 输出要求，防止专家人格把输出结构带偏导致计划解析失败
- 技能里的参数占位符只做纯文本替换，不执行任何表达式；自定义技能与内置技能走完全相同的渲染路径
- 只有你配置的模型 API 会收到命令上下文（用于规划和总结），不向任何第三方上传服务器信息
- 代理流量仅在你本机与代理服务器之间传输，代理地址与凭据不会离开本机

## 常见问题

**Q: 需要什么 API Key？可以用免费的吗？**

任何 OpenAI 兼容接口都能接（DeepSeek / OpenAI / Anthropic / Kimi / 智谱 / 通义，或本地 Ollama）。BYOK，你自己的 Key，不经过任何中间服务器。

**Q: 会把我服务器的密码上传到云端吗？**

不会。凭据用系统级加密（Windows DPAPI / macOS Keychain）存在本地，明文永不落盘、永不出主进程。只有命令上下文（用于规划和总结）会发给你自己配置的模型 API。

**Q: Agent 会乱执行危险命令吗？**

不会。每条命令都过风险引擎三级判定：**硬拦截**（`rm -rf /` 等，无任何豁免）、**高危**（需你确认）、**只读**（自动放行）。默认审批模式是「计划一次性确认」。

**Q: 支持哪些平台？**

Windows / macOS / Linux。Windows 提供双击即用的批处理与安装包，开箱即用。

**Q: 和 Termius、Kiro CLI、Chaterm 有什么区别？**

见上文[「为什么做这个」](#为什么做这个)——核心差异是 **Agent 跑在你本地、开源可自托管、支持任意模型、每条命令都有安全闸门**。

## Roadmap

- [x] SSH/SFTP 客户端 · 多标签终端 · 跳板机 · 代理
- [x] 本地 AI Agent（Plan-Execute 循环 + 逐条审批）
- [x] 危险命令风险引擎（三级判定）
- [x] MCP 服务（HTTP + stdio 转发）
- [x] 专家（Persona）与技能（Skill）系统
- [x] BYOK 多模型（OpenAI 兼容）
- [ ] 主机分组与批量执行
- [ ] 运维任务计划（定时 / 事件触发）
- [ ] 团队协作与共享主机（加密同步）
- [ ] 更多内置专家与技能模板

> 有想要的功能？欢迎开 [Issue](https://github.com/cainiao1907/vps-pilot/issues) 或 [Discussion](https://github.com/cainiao1907/vps-pilot/discussions)。

## 贡献

欢迎任何形式的贡献！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- 报告缺陷 → [提交 Bug](https://github.com/cainiao1907/vps-pilot/issues/new?template=bug_report.yml)
- 功能建议 → [提交 Feature](https://github.com/cainiao1907/vps-pilot/issues/new?template=feature_request.yml)
- 提交代码 → Fork + PR，`npm run test:all` 需全绿
- **安全漏洞请勿公开提交**，走 [Security Advisory](https://github.com/cainiao1907/vps-pilot/security/advisories/new) 私下报告

## Star 趋势

如果这个项目对你有帮助，欢迎点个 ⭐ Star 支持一下！

## License

MIT


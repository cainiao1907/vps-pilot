# VPS Pilot v0.1.0

首个公开版本。本地运行的 AI Agent 驱动 VPS 远程运维客户端 —— 既是 SSH 终端工具，也是一个能理解自然语言、自主规划并执行运维任务的 AI Agent。

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows x64 | `VPS Pilot-0.1.0-setup.exe` | 安装版，可选安装目录，自动创建快捷方式 |
| macOS / Linux | — | 暂未提供预编译包，可从源码构建（见 README） |

> ⚠️ 本版本未做代码签名，Windows SmartScreen 可能提示「未知发布者」。
> 点击「更多信息」→「仍要运行」即可。源码完全公开，可自行审查或从源码构建。

## 核心能力

### SSH / SFTP 客户端
- 多主机管理，支持密码 / 私钥 / SSH Agent 三种认证
- 跳板机（Jump Host）
- SOCKS5 / HTTP CONNECT 代理，全局默认 + 单主机覆盖
- 一键连接诊断，逐段定位链路故障
- 基于 xterm.js 的完整交互式终端，多标签
- SFTP 文件管理：浏览 / 查看 / 编辑 / 上传 / 下载 / 改名 / 删除
- 凭据使用系统级加密本地存储（Windows DPAPI / macOS Keychain）

### 本地 AI Agent
- 自然语言 → JSON 计划 → 逐条审批 → SSH 执行
- 执行失败自动判断（continue / retry / replan / abort）
- 中文总结，多步任务自动串联
- 三种审批模式：只读放行 / 每步确认 / 计划一次确认

### 安全闸门（关键设计）
- 危险命令三级风险引擎：**硬拦截**（无豁免）/ **高危**（需确认）/ **只读**（自动放行）
- 明文密码与 API Key 永不落盘、永不出主进程
- 渲染进程开启 contextIsolation，关闭 nodeIntegration，CSP 限制脚本来源

### MCP 服务
- 把终端与命令能力暴露给外部本地 Agent（如 ZCode）
- HTTP 传输仅绑定 `127.0.0.1`，Token 恒定时间比较
- 每项能力（写终端 / 执行命令 / 高危命令 / 自动连接）可独立关闭
- 审计记录连同「谁批的」一并入库

### BYOK 多模型
- 内置预设：DeepSeek / OpenAI / Anthropic / Kimi / 智谱 / 通义
- 任意 OpenAI 兼容接口，含本地 Ollama
- API Key 加密存储，界面只显示「是否已设置」

### 专家与技能
- 内置专家（Persona）与技能（Skill）模板库
- 系统提示词分层拼装：基础规则 → 专家人格 → 技能配方 → 用户要求

## 系统要求

- Windows 10 / 11（x64）
- 无需预装 Node.js（安装包已内置运行时）

## 快速上手

1. 「设置」→「模型配置」→ 添加一个模型（填 API Key，点「测试连接」）
2. 左侧「+ 添加」录入你的 VPS
3. 点「连接」→ 打开「AI Agent」
4. 输入自然语言任务，例如：
   - `在 /www/wwwroot 下部署一个 Nginx 静态站点并反代到 3000 端口`
   - `检查磁盘和内存使用，找出占用最大的目录`
   - `安装 Docker 并把我的 Node 应用跑起来`

## 技术栈

Electron 33 · Vite 6 · React 18 · TypeScript 5.7 · xterm.js · ssh2

## 已知限制

- 安装包未签名（SmartScreen 会提示）
- 暂未提供 macOS / Linux 预编译包
- 应用图标使用 Electron 默认图标

## 反馈

- 缺陷报告：[提交 Bug](https://github.com/cainiao1907/vps-pilot/issues/new?template=bug_report.yml)
- 功能建议：[提交 Feature](https://github.com/cainiao1907/vps-pilot/issues/new?template=feature_request.yml)
- 安全漏洞：请走 [Security Advisory](https://github.com/cainiao1907/vps-pilot/security/advisories/new) 私下报告

---

**完整变更**：首次发布，详见 [README](https://github.com/cainiao1907/vps-pilot#readme)。

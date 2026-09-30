# VPS Pilot v0.1.1

本次更新为应用配上了正式图标。

## 下载

| 平台 | 文件 |
|---|---|
| Windows x64 | `VPS Pilot-0.1.1-setup.exe` |

> ⚠️ 本版本未做代码签名，Windows SmartScreen 可能提示「未知发布者」。
> 点击「更多信息」→「仍要运行」即可。源码完全公开，可自行审查或从源码构建。

## 本次变更

### 新增
- **应用图标**：终端提示符 `>` 与飞机组合，呼应「SSH 终端 + 领航」的产品语义；
  配色沿用界面主题（`#4f8fd4` 蓝 / `#131a21` 深底），保证品牌一致性
- 图标已接入三个平台：Windows 用多尺寸 `.ico`（16/24/32/48/64/128/256，
  系统按任务栏 / 文件列表 / 属性页等场景自动选用最合适的一档）；
  macOS / Linux 使用对应档位 PNG
- NSIS 安装器、卸载器、安装向导头部图标同步替换（此前为 Electron 默认图标）

### 修复
- 打包日志中不再出现 `default Electron icon is used` 警告

## 完整功能

VPS Pilot 是本地运行的 AI Agent 驱动 VPS 远程运维客户端：

- **SSH / SFTP 客户端** —— 多主机、跳板机、SOCKS5/HTTP 代理、连接诊断、xterm.js 多标签终端
- **本地 AI Agent** —— 自然语言 → JSON 计划 → 逐条审批 → SSH 执行，失败自动重试/重规划
- **安全闸门** —— 危险命令三级风险引擎（硬拦截 / 高危确认 / 只读放行）
- **MCP 服务** —— 把终端能力暴露给外部 Agent，HTTP 仅绑定 127.0.0.1
- **BYOK 多模型** —— DeepSeek / OpenAI / Anthropic / Kimi / 智谱 / 通义，或本地 Ollama
- **专家与技能** —— 内置 Persona / Skill 模板库，系统提示词分层拼装

## 系统要求

- Windows 10 / 11（x64）
- 无需预装 Node.js

## 快速上手

1. 「设置」→「模型配置」→ 添加模型（填 API Key，点「测试连接」）
2. 左侧「+ 添加」录入你的 VPS
3. 点「连接」→ 打开「AI Agent」
4. 输入自然语言任务，例如 `检查磁盘和内存使用，找出占用最大的目录`

## 完整变更

**v0.1.1 相对 v0.1.0**：[比对完整差异](https://github.com/cainiao1907/vps-pilot/compare/v0.1.0...v0.1.1)

**上一版本**：[v0.1.0](https://github.com/cainiao1907/vps-pilot/releases/tag/v0.1.0)（首个公开版本）

---

- 缺陷报告：[提交 Bug](https://github.com/cainiao1907/vps-pilot/issues/new?template=bug_report.yml)
- 功能建议：[提交 Feature](https://github.com/cainiao1907/vps-pilot/issues/new?template=feature_request.yml)
- 安全漏洞：走 [Security Advisory](https://github.com/cainiao1907/vps-pilot/security/advisories/new) 私下报告

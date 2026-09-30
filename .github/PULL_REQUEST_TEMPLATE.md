<!--
感谢提交 PR！请先阅读 CONTRIBUTING.md。
标题请遵循 Conventional Commits，例如：
  feat(mcp): 新增 SFTP 上传工具
  fix(risk): 修复 rm -rf / 漏判为高危
-->

## 改动说明

<!-- 一句话概括这个 PR 做了什么 -->

## 为什么这样改

<!-- 说明动机与背景。如果是修 bug，请描述原缺陷的根因 -->

## 改动类型

- [ ] 缺陷修复（fix）
- [ ] 新功能（feat）
- [ ] 重构（refactor）
- [ ] 性能优化（perf）
- [ ] 文档（docs）
- [ ] 测试（test）
- [ ] 其他（chore）

## 影响范围

<!-- 勾选受影响的模块 -->

- [ ] SSH 连接 / 终端
- [ ] AI Agent
- [ ] MCP 服务
- [ ] SFTP 文件管理
- [ ] 危险命令风险引擎
- [ ] 模型 / BYOK 配置
- [ ] 代理 / 连接诊断
- [ ] 专家 / 技能
- [ ] 界面
- [ ] 构建 / 打包

## 验证方式

<!-- 说明你怎么验证改动有效，贴出关键命令与结果 -->

```
npm run test:all
```

## 检查清单

- [ ] `npm run test:all` 全绿（类型检查 + 全部单测）
- [ ] 新增/修改的功能已补充对应测试用例
- [ ] 修改 `src/shared/risk.ts` 时已补充 `scripts/test-risk.ts` 用例
- [ ] 修改终端挂载逻辑时已更新 `scripts/test-dom-events.ts` 约定断言
- [ ] 无真实主机 IP / 主机 ID / 凭据 / 个人路径等敏感信息混入
- [ ] 提交信息遵循 Conventional Commits 规范
- [ ] 已阅读并遵循 CONTRIBUTING.md

## 安全影响

<!--
涉及凭据处理、命令执行、权限校验的改动必填。
说明攻击面变化、绕过风险分析；无安全影响可填「无」。
-->

无

## 关联 Issue

<!-- Closes #123 -->

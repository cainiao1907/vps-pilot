# CI 工作流待启用

`.github/workflows/ci.yml` 已写好，但当前 GitHub token 缺少 `workflow` 权限范围，
无法通过命令行推送（GitHub 限制：OAuth App 未经 `workflow` scope 授权的 token
不能创建/更新 `.github/workflows/` 下的文件）。

## 启用方式（二选一，30 秒完成）

### 方式 A：网页直接上传（最简单）

1. 打开 https://github.com/cainiao1907/vps-pilot/upload/main/.github/workflows
   （若目录不存在，先访问 https://github.com/cainiao1907/vps-pilot/new/main 手动建 `.github/workflows/ci.yml`）
2. 把本地 `.github/workflows/ci.yml` 的内容粘贴进去
3. 提交即可

### 方式 B：补授权限后用命令行推送

```bash
gh auth refresh -h github.com -s workflow
cd "D:/wokeboddy-ai/vps pilot"
git add .github/workflows/ci.yml
git commit -m "ci: 添加跨平台测试工作流"
git push origin main
```

授权时会打开浏览器让你确认，之后 git push 即可正常上传。

## 工作流内容

跨平台（ubuntu + windows）跑：`typecheck` + `test:risk` + `test:proxy` +
`test:registry` + `test:events` + `test:ui` + `test:mcp`，在 PR 和 push 到 main 时触发。

> 启用后 README 顶部的 CI 徽章会从「灰/无状态」变为实时通过状态。
> 在启用前，徽章会显示为 no status，属正常现象。

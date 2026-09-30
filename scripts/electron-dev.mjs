/**
 * 开发模式启动脚本
 *
 * 1. 启动 Vite dev server（带 HMR）
 * 2. 等主进程/preload 编译完成
 * 3. 启动 Electron，注入 VITE_DEV_SERVER_URL
 * 4. Electron 退出时关闭 dev server
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function banner(msg) {
  console.log(`\n\x1b[36m[dev]\x1b[0m ${msg}`);
}

async function main() {
  // ---------- 1. Vite dev server ----------
  banner('启动 Vite dev server…');
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
  await server.listen();
  const port = server.config.server.port ?? 5178;
  const url = `http://localhost:${port}`;
  server.printUrls();

  // ---------- 2. 等待主进程 / preload 产物就绪 ----------
  // vite-plugin-electron 会在 dev server 启动时异步编译这两个入口，
  // 必须等产物出现后再拉起 Electron，否则会加载到空文件。
  const mainEntry = path.join(root, 'dist-electron', 'main', 'index.js');
  const preloadEntry = path.join(root, 'dist-electron', 'preload', 'index.js');
  banner('等待主进程与 preload 编译产物…');
  const deadline = Date.now() + 30000;
  let waited = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(mainEntry) && fs.existsSync(preloadEntry)) break;
    // 每 3 秒报一次进度：卡住时用户能看出是在等编译，而不是死掉了
    if (waited % 3000 < 200) {
      process.stdout.write(
        `\r\x1b[36m[dev]\x1b[0m 等待编译产物… ${Math.round((Date.now() - (deadline - 30000)) / 1000)}s  `
      );
    }
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
  }
  process.stdout.write('\r\x1b[K');
  if (!fs.existsSync(mainEntry) || !fs.existsSync(preloadEntry)) {
    console.error('[dev] 编译产物未生成（等待超过 30 秒）。');
    console.error('      缺失的文件：');
    if (!fs.existsSync(mainEntry)) console.error('        - ' + mainEntry);
    if (!fs.existsSync(preloadEntry)) console.error('        - ' + preloadEntry);
    console.error('      通常说明 vite.config.ts 里的 electron 插件编译失败，');
    console.error('      请查看上方 Vite 输出的报错。');
    await server.close();
    process.exit(1);
  }
  banner('编译完成，启动 Electron…');

  // ---------- 3. 启动 Electron ----------
  // 某些宿主环境（CI / 沙箱 / 容器）会注入 ELECTRON_RUN_AS_NODE=1，
  // 这会让 electron.exe 退化为纯 Node 运行时，require('electron') 会拿到 undefined，
  // 表现为 "Cannot read properties of undefined (reading 'requestSingleInstanceLock')"。
  // 必须彻底移除该变量。
  const env = { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' };
  delete env.ELECTRON_RUN_AS_NODE;

  const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
  const child = spawn(process.execPath, [electronCli, '.'], {
    cwd: root,
    stdio: 'inherit',
    env,
  });

  child.on('close', async (code) => {
    banner('Electron 已退出，关闭 dev server');
    await server.close();
    process.exit(code ?? 0);
  });

  // 让 Ctrl+C 能正常收尾
  const shutdown = () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

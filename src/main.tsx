import React from 'react';
import ReactDOM from 'react-dom/client';
// 必须最先 import：在浏览器里直接打开 dev server 时没有 preload，
// 这里会补一份 mock API（Electron 正式运行时不会命中，见 mock.ts 顶部说明）
import './lib/mock';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/global.css';

/**
 * 渲染入口
 *
 * 整个应用外面套一层错误边界：
 * 没有它时，任何一处渲染异常都会让 React 卸载整棵树，窗口直接变空白 —— 用户
 * 完全看不到发生了什么。有了它，最坏情况也只是一块区域显示错误卡片。
 *
 * 注意：错误边界捕获不到异步回调 / 事件处理里的异常，那些由各组件自行 try/catch。
 */

const root = document.getElementById('root');

if (!root) {
  // 连挂载点都没有说明 index.html 有问题，直接写到 body 上，至少别是白屏
  document.body.innerHTML =
    '<pre style="color:#f85149;padding:24px;font-family:monospace">' +
    '启动失败：找不到 #root 挂载点。请检查 dist/index.html 是否完整。' +
    '</pre>';
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary label="应用主界面">
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

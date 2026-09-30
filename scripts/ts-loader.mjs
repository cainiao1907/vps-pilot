/**
 * Node ESM 解析钩子
 *
 * 项目源码用的是 Vite 风格的无扩展名 import（`./db`、`./proxy`），
 * 但 Node 原生 ESM 要求写全 `.ts` 扩展名。这个 loader 在解析失败时
 * 自动补 `.ts` 再试一次，让 --experimental-strip-types 能直接跑源码。
 *
 * 用法：node --experimental-strip-types --import ./scripts/ts-loader.mjs <script>
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./ts-resolve-hook.mjs', pathToFileURL(import.meta.filename));

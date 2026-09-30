export type { VpsApi } from '../../electron/preload/index';
import type { VpsApi } from '../../electron/preload/index';

declare global {
  interface Window {
    vps: VpsApi;
  }
}

/** 统一解包 IpcResult，失败抛异常 */
export async function call<T>(p: Promise<any>): Promise<T> {
  const r = await p;
  if (r && typeof r === 'object' && 'ok' in r) {
    if (!r.ok) throw new Error(r.error ?? '未知错误');
    return r.data as T;
  }
  return r as T;
}

/** 统一解包，失败返回 null 并打日志 */
export async function tryCall<T>(p: Promise<any>): Promise<T | null> {
  try {
    return await call<T>(p);
  } catch (e) {
    console.error(e);
    return null;
  }
}

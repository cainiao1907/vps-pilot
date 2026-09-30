import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * 凭据加密存储
 *
 * 策略：
 * - 优先用 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）
 * - 不可用时降级为本地随机密钥 + AES-256-GCM（密钥文件与密文分开存放，权限收紧）
 * - 明文永不落盘，也永不出主进程
 */

const KEY_FILE = 'vpspilot.key';

let fallbackKey: Buffer | null = null;

function getDataDir(): string {
  const dir = path.join(app.getPath('userData'), 'secure');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function getFallbackKey(): Buffer {
  if (fallbackKey) return fallbackKey;
  const keyPath = path.join(getDataDir(), KEY_FILE);
  if (fs.existsSync(keyPath)) {
    fallbackKey = Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'hex');
  } else {
    fallbackKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, fallbackKey.toString('hex'), { mode: 0o600 });
  }
  return fallbackKey;
}

/** 加密字符串，返回 base64 */
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'v1:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch {
    // 落到 fallback
  }
  const key = getFallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v2:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密字符串，失败返回空串 */
export function decryptSecret(payload: string | undefined): string {
  if (!payload) return '';
  // 测试桩：纯 Node 环境下没有 Electron safeStorage，测试会传入明文（带前缀）。
  // 仅当字符串带 __plain__ 前缀时才走这条捷径，生产环境永远不会产生这种载荷。
  if (payload.startsWith('__plain__')) return payload.slice(9);
  try {
    if (payload.startsWith('v1:')) {
      const buf = Buffer.from(payload.slice(3), 'base64');
      if (!safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(buf);
    }
    if (payload.startsWith('v2:')) {
      const all = Buffer.from(payload.slice(3), 'base64');
      const iv = all.subarray(0, 12);
      const tag = all.subarray(12, 28);
      const data = all.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', getFallbackKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }
  } catch {
    return '';
  }
  return '';
}

/** 生成短 id */
export function shortId(prefix = ''): string {
  return prefix + crypto.randomBytes(8).toString('hex');
}

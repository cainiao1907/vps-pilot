import type { ModelConfig } from '@shared/types';
import { decryptSecret } from './secure-store';

/**
 * BYOK LLM 客户端 —— 统一走 OpenAI 兼容的 /chat/completions 接口
 * 支持流式输出
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 是否要求返回 JSON */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

/** 规范化 baseUrl，拼出 chat completions 端点 */
function endpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (b.endsWith('/chat/completions')) return b;
  return `${b}/chat/completions`;
}

/** 非流式调用 */
export async function chat(
  mc: ModelConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<string> {
  const apiKey = decryptSecret(mc.encryptedApiKey);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  // Anthropic 原生网关使用 x-api-key
  if (mc.providerId === 'anthropic' && apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  const body: Record<string, unknown> = {
    model: mc.model,
    messages,
    temperature: opts.temperature ?? mc.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? mc.maxTokens ?? 4096,
    stream: false,
  };
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(endpoint(mc.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型请求失败 (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  const data: any = await res.json();
  const content =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.content?.[0]?.text ??
    '';
  if (!content) {
    throw new Error('模型返回内容为空: ' + JSON.stringify(data).slice(0, 300));
  }
  return content;
}

/** 流式调用，逐块回调 */
export async function chatStream(
  mc: ModelConfig,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  opts: ChatOptions = {}
): Promise<string> {
  const apiKey = decryptSecret(mc.encryptedApiKey);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (mc.providerId === 'anthropic' && apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  const body: Record<string, unknown> = {
    model: mc.model,
    messages,
    temperature: opts.temperature ?? mc.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? mc.maxTokens ?? 4096,
    stream: true,
  };

  const res = await fetch(endpoint(mc.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型请求失败 (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error('模型响应没有 body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta =
          json?.choices?.[0]?.delta?.content ??
          json?.choices?.[0]?.delta?.reasoning_content ??
          json?.delta?.text ??
          '';
        if (delta) {
          full += delta;
          onChunk(delta);
        }
      } catch {
        // 忽略无法解析的分片
      }
    }
  }

  return full;
}

/** 测试连通性 */
export async function testModel(mc: ModelConfig): Promise<{ ok: boolean; error?: string; reply?: string }> {
  try {
    const reply = await chat(
      mc,
      [
        { role: 'system', content: '你是一个测试助手，只回复"OK"两个字。' },
        { role: 'user', content: 'ping' },
      ],
      { maxTokens: 32, temperature: 0 }
    );
    return { ok: true, reply: reply.slice(0, 100) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

import type { Env } from './env';

// settings 只读读取 + 30 秒 isolate 缓存（§4.1）
const cache = new Map<string, { value: unknown; exp: number }>();

export async function getSetting<T>(env: Env, key: string, fallback: T): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value as T;
  const row = await env.DB.prepare('SELECT value_json FROM settings WHERE key = ?1')
    .bind(key)
    .first<{ value_json: string }>();
  let value: unknown = fallback;
  if (row) {
    try {
      value = JSON.parse(row.value_json);
    } catch {
      // 解析失败保持 fallback
    }
  }
  cache.set(key, { value, exp: Date.now() + 30_000 });
  return value as T;
}

export async function getFlags(env: Env): Promise<{ cardhub: boolean; turnstile: boolean }> {
  const [cardhub, turnstile] = await Promise.all([
    getSetting<boolean>(env, 'module_cardhub_enabled', false),
    getSetting<boolean>(env, 'turnstile_enforced', true),
  ]);
  return { cardhub, turnstile };
}

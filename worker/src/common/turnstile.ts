import type { Env } from './env';
import { getFlags } from './settings';

// Turnstile 人机校验（§15）：未配置 secret 时跳过，不阻塞
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const flags = await getFlags(env);
  if (!flags.turnstile) return true; // 站长已关闭人机校验
  if (!env.TURNSTILE_SECRET) return true; // 未配置，跳过（开发期）
  if (!token) return false;

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  if (remoteIp) body.set('remoteip', remoteIp);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = (await res.json().catch(() => ({ success: false }))) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

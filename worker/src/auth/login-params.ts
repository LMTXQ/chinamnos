import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { hmacSha256Hex, randomBase64 } from '../common/crypto';
import { verifyTurnstile } from '../common/turnstile';
import { getEmailWhitelist, emailDomainAllowed } from './email-policy';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_ITER = 600000; // §15.2：≥60万迭代

// POST /api/auth/login-params：取登录盐（未注册返回 HMAC 假盐防枚举，§6.2）
export async function handleLoginParams(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  if (!EMAIL_RE.test(email)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'email' });
  // 邮箱域名白名单（前后台双重校验的后台侧；登录/注册统一拦截）
  if (!emailDomainAllowed(await getEmailWhitelist(env), email)) {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_DOMAIN_NOT_ALLOWED', 400, { field: 'email' });
  }
  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  const user = await env.DB.prepare('SELECT k_salt, k_iter FROM users WHERE email = ?1')
    .bind(email).first<{ k_salt: string; k_iter: number }>();

  if (user) {
    return ok({ salt: user.k_salt, iter: user.k_iter });
  }

  // 未注册：返回基于邮箱+HMAC 主密钥派生的假盐，格式与真盐一致，无法区分
  const fakeSalt = (await hmacSha256Hex(env.CARDHUB_SECRET || 'fallback', email)).slice(0, 24);
  return ok({ salt: btoa(fakeSalt), iter: DEFAULT_ITER });
}

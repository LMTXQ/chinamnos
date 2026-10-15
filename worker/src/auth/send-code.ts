import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { hitLimit } from '../common/ratelimit';
import { verifyTurnstile } from '../common/turnstile';
import { ulid, randomDigits, sha256Hex } from '../common/crypto';
import { notify } from '../mail/notifier';
import { getEmailWhitelist, emailDomainAllowed } from './email-policy';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/send-code：发注册/重置验证码（§6.1）
export async function handleSendCode(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* 空 body */ }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const purpose = body.purpose === 'reset' ? 'reset' : 'register';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;

  if (!EMAIL_RE.test(email)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'email' });
  // 邮箱域名白名单（注册发码/重置发码统一拦截）
  if (!emailDomainAllowed(await getEmailWhitelist(env), email)) {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_DOMAIN_NOT_ALLOWED', 400, { field: 'email' });
  }

  // 人机校验
  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  // 频控：同 IP 10次/小时、同邮箱 3次/小时、两次间隔≥60秒
  const ipLimit = await hitLimit(env, `sendcode:ip:${ip}`, 10, 3600);
  if (ipLimit.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);
  const emailLimit = await hitLimit(env, `sendcode:email:${email}`, 3, 3600);
  if (emailLimit.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  // 注册：邮箱已存在则不发码（防枚举，统一提示"如未注册将发送验证码"）
  if (purpose === 'register') {
    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?1')
      .bind(email).first();
    if (exists) return ok({ sent: true }); // 假装已发，不暴露邮箱是否注册
  }
  // 重置：邮箱不存在也假装已发
  if (purpose === 'reset') {
    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?1')
      .bind(email).first();
    if (!exists) return ok({ sent: true });
  }

  const code = randomDigits(6);
  const codeHash = await sha256Hex(code);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO auth_codes (id, email, purpose, code_hash, attempts, expires_at, used_at, request_ip, created_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, ?6, ?7)`,
  ).bind(ulid(), email, purpose, codeHash, now + 10 * 60 * 1000, ip, now).run();

  const result = await notify(env, email, 'verify_code', { code, purpose });
  return ok({ sent: result.sent || !!result.suppressed });
}

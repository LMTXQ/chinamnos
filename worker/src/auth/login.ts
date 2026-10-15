import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { hitLimit } from '../common/ratelimit';
import { verifyTurnstile } from '../common/turnstile';
import { ulid, sha256Hex, randomBase64 } from '../common/crypto';
import { getEmailWhitelist, emailDomainAllowed } from './email-policy';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_DAYS = 30;

// POST /api/auth/login：邮箱 + 前端派生 K 登录（§6.2）
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const k = typeof body.k === 'string' ? body.k : '';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;

  if (!EMAIL_RE.test(email) || !k) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  // 邮箱域名白名单兜底（login-params 已拦，此处双保险）
  if (!emailDomainAllowed(await getEmailWhitelist(env), email)) {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_DOMAIN_NOT_ALLOWED', 400, { field: 'email' });
  }
  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  // 登录失败频控：同邮箱 5 次/15 分钟锁定
  const lock = await hitLimit(env, `login:fail:${email}`, 5, 900);
  if (lock.limited) return fail(ERR.RATE_LIMITED, 'LOGIN_LOCKED', 429);

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, role, status FROM users WHERE email = ?1',
  ).bind(email).first<{ id: string; email: string; password_hash: string; role: string; status: string }>();

  // 站长决策（2026-09-29）：放弃此处防枚举，拆开错误码换取清晰 UX——
  // 未注册与密码错分别返回，前端据此精确分流（未注册→引导验证码注册；密码错→中性提示重试）。
  // 邮箱注册状态由此可被枚举属已知且接受的权衡（register 的 EMAIL_EXISTS 本就泄露）。
  const inputHash = await sha256Hex(k);
  if (!user) {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_NOT_FOUND', 400);
  }
  if (inputHash !== user.password_hash) {
    return fail(ERR.VALIDATION_ERROR, 'INVALID_PASSWORD', 400);
  }

  if (user.status === 'banned') return fail(ERR.BANNED, 'BANNED', 403);

  // 登录成功：更新 last_login_at + 签发会话
  const now = Date.now();
  await env.DB.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2').bind(now, user.id).run();

  const token = randomBase64(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, ua, request_ip, expires_at, revoked_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
  ).bind(ulid(), user.id, tokenHash, request.headers.get('User-Agent') || '', ip, now + SESSION_DAYS * 86400 * 1000, now).run();

  return ok({ token, user: { email: user.email, role: user.role } });
}

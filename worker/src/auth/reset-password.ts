import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { verifyTurnstile } from '../common/turnstile';
import { sha256Hex } from '../common/crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/reset-password：邮箱验证码 + 新 K → 重置密码 + 吊销全部旧会话（§6.2）
export async function handleResetPassword(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const k = typeof body.k === 'string' ? body.k : '';
  const salt = typeof body.salt === 'string' ? body.salt : '';
  const iter = Number(body.iter);
  const code = typeof body.code === 'string' ? body.code : '';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;

  if (!EMAIL_RE.test(email) || !k || !/^\d{6}$/.test(code)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  // 查用户
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first<{ id: string }>();
  if (!user) return fail(ERR.VALIDATION_ERROR, 'INVALID_CODE', 400, { field: 'code' }); // 不暴露邮箱是否存在

  // 校验验证码
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, expires_at, used_at FROM auth_codes
     WHERE email = ?1 AND purpose = 'reset' AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(email).first<{ id: string; code_hash: string; attempts: number; expires_at: number; used_at: number | null }>();

  if (!row || row.expires_at < Date.now()) return fail(ERR.VALIDATION_ERROR, 'INVALID_CODE', 400, { field: 'code' });
  if (row.attempts >= 5) return fail(ERR.VALIDATION_ERROR, 'CODE_LOCKED', 400, { field: 'code' });

  const codeHash = await sha256Hex(code);
  if (codeHash !== row.code_hash) {
    await env.DB.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run();
    return fail(ERR.VALIDATION_ERROR, 'INVALID_CODE', 400, { field: 'code' });
  }

  await env.DB.prepare('UPDATE auth_codes SET used_at = ?1 WHERE id = ?2').bind(Date.now(), row.id).run();

  // 更新密码 + 盐/迭代参数（用户可能在新设备上重新派生）
  const passwordHash = await sha256Hex(k);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?1, k_salt = ?2, k_iter = ?3, updated_at = ?4 WHERE id = ?5`,
  ).bind(passwordHash, salt, iter, now, user.id).run();

  // 吊销该用户全部已有会话
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL`,
  ).bind(now, user.id).run();

  return ok({ reset: true });
}

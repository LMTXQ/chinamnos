import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { hitLimit } from '../common/ratelimit';
import { verifyTurnstile } from '../common/turnstile';
import { ulid, sha256Hex, randomBase64 } from '../common/crypto';
import { notify } from '../mail/notifier';
import { getEmailWhitelist, emailDomainAllowed } from './email-policy';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ITER_MIN = 100000;
const ITER_MAX = 10000000;
const SESSION_DAYS = 30;

// POST /api/auth/register：注册+验码+签发会话（§6.1）
export async function handleRegister(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const k = typeof body.k === 'string' ? body.k : ''; // 前端派生密钥（base64）
  const salt = typeof body.salt === 'string' ? body.salt : ''; // 16B base64
  const iter = Number(body.iter);
  const code = typeof body.code === 'string' ? body.code : '';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;

  if (!EMAIL_RE.test(email)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'email' });
  // 邮箱域名白名单兜底（send-code 已拦，此处双保险）
  if (!emailDomainAllowed(await getEmailWhitelist(env), email)) {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_DOMAIN_NOT_ALLOWED', 400, { field: 'email' });
  }
  if (!/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(k)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'k' });
  if (!/^[A-Za-z0-9+/]{22,24}={0,2}$/.test(salt)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'salt' });
  if (!Number.isFinite(iter) || iter < ITER_MIN || iter > ITER_MAX) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'iter' });
  if (!/^\d{6}$/.test(code)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'code' });

  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  // 邮箱已注册
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?1').bind(email).first();
  if (exists) return fail(ERR.VALIDATION_ERROR, 'EMAIL_EXISTS', 400, { field: 'email' });

  // 校验验证码：取该邮箱+purpose 最新未用未过期的 code
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, expires_at, used_at FROM auth_codes
     WHERE email = ?1 AND purpose = 'register' AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(email).first<{ id: string; code_hash: string; attempts: number; expires_at: number; used_at: number | null }>();

  if (!row || row.expires_at < Date.now()) return fail(ERR.VALIDATION_ERROR, 'CODE_INVALID', 400, { field: 'code' });
  if (row.attempts >= 5) return fail(ERR.VALIDATION_ERROR, 'CODE_LOCKED', 400, { field: 'code' });

  const codeHash = await sha256Hex(code);
  if (codeHash !== row.code_hash) {
    await env.DB.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run();
    return fail(ERR.VALIDATION_ERROR, 'CODE_INVALID', 400, { field: 'code' });
  }

  // 验证码正确：标记已用
  await env.DB.prepare('UPDATE auth_codes SET used_at = ?1 WHERE id = ?2').bind(Date.now(), row.id).run();

  // 建用户
  const now = Date.now();
  const userId = ulid();
  const passwordHash = await sha256Hex(k); // 服务端只存 SHA-256(K)，§15.2
  const isOwner = email === (env.OWNER_EMAIL || '').toLowerCase();
  const role = isOwner ? 'owner' : 'user';

  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, k_salt, k_iter, email_verified, role, status, last_login_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 'active', ?7, ?8, ?9)`,
  ).bind(userId, email, passwordHash, salt, iter, role, now, now, now).run();

  // 签发会话
  const token = randomBase64(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, ua, request_ip, expires_at, revoked_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
  ).bind(ulid(), userId, tokenHash, request.headers.get('User-Agent') || '', ip, now + SESSION_DAYS * 86400 * 1000, now).run();

  return ok({ token, user: { email, role } });
}

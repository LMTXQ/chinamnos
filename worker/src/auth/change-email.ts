import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { hitLimit } from '../common/ratelimit';
import { ulid, randomDigits, sha256Hex } from '../common/crypto';
import { audit } from '../common/audit';
import { notify } from '../mail/notifier';
import { getEmailWhitelist, emailDomainAllowed } from './email-policy';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const K_RE = /^[A-Za-z0-9+/]{42,44}={0,2}$/;

/* ── 修改登录邮箱（2026-10-23 站长决策）──
   流程：① request：当前密码（前端 PBKDF2 派生 K）+ 新邮箱校验 → 发验证码到新邮箱（purpose='change_email'）
        ② confirm：再验当前密码 + 验证码 → 原子更新 users.email → 自动解绑「邮件」通知渠道
          （渠道凭证为旧邮箱快照，站长决策：自动解绑、提示重新绑定）→ 审计 + 旧邮箱变更提醒。
   风险控制：登录态 + 当前密码（防会话劫持改邮箱后走找回密码接管账号）+ 新邮箱所有权验证码 +
   旧邮箱告警（本人可感知）+ 频控（每用户 3 次/天、目标邮箱复用全站发码桶 3 次/时）。
   关联数据说明：老链路邮件/cron 通知均实时读 users.email 自动跟随；conversations.buyer_email、
   audit_logs.actor_email 为设计内冗余快照，保留旧值可追溯，不回改。 */

interface UserRow { id: string; email: string; password_hash: string; status: string; }

// 验证当前密码（前端传派生 K，服务端比对 SHA-256(K)，与登录同构）；失败计入登录失败锁（5 次锁 15 分钟）
async function verifyCurrentPassword(env: Env, userId: string, k: string): Promise<
  { ok: true; user: UserRow } | { ok: false; resp: Response }
> {
  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, status FROM users WHERE id = ?1',
  ).bind(userId).first<UserRow>();
  if (!user) return { ok: false, resp: fail(ERR.NOT_FOUND, 'NOT_FOUND', 404) };
  if (user.status === 'banned') return { ok: false, resp: fail(ERR.BANNED, 'BANNED', 403) };
  if ((await sha256Hex(k)) !== user.password_hash) {
    await hitLimit(env, `login:fail:${user.email}`, 5, 900);
    return { ok: false, resp: fail(ERR.VALIDATION_ERROR, 'INVALID_PASSWORD', 400) };
  }
  return { ok: true, user };
}

// GET /api/me/kdf-params：本人密码派生参数（盐/迭代数；仅本人可取，前端本地派生 K 用，登录页场景不可用——login-params 强制 Turnstile）
export async function handleKdfParams(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const row = await env.DB.prepare('SELECT k_salt, k_iter FROM users WHERE id = ?1')
    .bind(g.viewer.id).first<{ k_salt: string; k_iter: number }>();
  if (!row) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  return ok({ salt: row.k_salt, iter: row.k_iter });
}

// POST /api/me/change-email/request  body: { k, new_email }
export async function handleChangeEmailRequest(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const k = typeof body.k === 'string' ? body.k : '';
  const newEmail = typeof body.new_email === 'string' ? body.new_email.trim().toLowerCase() : '';
  if (!K_RE.test(k)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'k' });
  if (!EMAIL_RE.test(newEmail)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'new_email' });

  // 频控：验证码真实外发——每用户 3 次/天；目标邮箱复用全站发码桶 3 次/时（防被用于骚扰任意邮箱）
  const rl = await hitLimit(env, `emailchg:req:${g.viewer.id}`, 3, 86400);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);
  const emailRl = await hitLimit(env, `sendcode:email:${newEmail}`, 3, 3600);
  if (emailRl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  const v = await verifyCurrentPassword(env, g.viewer.id, k);
  if (!v.ok) return v.resp;
  if (newEmail === v.user.email.toLowerCase()) {
    return fail(ERR.VALIDATION_ERROR, 'SAME_EMAIL', 400, { field: 'new_email' });
  }
  if (!emailDomainAllowed(await getEmailWhitelist(env), newEmail)) {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_DOMAIN_NOT_ALLOWED', 400, { field: 'new_email' });
  }
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?1').bind(newEmail).first();
  if (exists) return fail(ERR.VALIDATION_ERROR, 'EMAIL_EXISTS', 400, { field: 'new_email' });

  const code = randomDigits(6);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO auth_codes (id, email, purpose, code_hash, attempts, expires_at, used_at, request_ip, created_at)
     VALUES (?1, ?2, 'change_email', ?3, 0, ?4, NULL, ?5, ?6)`,
  ).bind(ulid(), newEmail, await sha256Hex(code), now + 10 * 60 * 1000,
    request.headers.get('CF-Connecting-IP') ?? 'unknown', now).run();

  const result = await notify(env, newEmail, 'verify_code', { code, purpose: 'change_email' });
  return ok({ sent: result.sent || !!result.suppressed });
}

// POST /api/me/change-email/confirm  body: { k, new_email, code }
export async function handleChangeEmailConfirm(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const k = typeof body.k === 'string' ? body.k : '';
  const newEmail = typeof body.new_email === 'string' ? body.new_email.trim().toLowerCase() : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!K_RE.test(k)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'k' });
  if (!EMAIL_RE.test(newEmail)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'new_email' });
  if (!/^\d{6}$/.test(code)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'code' });

  const v = await verifyCurrentPassword(env, g.viewer.id, k);
  if (!v.ok) return v.resp;
  const user = v.user;
  if (newEmail === user.email.toLowerCase()) {
    return fail(ERR.VALIDATION_ERROR, 'SAME_EMAIL', 400, { field: 'new_email' });
  }

  // 校验验证码（镜像 register 模式：最新未用未过期一条，5 次尝试上限）
  const row = await env.DB.prepare(
    `SELECT id, code_hash, attempts, expires_at, used_at FROM auth_codes
     WHERE email = ?1 AND purpose = 'change_email' AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(newEmail).first<{ id: string; code_hash: string; attempts: number; expires_at: number; used_at: number | null }>();
  if (!row || row.expires_at < Date.now()) return fail(ERR.VALIDATION_ERROR, 'CODE_INVALID', 400, { field: 'code' });
  if (row.attempts >= 5) return fail(ERR.VALIDATION_ERROR, 'CODE_LOCKED', 400, { field: 'code' });
  if ((await sha256Hex(code)) !== row.code_hash) {
    await env.DB.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run();
    return fail(ERR.VALIDATION_ERROR, 'CODE_INVALID', 400, { field: 'code' });
  }

  // 新邮箱占用复查（request 与 confirm 之间可能被抢注）
  const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?1').bind(newEmail).first();
  if (exists) return fail(ERR.VALIDATION_ERROR, 'EMAIL_EXISTS', 400, { field: 'new_email' });

  // 原子更新（WHERE email=旧值乐观锁；UNIQUE 并发冲突映射为明确错误码）
  const now = Date.now();
  try {
    const r = await env.DB.prepare(
      'UPDATE users SET email = ?1, updated_at = ?2 WHERE id = ?3 AND email = ?4',
    ).bind(newEmail, now, user.id, user.email).run();
    if (!r.meta.changes) return fail(ERR.VALIDATION_ERROR, 'EMAIL_EXISTS', 400, { field: 'new_email' });
  } catch {
    return fail(ERR.VALIDATION_ERROR, 'EMAIL_EXISTS', 400, { field: 'new_email' });
  }
  await env.DB.prepare('UPDATE auth_codes SET used_at = ?1 WHERE id = ?2').bind(now, row.id).run();

  // 自动解绑「邮件」通知渠道（站长决策：凭证为旧邮箱快照，解绑后由用户重新一键绑定）
  let channelUnbound = false;
  try {
    const del = await env.DB.prepare(
      `DELETE FROM user_notify_channels WHERE user_id = ?1 AND channel_type = 'email'`,
    ).bind(user.id).run();
    channelUnbound = (del.meta.changes ?? 0) > 0;
  } catch { /* 解绑失败不影响邮箱变更（用户可手动解绑） */ }

  await audit(env, request, g.viewer, {
    action: 'change_email', targetType: 'user', targetId: user.id,
    detail: { from: user.email, to: newEmail },
  });

  // 旧邮箱变更提醒（防盗号感知；尽力而为，失败不影响变更结果）
  try {
    await notify(env, user.email, 'email_changed', { old_email: user.email, new_email: newEmail });
  } catch { /* */ }

  return ok({ changed: true, email: newEmail, channel_unbound: channelUnbound });
}

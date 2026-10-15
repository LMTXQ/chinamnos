import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { isStaff } from './profile';

const NICK_RE = /^[\p{L}\p{N}_-]+$/u; // 中英文/数字/下划线/连字符，无空格
const NICK_MIN = 2;
const NICK_MAX_USER = 5;   // 普通用户昵称 ≤5 个字
const NICK_MAX_STAFF = 20; // admin/owner 豁免 5 字限制（上限 20）

// POST /api/auth/nickname：登录用户设置/修改昵称（对外展示名，避免暴露邮箱）
export async function handleNickname(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
  const max = isStaff(g.viewer.role) ? NICK_MAX_STAFF : NICK_MAX_USER;
  if (nickname.length < NICK_MIN || nickname.length > max || !NICK_RE.test(nickname)) {
    return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'nickname' });
  }

  await env.DB.prepare('UPDATE users SET nickname = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(nickname, Date.now(), g.viewer.id).run();

  return ok({ nickname });
}

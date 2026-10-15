import type { Env } from './env';
import { ERR, fail } from './envelope';
import { sha256Hex } from './crypto';

export interface Viewer {
  id: string;
  email: string;
  nickname?: string;
  role: 'anon' | 'user' | 'admin' | 'owner';
  status: 'active' | 'banned';
}

const ANON: Viewer = { id: '', email: '', role: 'anon', status: 'active' };

const RANK: Record<string, number> = { anon: 0, user: 1, admin: 2, owner: 3 };

export function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

// 鉴权链（§7.1）：取令牌 → 查 session → 实时查 users.role/status → 角色校验
// requireRole: 'anon' 表示允许访客（但有令牌仍会校验有效性）
export async function guard(
  req: Request,
  env: Env,
  requireRole: Viewer['role'] = 'anon',
): Promise<{ viewer: Viewer; tokenHash?: string } | Response> {
  const token = bearer(req);
  if (!token) {
    if (requireRole === 'anon') return { viewer: ANON };
    return fail(ERR.UNAUTHORIZED, 'UNAUTHORIZED', 401);
  }

  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    'SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?1',
  )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number; revoked_at: number | null }>();

  if (!session || session.revoked_at || session.expires_at < Date.now()) {
    return fail(ERR.UNAUTHORIZED, 'UNAUTHORIZED', 401);
  }

  const user = await env.DB.prepare(
    'SELECT id, email, nickname, role, status FROM users WHERE id = ?1',
  )
    .bind(session.user_id)
    .first<{ id: string; email: string; nickname: string | null; role: string; status: string }>();

  if (!user || user.status === 'banned') {
    return fail(ERR.BANNED, 'BANNED', 403);
  }

  const viewer: Viewer = {
    id: user.id,
    email: user.email,
    nickname: user.nickname || undefined,
    role: user.role as Viewer['role'],
    status: user.status as Viewer['status'],
  };

  if (RANK[viewer.role] < RANK[requireRole]) {
    return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);
  }

  return { viewer, tokenHash };
}

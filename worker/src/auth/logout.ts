import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';

// POST /api/auth/logout：吊销当前会话（body.all=true 则吊销全部）
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const now = Date.now();
  if (body.all === true) {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL')
      .bind(now, g.viewer.id).run();
  } else if (g.tokenHash) {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE token_hash = ?2')
      .bind(now, g.tokenHash).run();
  }
  return ok({ loggedOut: true });
}

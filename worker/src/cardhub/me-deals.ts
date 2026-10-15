import type { Env } from '../common/env';
import { ok } from '../common/envelope';
import { guard } from '../common/auth';
import { serializePost, type PostRow } from './projection';

// GET /api/cardhub/me/deals：交易记录（closed 90 天内）
export async function handleMyDeals(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const since = Date.now() - 90 * 86400 * 1000;
  const rows = await env.DB.prepare(
    `SELECT * FROM posts WHERE user_id = ?1 AND status = 'closed' AND closed_at >= ?2 ORDER BY closed_at DESC LIMIT 100`,
  ).bind(g.viewer.id, since).all<PostRow>();

  const items = rows.results
    .map((r) => serializePost(r, g.viewer, 'self'))
    .filter((x): x is Record<string, unknown> => x !== null);

  return ok({ items });
}

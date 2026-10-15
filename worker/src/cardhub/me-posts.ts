import type { Env } from '../common/env';
import { ok } from '../common/envelope';
import { guard } from '../common/auth';
import { serializePost, type PostRow } from './projection';

// GET /api/cardhub/me/posts：我的发布（全状态分桶）
export async function handleMyPosts(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT * FROM posts WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100`,
  ).bind(g.viewer.id).all<PostRow>();

  const items = rows.results
    .map((r) => serializePost(r, g.viewer, 'self'))
    .filter((x): x is Record<string, unknown> => x !== null);

  // 按状态分桶
  const buckets: Record<string, unknown[]> = { pending: [], open: [], rejected: [], closed: [], expired: [] };
  for (const item of items) {
    const s = item.status as string;
    if (buckets[s]) buckets[s].push(item);
  }
  return ok(buckets);
}

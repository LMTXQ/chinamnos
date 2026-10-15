import type { Env } from '../common/env';
import { fail, ok } from '../common/envelope';
import { guard } from '../common/auth';

// GET /api/admin/stats：管理面板统计
export async function handleStats(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const [users, posts, conv, relay, tickets] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status=\'banned\' THEN 1 ELSE 0 END) as banned FROM users').first<{ total: number; banned: number }>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) as expired
      FROM posts`).first<Record<string, number>>(),
    env.DB.prepare('SELECT COUNT(*) as total FROM conversations').first<{ total: number }>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status='handled' THEN 1 ELSE 0 END) as handled,
      SUM(CASE WHEN status='ignored' THEN 1 ELSE 0 END) as ignored
      FROM relay_requests`).first<Record<string, number>>(),
    env.DB.prepare(`SELECT
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status='replied' THEN 1 ELSE 0 END) as replied,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) as closed
      FROM tickets`).first<Record<string, number>>(),
  ]);

  return ok({
    users: { total: users?.total ?? 0, banned: users?.banned ?? 0 },
    posts: posts || {},
    conversations: { total: conv?.total ?? 0 },
    relayRequests: relay || {},
    tickets: tickets || {},
  });
}

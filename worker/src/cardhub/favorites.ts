import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { serializePost, type PostRow } from './projection';
import { getPublicProfiles } from '../auth/public-profile';

/* 帖子收藏：登录用户私有数据；帖 下架/成交后记录保留（列表按帖子现状态标记，见 handleMyFavorites） */

// POST /api/cardhub/posts/:id/favorite：切换收藏状态（幂等 toggle），返回最新状态
//   取消收藏任何时候都允许（帖下架/成交后仍可从收藏列表移除）；新增收藏要求帖为 open
export async function handleFavoriteToggle(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const existing = await env.DB.prepare(
    'SELECT 1 AS x FROM favorites WHERE user_id = ?1 AND post_id = ?2',
  ).bind(g.viewer.id, id).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM favorites WHERE user_id = ?1 AND post_id = ?2').bind(g.viewer.id, id).run();
    return ok({ favorited: false });
  }

  const post = await env.DB.prepare(
    'SELECT id, status FROM posts WHERE id = ?1',
  ).bind(id).first<{ id: string; status: string }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (post.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  await env.DB.prepare(
    'INSERT INTO favorites (user_id, post_id, created_at) VALUES (?1, ?2, ?3)',
  ).bind(g.viewer.id, id, Date.now()).run();
  return ok({ favorited: true });
}

// GET /api/cardhub/me/favorites：我的收藏（收藏时间倒序）
//   open 帖返回 public/list 完整投影（可直接进详情）；非 open 帖仅返回最小字段 + 状态（保留标记，不可进详情）
export async function handleMyFavorites(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT f.created_at AS favorited_at, p.*
     FROM favorites f JOIN posts p ON p.id = f.post_id
     WHERE f.user_id = ?1
     ORDER BY f.created_at DESC LIMIT 200`,
  ).bind(g.viewer.id).all<PostRow & { favorited_at: number }>();

  const openRows = rows.results.filter((r) => r.status === 'open');
  const uids = [...new Set(openRows.map((r) => r.user_id))];
  const authorMap = await getPublicProfiles(env, uids);

  const items = rows.results.map((r) => {
    if (r.status === 'open') {
      const item = serializePost(r, g.viewer, 'public/list');
      if (!item) return { id: r.id, post_no: r.post_no, title: r.title, board: r.board, status: r.status, favorited_at: r.favorited_at };
      const a = authorMap.get(r.user_id);
      item.author = { id: r.user_id, nickname: a?.nickname ?? null, title: a?.title ?? null, avatar_v: a?.avatar_v ?? null };
      item.favorited_at = r.favorited_at;
      return item;
    }
    // 非 open：仅最小字段（收藏者非发布者，无详情投影可给），前端标记状态、禁止进详情
    return {
      id: r.id, post_no: r.post_no, title: r.title, board: r.board,
      carrier: r.carrier, province: r.province, city: r.city,
      status: r.status, favorited_at: r.favorited_at,
    };
  });

  return ok({ items });
}

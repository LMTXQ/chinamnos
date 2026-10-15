import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { audit } from '../common/audit';

/* 精华置顶：管理组专属（后端 guard('admin') 强校验，前端仅对管理组渲染按钮）。
   posts.pinned_at = 置顶时间戳：NULL=未置顶；多帖置顶按 pinned_at DESC 排前（最后置顶的最前）。
   「置顶排序」= 刷新 pinned_at（重置为当前时间），实现不挪数据行的重排序 */

// POST /api/cardhub/posts/:id/pin：精华置顶（仅 open 帖）
export async function handlePinPost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const post = await env.DB.prepare(
    'SELECT id, title, status FROM posts WHERE id = ?1',
  ).bind(id).first<{ id: string; title: string; status: string }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (post.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  const now = Date.now();
  await env.DB.prepare('UPDATE posts SET pinned_at = ?1 WHERE id = ?2').bind(now, id).run();

  await audit(env, request, g.viewer, {
    action: 'pin_post',
    targetType: 'post',
    targetId: id,
    detail: { title: post.title },
  });
  return ok({ pinned_at: now });
}

// DELETE /api/cardhub/posts/:id/pin：取消置顶（幂等）
export async function handleUnpinPost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const r = await env.DB.prepare(
    'UPDATE posts SET pinned_at = NULL WHERE id = ?1',
  ).bind(id).run();
  if (!r.meta.changes) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  await audit(env, request, g.viewer, {
    action: 'unpin_post',
    targetType: 'post',
    targetId: id,
  });
  return ok({ pinned_at: null });
}

// POST /api/cardhub/posts/:id/pin/bump：置顶排序（刷新置顶时间 → 排到置顶区最前）
export async function handlePinBump(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'admin');
  if (g instanceof Response) return g;

  const post = await env.DB.prepare(
    'SELECT id, pinned_at FROM posts WHERE id = ?1',
  ).bind(id).first<{ id: string; pinned_at: number | null }>();
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (!post.pinned_at) return fail(ERR.VALIDATION_ERROR, 'NOT_PINNED', 400);

  const now = Date.now();
  await env.DB.prepare('UPDATE posts SET pinned_at = ?1 WHERE id = ?2').bind(now, id).run();

  await audit(env, request, g.viewer, {
    action: 'pin_bump',
    targetType: 'post',
    targetId: id,
  });
  return ok({ pinned_at: now });
}

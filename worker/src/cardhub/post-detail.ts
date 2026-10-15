import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { serializePost, type PostRow } from './projection';
import { readContacts } from '../auth/profile';
import { getPublicProfile } from '../auth/public-profile';
import { proofRows } from './proofs';

// GET /api/cardhub/posts/:id：公开详情（public/detail 投影，非 open 404）
export async function handlePostDetail(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'anon');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  const post = await env.DB.prepare(
    `SELECT * FROM posts WHERE id = ?1`,
  ).bind(id).first<PostRow>();

  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // 本人可查看自己的所有状态帖子（含 pending/rejected）
  const isOwner = viewer && viewer.id === post.user_id;
  const scope = isOwner ? 'self' : 'public/detail';
  const out = serializePost(post, isOwner ? viewer : (viewer.role === 'anon' ? null : viewer), scope);
  if (!out) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // 作者公开资料：昵称/头衔/头像版本走账号系统统一出口；联系方式为本人的 pub 子集，单独读取
  const prof = await getPublicProfile(env, post.user_id);
  if (prof) {
    const authorRow = await env.DB.prepare(
      'SELECT contacts FROM users WHERE id = ?1',
    ).bind(post.user_id).first<{ contacts: string | null }>();
    out.author = {
      id: prof.id,
      nickname: prof.nickname,
      title: prof.title,
      contacts: readContacts(authorRow?.contacts).filter((c) => c.pub).map((c) => ({ type: c.type, value: c.value })),
      avatar_v: prof.avatar_v,
    };
  }

  // 证明材料：self 总可见；公众仅 proof_public=1 时下发 key 列表（图片走 /proof/:key 鉴权端点）
  const proofPublic = post.proof_public === 1;
  if (isOwner || proofPublic) {
    out.proof_public = proofPublic ? 1 : 0;
    out.proofs = await proofRows(env, post.id);
  } else {
    out.proof_public = 0;
  }
  // 审核模式（仅本人视角需要）：admin = 指定管理员实名审核
  if (isOwner) out.review_admin_id = post.review_admin_id || null;

  // 收藏状态（登录的非本人视角）：详情工具条「收藏/已收藏」按钮据此渲染
  if (viewer.id && !isOwner) {
    const fav = await env.DB.prepare(
      'SELECT 1 AS x FROM favorites WHERE user_id = ?1 AND post_id = ?2',
    ).bind(viewer.id, id).first();
    out.favorited = fav ? 1 : 0;
  }

  return ok(out);
}

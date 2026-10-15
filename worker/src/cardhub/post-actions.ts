import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { deleteProofs } from './proofs';
import { sanitizeContacts, parseContactChannels } from './contacts';
import { TTL_OPTIONS, TRADE_METHODS, validateBoardFields } from './schema';

const VALID_TRADES = new Set(TRADE_METHODS.map((t) => t.id));

// 加载帖子并校验归属（本人或 admin/owner 可见）
async function loadOwnedPost(env: Env, id: string, userId: string, role: string) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?1').bind(id).first<{ id: string; user_id: string; status: string; board: string }>();
  if (!post) return null;
  if (post.user_id !== userId && role !== 'admin' && role !== 'owner') return null;
  return post;
}

// POST /api/cardhub/posts/:id/close：标记成交
export async function handleClosePost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const post = await loadOwnedPost(env, id, g.viewer.id, g.viewer.role);
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (post.status !== 'open') return fail(ERR.VALIDATION_ERROR, 'NOT_OPEN', 400);

  const now = Date.now();
  await env.DB.batch([
    // 成交关闭：posts_closed 累计计数（永久统计，帖子被清理后仍保留）；置顶帖随关闭取消置顶
    env.DB.prepare(
      `UPDATE posts SET status = 'closed', close_reason = 'deal', closed_at = ?1, updated_at = ?2, pinned_at = NULL WHERE id = ?3`,
    ).bind(now, now, id),
    env.DB.prepare(
      `UPDATE conversations SET status = 'closed', close_cause = 'post_gone', updated_at = ?1 WHERE post_id = ?2 AND status = 'open'`,
    ).bind(now, id),
    env.DB.prepare(
      `UPDATE users SET posts_closed = posts_closed + 1 WHERE id = ?1`,
    ).bind(post.user_id),
  ]);

  return ok({ status: 'closed' });
}

// POST /api/cardhub/posts/:id/withdraw：主动撤回
export async function handleWithdrawPost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const post = await loadOwnedPost(env, id, g.viewer.id, g.viewer.role);
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (!['open', 'pending'].includes(post.status)) return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE posts SET status = 'closed', close_reason = 'withdraw', closed_at = ?1, updated_at = ?2, pinned_at = NULL WHERE id = ?3`,
  ).bind(now, now, id).run();

  await env.DB.prepare(
    `UPDATE conversations SET status = 'closed', close_cause = 'post_gone', updated_at = ?1 WHERE post_id = ?2 AND status = 'open'`,
  ).bind(now, id).run();

  return ok({ status: 'closed' });
}

// POST /api/cardhub/posts/:id/resubmit：编辑后重提（rejected/expired → pending）
export async function handleResubmitPost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const post = await loadOwnedPost(env, id, g.viewer.id, g.viewer.role);
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (!['rejected', 'expired'].includes(post.status)) return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE posts SET status = 'pending', reject_reason = NULL, submitted_at = ?1, updated_at = ?2, pinned_at = NULL WHERE id = ?3`,
  ).bind(now, now, id).run();

  return ok({ status: 'pending' });
}

// PUT /api/cardhub/posts/:id：编辑帖子（本人，open/rejected/expired 可改）
// 编辑后一律转 pending 重新审核（先审后发）；板块/运营商/省市为帖子骨架不可编辑（改动过大应删帖重发）；
// 证明材料保持原样（proof_public / review_admin_id 不变）
export async function handleUpdatePost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const post = await loadOwnedPost(env, id, g.viewer.id, g.viewer.role);
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (!['open', 'rejected', 'expired'].includes(post.status)) {
    return fail(ERR.VALIDATION_ERROR, 'INVALID_STATUS', 400);
  }

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const descr = typeof body.descr === 'string' ? body.descr.trim() : '';
  /* 多渠道模型：contact_visibility/allow_chat/allow_relay 优先，旧单选策略推导兜底 */
  const channels = parseContactChannels(body);
  if (channels.error || !channels.value) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: channels.error || 'contact' });
  const ttlDays = Number(body.ttl_days);
  const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
  const tags = Array.isArray(body.tags) ? body.tags.slice(0, 5) : [];
  const extraRec = extra as Record<string, unknown>;

  /* 市集（权益回收）：descr 允许为空（图文介绍为主体），仅保留长度上限 */
  if (title.length < 2 || title.length > 60) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'title' });
  if (post.board === 'market' ? descr.length > 2000 : (descr.length < 5 || descr.length > 2000)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'descr' });
  if (!TTL_OPTIONS.includes(ttlDays)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'ttl_days' });
  /* 联系渠道校验由 parseContactChannels 统一承担（新字段优先 / 旧单选推导，枚举外即 error） */

  // 交易方式（多选，选填）：值 ∈ TRADE_METHODS、去重；选「站长中转」必须同时选「站点担保」
  const rawTrades = Array.isArray(body.trade_methods) ? body.trade_methods : [];
  const tradeMethods: string[] = [];
  for (const t of rawTrades) {
    const ts = typeof t === 'string' ? t.trim() : '';
    if (!VALID_TRADES.has(ts)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'trade_methods' });
    if (!tradeMethods.includes(ts)) tradeMethods.push(ts);
  }
  if (channels.value.allowRelay && !tradeMethods.includes('site')) {
    return fail(ERR.VALIDATION_ERROR, 'TRADE_SITE_REQUIRED', 400, { field: 'trade_methods' });
  }
  if (tradeMethods.length) extraRec.trade_methods = tradeMethods;

  // 号码隐私拦截（必须先于 validateBoardFields：phone_masked required 字段依赖此处的自动打码）；
  // 编辑清空号码时同步清 phone_plain / phone_masked；found 出让号码必填
  const phonePlain = typeof extraRec.phone_num === 'string' ? extraRec.phone_num.trim() : '';
  delete extraRec.phone_num;
  if (post.board === 'found' && !phonePlain) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'phone_num' });
  if (phonePlain) {
    if (!/^\d{4,20}$/.test(phonePlain)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'phone_num' });
    let masked = typeof extraRec.phone_masked === 'string' ? extraRec.phone_masked.trim() : '';
    if (!masked) {
      masked = phonePlain.length >= 8
        ? phonePlain.slice(0, 3) + '*'.repeat(phonePlain.length - 7) + phonePlain.slice(-4)
        : phonePlain.slice(0, 1) + '*'.repeat(Math.max(phonePlain.length - 2, 1)) + (phonePlain.length > 1 ? phonePlain.slice(-1) : '');
      extraRec.phone_masked = masked;
    }
    if (masked.length > 24) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'phone_masked' });
  } else {
    delete extraRec.phone_masked;
  }

  // 板块字段校验（board 取原帖板块——骨架不可编辑，与 post-create 共用校验）
  const badField = validateBoardFields(post.board, extraRec);
  if (badField) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: badField });

  const contacts = await sanitizeContacts(body.contacts, env);
  if (!contacts.ok) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: contacts.field });

  // 价格解析（分，仅排序用）：车队按上车车费（司机收入），其余沿用月租/预算
  const priceKeys = post.board === 'fleet' ? ['car_fee'] : ['monthly_fee', 'budget'];
  let priceNum: number | null = null;
  for (const k of priceKeys) {
    const v = Number(extraRec[k]);
    if (Number.isFinite(v) && v > 0) { priceNum = Math.round(v * 100); break; }
  }

  const now = Date.now();
  const r = await env.DB.prepare(
    `UPDATE posts SET title=?1, descr=?2, extra_json=?3, contacts_json=?4, contact_policy=?5,
       contact_visibility=?6, allow_chat=?7, allow_relay=?8,
       ttl_days=?9, price_num=?10, tags_json=?11, phone_plain=?12, status='pending',
       reject_reason=NULL, submitted_at=?13, updated_at=?14
     WHERE id=?15 AND user_id=?16`,
  ).bind(
    title, descr, JSON.stringify(extra), JSON.stringify(contacts.items), channels.value.legacyPolicy,
    channels.value.visibility, channels.value.allowChat, channels.value.allowRelay,
    ttlDays, priceNum, JSON.stringify(tags), phonePlain || null, now, now, id, g.viewer.id,
  ).run();
  if (!r.meta.changes) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  return ok({ id, status: 'pending' });
}

// DELETE /api/cardhub/posts/:id：本人删除
export async function handleDeletePost(request: Request, env: Env, id: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const post = await loadOwnedPost(env, id, g.viewer.id, g.viewer.role);
  if (!post) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // 仅 closed/expired/rejected 可删
  if (!['closed', 'expired', 'rejected'].includes(post.status)) {
    return fail(ERR.VALIDATION_ERROR, 'NOT_DELETABLE', 400);
  }

  await deleteProofs(env, id); // 级联删除证明材料（R2 对象 + 元数据）
  // 先清子表再删帖：conversations/relay_requests/messages/favorites 外键引用 posts 且无级联，
  // 有会话/中转/收藏记录的帖子直接删会触发 FOREIGN KEY constraint failed
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE post_id = ?1)`,
    ).bind(id),
    env.DB.prepare(`DELETE FROM conversations WHERE post_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM relay_requests WHERE post_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM favorites WHERE post_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM posts WHERE id = ?1`).bind(id),
  ]);
  return ok({ deleted: true });
}

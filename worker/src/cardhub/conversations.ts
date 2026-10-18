import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { hitLimit } from '../common/ratelimit';
import { verifyTurnstile } from '../common/turnstile';
import { ulid } from '../common/crypto';
import { notify } from '../mail/notifier';
import { getPublicProfile } from '../auth/public-profile';

const MAX_MSG = 200; // 单对话双方合计消息上限（§10.1 调整：交易/私信统一 200，实际校验在 conversation-messages.ts）

// POST /api/cardhub/conversations：发起在线沟通（必须登录；游客走「站长中转」单向通知）
export async function handleCreateConversation(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const viewer = g.viewer;

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const postId = typeof body.postId === 'string' ? body.postId : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 50) : '';
  const bodyText = typeof body.body === 'string' ? body.body.trim().slice(0, 500) : '';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;

  if (!postId || !bodyText) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  // 登录买家自动取账号邮箱
  const buyerEmail = viewer.email;

  // 查帖：必须 open 且开启「在线沟通」渠道（多渠道模型 allow_chat=1）
  const post = await env.DB.prepare(
    'SELECT id, user_id, title, allow_chat, status FROM posts WHERE id = ?1',
  ).bind(postId).first<{ id: string; user_id: string; title: string; allow_chat: number; status: string }>();
  if (!post || post.status !== 'open' || !post.allow_chat) {
    return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  }
  // 不能对自己的帖子发起沟通
  if (post.user_id === viewer.id) return fail(40302, 'CONVERSATION_SELF', 403);

  // 买家并发 open 对话 ≤5（按邮箱计数）
  const openCount = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM conversations WHERE buyer_email = ?1 AND status = 'open'`,
  ).bind(buyerEmail).first<{ c: number }>();
  if ((openCount?.c ?? 0) >= 5) return fail(40903, 'CONVERSATION_CAP', 409);

  // 唯一性：(post, 登录买家) 唯一——重复发起不消耗每日限额
  const existing = await env.DB.prepare(
    'SELECT id FROM conversations WHERE post_id = ?1 AND buyer_user_id = ?2',
  ).bind(postId, viewer.id).first<{ id: string }>();

  if (existing) return fail(40902, 'CONVERSATION_EXISTS', 409, { id: existing.id });

  // 每日新交易会话限额：20 个/天（重复发起走上面 40902 分支不消耗）
  const rl = await hitLimit(env, `conv:start:${viewer.id}`, 20, 86400);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  const now = Date.now();
  const convId = ulid();
  const msgId = ulid();

  // 登录买家未填称呼时：优先昵称（账号系统统一出口），其次脱敏邮箱（a***@qq.com），避免把邮箱整串给卖家
  const profile = await getPublicProfile(env, viewer.id);
  const masked = viewer.email.replace(/^(.).*(@.*)$/, '$1***$2');
  const buyerName = name || (profile?.nickname ?? '') || masked;

  // 建对话 + 首条消息（D1 batch 原子执行，避免首条成功第二条失败留下 0 消息会话）
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO conversations (id, post_id, seller_id, buyer_user_id, buyer_email, buyer_name, status, msg_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', 1, ?7, ?8)`,
    ).bind(convId, postId, post.user_id, viewer.id || null, buyerEmail, buyerName, now, now),
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_role, body, created_at) VALUES (?1, ?2, 'buyer', ?3, ?4)`,
    ).bind(msgId, convId, bodyText, now),
  ]);

  // 通知卖家
  void notify(env, (await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(post.user_id).first<{ email: string }>())?.email || '', 'conversation_new_message', { title: post.title, body: bodyText, sender: 'buyer' }).catch(() => {});

  return ok({ id: convId });
}

/* ── 私信会话（kind='dm'）：资料卡「在线沟通」点对点直达，不挂帖子 ──
   字段映射沿用交易会话：seller_id=被发起方（对方）、buyer_user_id/buyer_email/buyer_name=发起方。
   防骚扰：每天最多发起 3 个新私信会话（复用已有 open 会话不消耗限额）；无「允许陌生人私信」开关。 */

// POST /api/cardhub/dm/:uid：发起/复用与指定用户的私信会话
export async function handleDmCreate(request: Request, env: Env, uid: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;
  const me = g.viewer;

  // users.id 为 ULID（26 位），勿沿用业务 id 的 4-16 位口径
  if (!/^[A-Za-z0-9]{10,32}$/.test(uid)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  if (uid === me.id) return fail(40302, 'CONVERSATION_SELF', 403);

  // 目标用户必须存在且未被封禁
  const target = await env.DB.prepare(
    "SELECT id FROM users WHERE id = ?1 AND status = 'active'",
  ).bind(uid).first<{ id: string }>();
  if (!target) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  // 复用既有 open 私信会话（双向匹配），不消耗每日限额
  const existing = await env.DB.prepare(
    `SELECT id FROM conversations
     WHERE kind = 'dm' AND status = 'open'
       AND ((seller_id = ?1 AND buyer_user_id = ?2) OR (seller_id = ?2 AND buyer_user_id = ?1))
     LIMIT 1`,
  ).bind(uid, me.id).first<{ id: string }>();
  if (existing) return ok({ id: existing.id, reused: true });

  // 每天最多发起 3 个新私信会话
  const rl = await hitLimit(env, `dm:start:${me.id}`, 3, 86400);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429);

  const profile = await getPublicProfile(env, me.id);
  const now = Date.now();
  const convId = ulid();
  await env.DB.prepare(
    `INSERT INTO conversations (id, post_id, kind, seller_id, buyer_user_id, buyer_email, buyer_name, status, msg_count, created_at, updated_at)
     VALUES (?1, NULL, 'dm', ?2, ?3, ?4, ?5, 'open', 0, ?6, ?7)`,
  ).bind(convId, uid, me.id, me.email, profile?.nickname ?? '', now, now).run();

  return ok({ id: convId, reused: false });
}

// GET /api/admin/conversations?user_id=：站长专用——查看任意用户参与的会话列表
//   仅 owner（管理员不可见此能力）；私信为纯私聊，管理组治理走用户举报（工单）
export async function handleAdminConvList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'owner');
  if (g instanceof Response) return g;

  const url = new URL(request.url);
  const uid = url.searchParams.get('user_id') || '';
  // users.id 为 ULID（26 位）
  if (!/^[A-Za-z0-9]{10,32}$/.test(uid)) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);

  const rows = await env.DB.prepare(
    `SELECT c.id, c.kind, c.post_id, c.seller_id, c.buyer_user_id, c.buyer_name, c.status, c.msg_count, c.created_at, c.updated_at,
            p.title AS post_title
     FROM conversations c
     LEFT JOIN posts p ON c.post_id = p.id
     WHERE c.seller_id = ?1 OR c.buyer_user_id = ?1
     ORDER BY c.updated_at DESC LIMIT 100`,
  ).bind(uid).all();

  // 补会话展示标题：post 用帖名；dm 用对方 uid（前端可再查昵称，此处给 uid 即可定位）
  const items = (rows.results || []).map((r) => {
    const kind = r.kind === 'dm' ? 'dm' : 'post';
    const otherUid = r.seller_id === uid ? r.buyer_user_id : r.seller_id;
    return { ...r, kind, other_uid: otherUid, title: kind === 'post' ? r.post_title : null };
  });

  return ok({ items });
}

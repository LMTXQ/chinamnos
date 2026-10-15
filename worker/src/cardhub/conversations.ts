import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { hitLimit } from '../common/ratelimit';
import { verifyTurnstile } from '../common/turnstile';
import { ulid } from '../common/crypto';
import { notify } from '../mail/notifier';
import { getPublicProfile } from '../auth/public-profile';

const MAX_MSG = 20; // 单对话双方合计消息上限（§10.1；实际校验在 conversation-messages.ts）

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

  // 唯一性：(post, 登录买家) 唯一
  const existing = await env.DB.prepare(
    'SELECT id FROM conversations WHERE post_id = ?1 AND buyer_user_id = ?2',
  ).bind(postId, viewer.id).first<{ id: string }>();

  if (existing) return fail(40902, 'CONVERSATION_EXISTS', 409, { id: existing.id });

  const now = Date.now();
  const convId = ulid();
  const msgId = ulid();

  // 登录买家未填称呼时：优先昵称（账号系统统一出口），其次脱敏邮箱（a***@qq.com），避免把邮箱整串给卖家
  const profile = await getPublicProfile(env, viewer.id);
  const masked = viewer.email.replace(/^(.).*(@.*)$/, '$1***$2');
  const buyerName = name || (profile?.nickname ?? '') || masked;

  // 建对话 + 首条消息（事务）
  await env.DB.prepare(
    `INSERT INTO conversations (id, post_id, seller_id, buyer_user_id, buyer_email, buyer_name, status, msg_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', 1, ?7, ?8)`,
  ).bind(convId, postId, post.user_id, viewer.id || null, buyerEmail, buyerName, now, now).run();

  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, sender_role, body, created_at) VALUES (?1, ?2, 'buyer', ?3, ?4)`,
  ).bind(msgId, convId, bodyText, now).run();

  // 通知卖家
  void notify(env, (await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(post.user_id).first<{ email: string }>())?.email || '', 'conversation_new_message', { title: post.title, body: bodyText, sender: 'buyer' }).catch(() => {});

  return ok({ id: convId });
}

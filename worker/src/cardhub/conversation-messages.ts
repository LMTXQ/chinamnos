import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { ulid } from '../common/crypto';
import { IMG_URL_HOSTS } from '../common/img-hosts';
import { notify } from '../mail/notifier';
import { pushNotification, markNotificationsReadByRef } from '../common/notifications';
import { getPublicProfile, getPublicProfiles } from '../auth/public-profile';

const MAX_MSG = 200; // 单对话双方合计消息上限（交易/私信统一；超出后只读）
const RETENTION_MS = 60 * 86400 * 1000; // 聊天记录保留 60 天（cron 删除 + 读路径过滤双保险）

/* 图片 URL 行识别：整行仅为 https 图片外链（扩展名或已知图床域名）时识别为图片 */
const IMG_URL_EXT_RE = /^https:\/\/[^\s<>"']+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s<>"']*)?$/i;

export function isImageUrlLine(line: string): boolean {
  const s = line.trim();
  if (!s.startsWith('https://') || /[\s<>"']/.test(s.slice(8))) return false;
  if (IMG_URL_EXT_RE.test(s)) return true;
  try { return IMG_URL_HOSTS.includes(new URL(s).hostname); } catch { return false; }
}

/* 剔除图片 URL 行，返回纯文本（邮件通知用；全为图片时返回空） */
export function stripImageUrlLines(text: string): string {
  return text.split('\n').filter((l) => l.trim() && !isImageUrlLine(l)).join('\n').trim();
}

// GET /api/cardhub/me/conversations：会话收件箱（买卖/私信双方视角；LEFT JOIN 兼容无帖私信）
export async function handleMyConversations(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT c.id, c.kind, c.post_id, c.seller_id, c.buyer_user_id, c.buyer_name, c.status, c.msg_count, c.created_at, c.updated_at,
            p.title AS post_title,
            CASE WHEN c.seller_id = ?1 THEN 'seller' ELSE 'buyer' END AS my_role
     FROM conversations c LEFT JOIN posts p ON c.post_id = p.id
     WHERE (c.seller_id = ?1 AND c.hidden_seller = 0) OR (c.buyer_user_id = ?1 AND c.hidden_buyer = 0)
     ORDER BY c.updated_at DESC LIMIT 100`,
  ).bind(g.viewer.id).all();

  // 私信会话标题 = 对方昵称（批量取公开资料，避免 N+1）
  const items = (rows.results || []) as Array<Record<string, unknown>>;
  const dmOthers = [...new Set(items
    .filter((r) => r.kind === 'dm')
    .map((r) => (r.my_role === 'seller' ? r.buyer_user_id : r.seller_id) as string)
    .filter(Boolean))];
  const nameMap = dmOthers.length ? await getPublicProfiles(env, dmOthers) : new Map();
  for (const r of items) {
    if (r.kind === 'dm') {
      const other = (r.my_role === 'seller' ? r.buyer_user_id : r.seller_id) as string;
      r.other_uid = other ?? null;
      r.title = (other && nameMap.get(other)?.nickname) || '私信会话';
    } else {
      r.other_uid = r.my_role === 'seller' ? r.buyer_user_id : r.seller_id;
      r.title = r.post_title ?? null;
    }
  }

  return ok({ items });
}

// GET /api/cardhub/conversations/:id：参与人读对话消息流（卖家/买家/私信双方）
//   站长（owner）非参与人时以观察者身份放行（治理用途，myRole='owner' 前端只读）；
//   管理员无此权限，且不提供任何管理端入口提示
export async function handleConversationDetail(request: Request, env: Env, convId: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const conv = await env.DB.prepare(
    `SELECT c.*, p.title AS post_title, p.user_id as post_owner
     FROM conversations c LEFT JOIN posts p ON c.post_id = p.id WHERE c.id = ?1`,
  ).bind(convId).first<Record<string, unknown>>();
  if (!conv) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const kind = conv.kind === 'dm' ? 'dm' : 'post';
  const isSeller = kind === 'dm' ? g.viewer.id === conv.seller_id : g.viewer.id === conv.post_owner;
  const isBuyer = g.viewer.id === conv.buyer_user_id;
  const isOwnerWatch = g.viewer.role === 'owner' && !isSeller && !isBuyer;
  if (!isSeller && !isBuyer && !isOwnerWatch) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);

  // 标题：post=帖名；dm=对方昵称（站长观察者按 seller 视角取对方）
  let title = (conv.post_title as string) ?? null;
  let otherUid: string | null = null;
  if (kind === 'dm') {
    otherUid = ((isSeller || isOwnerWatch ? conv.buyer_user_id : conv.seller_id) as string) ?? null;
    const prof = otherUid ? await getPublicProfile(env, otherUid) : null;
    title = prof?.nickname || '私信会话';
  } else {
    otherUid = isSeller ? ((conv.buyer_user_id as string) ?? null) : ((conv.post_owner as string) ?? null);
  }

  const msgs = await env.DB.prepare(
    `SELECT sender_role, body, images_json, created_at FROM messages
     WHERE conversation_id = ?1 AND created_at >= ?2 ORDER BY created_at ASC`,
  ).bind(convId, Date.now() - RETENTION_MS).all();

  // DM 已读联动：打开对话详情即把该对话的站内新消息通知标为已读（站长观察者不代读）
  if (!isOwnerWatch) await markNotificationsReadByRef(env, g.viewer.id, convId);

  return ok({
    conversation: { id: conv.id, kind, post_id: conv.post_id, title, status: conv.status, buyer_name: conv.buyer_name, msg_count: conv.msg_count, other_uid: otherUid },
    myRole: isSeller ? 'seller' : isBuyer ? 'buyer' : 'owner',
    retentionDays: 60,
    messages: msgs.results,
  });
}

// POST /api/cardhub/conversations/:id/messages：参与人回复（卖家/买家/私信双方；站长观察者不可代发）
export async function handleReplyMessage(request: Request, env: Env, convId: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const text = typeof body.body === 'string' ? body.body.trim().slice(0, 500) : '';
  if (!text) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'body' });

  const conv = await env.DB.prepare(
    `SELECT c.*, p.title AS post_title, p.user_id as post_owner
     FROM conversations c LEFT JOIN posts p ON c.post_id = p.id WHERE c.id = ?1`,
  ).bind(convId).first<Record<string, unknown>>();
  if (!conv) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (conv.status !== 'open') return fail(40902, 'CONVERSATION_CLOSED', 409);
  if ((conv.msg_count as number) >= MAX_MSG) return fail(40903, 'CONVERSATION_CAP', 409);

  const kind = conv.kind === 'dm' ? 'dm' : 'post';
  // 校验参与人：交易会话卖家 = post_owner；私信会话双方按 uid；站长观察者不可代发
  const isSeller = kind === 'dm' ? g.viewer.id === conv.seller_id : g.viewer.id === conv.post_owner;
  const isBuyer = g.viewer.id === conv.buyer_user_id;
  if (!isSeller && !isBuyer) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);

  const senderRole = isSeller ? 'seller' : 'buyer';
  const now = Date.now();
  // 新消息清双方隐藏标记（微信式：删除会话后对方回复，会话重新出现在双方列表）
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_role, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(ulid(), convId, senderRole, text, now),
    env.DB.prepare(
      `UPDATE conversations SET msg_count = msg_count + 1, updated_at = ?1, hidden_seller = 0, hidden_buyer = 0 WHERE id = ?2`,
    ).bind(now, convId),
  ]);

  const plain = stripImageUrlLines(text); // 图片 URL 不进邮件/站内通知正文
  const otherUid = (isSeller ? conv.buyer_user_id : (kind === 'dm' ? conv.seller_id : conv.post_owner)) as string | null;
  let title = (conv.post_title as string) ?? '私信会话';
  if (kind === 'dm' && otherUid) {
    title = (await getPublicProfile(env, otherUid))?.nickname || '私信会话';
  }

  // 邮件通知对方（双方均为登录用户，登录后在会话收件箱查看）
  const otherEmail = isSeller
    ? (conv.buyer_email as string)
    : (await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(otherUid as string).first<{ email: string }>())?.email;
  if (otherEmail) {
    void notify(env, otherEmail, 'conversation_new_message', { title, body: plain || '（发送了图片）', sender: senderRole }).catch(() => {});
  }

  // 站内通知对方（铃铛红点；打开对话详情时自动标已读）
  if (otherUid) {
    await pushNotification(env, otherUid, 'dm_message', convId,
      kind === 'dm' ? '来自私信的新消息' : '来自交易对话的新消息',
      `「${title}」有新消息：${plain ? plain.slice(0, 80) : '（发送了图片）'}`);
  }

  return ok({ sent: true });
}

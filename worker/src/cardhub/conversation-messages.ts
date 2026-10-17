import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { guard } from '../common/auth';
import { ulid } from '../common/crypto';
import { IMG_URL_HOSTS } from '../common/img-hosts';
import { notify } from '../mail/notifier';
import { pushNotification, markNotificationsReadByRef } from '../common/notifications';

const MAX_MSG = 20;
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

// GET /api/cardhub/me/conversations：会话收件箱（买卖双方视角：seller_id 或 buyer_user_id = 本人）
export async function handleMyConversations(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const rows = await env.DB.prepare(
    `SELECT c.id, c.post_id, c.seller_id, c.buyer_user_id, c.buyer_name, c.status, c.msg_count, c.created_at, c.updated_at,
            p.title,
            CASE WHEN c.seller_id = ?1 THEN 'seller' ELSE 'buyer' END AS my_role
     FROM conversations c JOIN posts p ON c.post_id = p.id
     WHERE c.seller_id = ?1 OR c.buyer_user_id = ?1
     ORDER BY c.updated_at DESC LIMIT 100`,
  ).bind(g.viewer.id).all();

  return ok({ items: rows.results });
}

// GET /api/cardhub/conversations/:id：参与人读对话消息流（卖家或买家）
export async function handleConversationDetail(request: Request, env: Env, convId: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const conv = await env.DB.prepare(
    `SELECT c.*, p.title, p.user_id as post_owner FROM conversations c JOIN posts p ON c.post_id = p.id WHERE c.id = ?1`,
  ).bind(convId).first<Record<string, unknown>>();
  if (!conv) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);

  const isSeller = g.viewer.id === conv.post_owner;
  const isBuyer = g.viewer.id === conv.buyer_user_id;
  if (!isSeller && !isBuyer) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);

  const msgs = await env.DB.prepare(
    `SELECT sender_role, body, images_json, created_at FROM messages
     WHERE conversation_id = ?1 AND created_at >= ?2 ORDER BY created_at ASC`,
  ).bind(convId, Date.now() - RETENTION_MS).all();

  // DM 已读联动：打开对话详情即把该对话的站内新消息通知标为已读
  await markNotificationsReadByRef(env, g.viewer.id, convId);

  return ok({
    conversation: { id: conv.id, post_id: conv.post_id, title: conv.title, status: conv.status, buyer_name: conv.buyer_name, msg_count: conv.msg_count },
    myRole: isSeller ? 'seller' : 'buyer',
    retentionDays: 60,
    messages: msgs.results,
  });
}

// POST /api/cardhub/conversations/:id/messages：参与人回复（卖家或买家）
export async function handleReplyMessage(request: Request, env: Env, convId: string): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const text = typeof body.body === 'string' ? body.body.trim().slice(0, 500) : '';
  if (!text) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'body' });

  const conv = await env.DB.prepare(
    `SELECT c.*, p.title, p.user_id as post_owner FROM conversations c JOIN posts p ON c.post_id = p.id WHERE c.id = ?1`,
  ).bind(convId).first<Record<string, unknown>>();
  if (!conv) return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  if (conv.status !== 'open') return fail(40902, 'CONVERSATION_CLOSED', 409);
  if ((conv.msg_count as number) >= MAX_MSG) return fail(40903, 'CONVERSATION_CAP', 409);

  // 校验参与人：卖家 = post_owner，买家 = buyer_user_id
  const isSeller = g.viewer.id === conv.post_owner;
  const isBuyer = g.viewer.id === conv.buyer_user_id;
  if (!isSeller && !isBuyer) return fail(ERR.FORBIDDEN, 'FORBIDDEN', 403);

  const senderRole = isSeller ? 'seller' : 'buyer';
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, sender_role, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(ulid(), convId, senderRole, text, now).run();
  await env.DB.prepare(
    `UPDATE conversations SET msg_count = msg_count + 1, updated_at = ?1 WHERE id = ?2`,
  ).bind(now, convId).run();

  const plain = stripImageUrlLines(text); // 图片 URL 不进邮件/站内通知正文

  // 邮件通知对方（双方均为登录用户，登录后在会话收件箱查看）
  const otherEmail = isSeller ? (conv.buyer_email as string) : (await env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(conv.post_owner as string).first<{ email: string }>())?.email;
  if (otherEmail) {
    void notify(env, otherEmail, 'conversation_new_message', { title: conv.title as string, body: plain || '（发送了图片）', sender: senderRole }).catch(() => {});
  }

  // 站内通知对方（铃铛红点；打开对话详情时自动标已读）
  const otherUserId = isSeller ? (conv.buyer_user_id as string) : (conv.post_owner as string);
  if (otherUserId) {
    await pushNotification(env, otherUserId, 'dm_message', convId,
      '来自交易对话的新消息',
      `「${conv.title as string}」有新消息：${plain ? plain.slice(0, 80) : '（发送了图片）'}`);
  }

  return ok({ sent: true });
}

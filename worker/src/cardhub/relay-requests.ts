import type { Env } from '../common/env';
import { ERR, fail, ok } from '../common/envelope';
import { hitLimit } from '../common/ratelimit';
import { verifyTurnstile } from '../common/turnstile';
import { ulid } from '../common/crypto';
import { notify } from '../mail/notifier';
import { pushNotification } from '../common/notifications';
import { getSetting } from '../common/settings';

// POST /api/cardhub/relay-requests：站长中转意向（§10.1）
export async function handleCreateRelayRequest(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }

  const postId = typeof body.postId === 'string' ? body.postId : '';
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 50) : '';
  const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, 100) : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  const captcha = typeof body.captcha === 'string' ? body.captcha : undefined;

  if (!postId || !name || !contact) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400);
  if (!(await verifyTurnstile(env, captcha, ip))) return fail(ERR.CAPTCHA_FAILED, 'CAPTCHA_FAILED', 400);

  // IP 5/天限流
  const rl = await hitLimit(env, `relay:${ip}`, 5, 86400);
  if (rl.limited) return fail(ERR.RATE_LIMITED, 'RATE_LIMITED', 429, { retryAfter: Math.ceil((rl.resetAt - Date.now()) / 1000) });

  // 校验帖：open 且开启「站长中转」渠道（多渠道模型 allow_relay=1）
  const post = await env.DB.prepare(
    'SELECT id, user_id, title, allow_relay, status FROM posts WHERE id = ?1',
  ).bind(postId).first<{ id: string; user_id: string; title: string; allow_relay: number; status: string }>();
  if (!post || post.status !== 'open' || !post.allow_relay) {
    return fail(ERR.NOT_FOUND, 'NOT_FOUND', 404);
  }

  const now = Date.now();
  const id = ulid();

  await env.DB.prepare(
    `INSERT INTO relay_requests (id, post_id, buyer_name, buyer_contact, note, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6)`,
  ).bind(id, postId, name, contact, note || '', now).run();

  // 通知站长（受「站长中转意向」邮件开关控制；站内通知不受影响）
  const ownerEmail = await getSetting(env, 'owner_email', env.OWNER_EMAIL || '');
  if (ownerEmail) {
    void (async () => {
      if (!(await getSetting<boolean>(env, 'mail_relay_request_enabled', true))) return;
      notify(env, ownerEmail, 'relay_request', {
        title: post.title, name, contact, note: note || '(无)',
      }).catch(() => {});
    })().catch(() => {});
  }
  // 站内通知帖主：收到中转意向（此前仅邮件——补齐站内兜底，ref 指向帖子便于跳转）
  await pushNotification(env, post.user_id, 'relay_request', postId,
    '收到新的站长中转意向',
    `您的帖子「${post.title}」收到中转意向：联系人 ${name}（${contact}）${note ? `，留言：${note.slice(0, 60)}` : ''}，请登录后台处理。`);

  return ok({ id });
}

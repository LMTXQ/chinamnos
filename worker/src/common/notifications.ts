import type { Env } from './env';
import { ERR, fail, ok } from './envelope';
import { guard } from './auth';
import { getSetting } from './settings';

/* ── 站内通知中心（系统→用户 单向通知；发送者「用户管理组」为前端展示层概念） ──
   所有"系统→用户"事件统一入箱：审核结果（情报/社群/工具/帖子）、到期自动下架下展、
   管理组下架、在线沟通新消息。单向不可回复、无条数上限（不走 conversations 交易对话体系）。 */

export type NotificationKind =
  | 'act_approved' | 'act_rejected' | 'chat_approved' | 'chat_rejected'
  | 'act_retired' | 'act_expired'
  | 'link_approved' | 'link_rejected'
  | 'post_approved' | 'post_rejected' | 'post_closed' | 'post_expired'
  | 'post_expiring' | 'relay_request'
  | 'dm_message';

/* pushNotification：写一条站内通知。尽力而为——失败静默，绝不影响主流程（审核/发消息等） */
export async function pushNotification(
  env: Env, userId: string | null | undefined,
  kind: NotificationKind, refId: string | null,
  title: string, body: string | null,
): Promise<void> {
  if (!userId) return;
  try {
    await env.DB.prepare(
      'INSERT INTO notifications (id, user_id, kind, ref_id, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(crypto.randomUUID(), userId, kind, refId, title.slice(0, 120), body ? body.slice(0, 1000) : null, Date.now()).run();
  } catch { /* 通知失败不影响主流程 */ }
}

/* markNotificationsReadByRef：按关联对象标已读（DM 已读联动——打开对话详情时调用；尽力而为） */
export async function markNotificationsReadByRef(env: Env, userId: string, refId: string): Promise<void> {
  try {
    await env.DB.prepare(
      'UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND ref_id = ?3 AND read_at IS NULL',
    ).bind(Date.now(), userId, refId).run();
  } catch { /* 尽力而为 */ }
}

/** 通知保留天数（管理后台 settings 键 notification_retention_days，默认 30，范围 1~365） */
async function getRetentionDays(env: Env): Promise<number> {
  const raw = await getSetting<number>(env, 'notification_retention_days', 30);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
}

// GET /api/notifications：本人最近 50 条 + 未读数
//   返回前顺手清理：删除本人已读且超过保留期的通知（读即清理，无需 cron；
//   idx_notif_unread(user_id, read_at) 命中，单用户代价极小；未读不受影响）
export async function handleNotificationsList(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  const days = await getRetentionDays(env);
  await env.DB.prepare(
    'DELETE FROM notifications WHERE user_id = ?1 AND read_at IS NOT NULL AND read_at < ?2',
  ).bind(g.viewer.id, Date.now() - days * 86400_000).run();

  const rows = await env.DB.prepare(
    `SELECT id, kind, ref_id, title, body, created_at, read_at
     FROM notifications WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`,
  ).bind(g.viewer.id).all();
  const unread = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM notifications WHERE user_id = ?1 AND read_at IS NULL',
  ).bind(g.viewer.id).first<{ c: number }>();

  return ok({ items: rows.results || [], unread: unread?.c ?? 0 });
}

// POST /api/notifications/delete  body: { id }
//   删除本人单条通知（WHERE user_id 双保险，防越权删他人通知）
export async function handleNotificationsDelete(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'id' });

  await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?1 AND id = ?2')
    .bind(g.viewer.id, id).run();
  return ok({ id });
}

// POST /api/notifications/clear-read
//   清空本人全部已读通知（未读保留）
export async function handleNotificationsClearRead(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  await env.DB.prepare('DELETE FROM notifications WHERE user_id = ?1 AND read_at IS NOT NULL')
    .bind(g.viewer.id).run();
  return ok({ cleared: true });
}

// POST /api/notifications/read  body: { id?: string } 或 { all: true }
export async function handleNotificationsRead(request: Request, env: Env): Promise<Response> {
  const g = await guard(request, env, 'user');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* */ }
  const now = Date.now();

  if (body.all === true) {
    await env.DB.prepare(
      'UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND read_at IS NULL',
    ).bind(now, g.viewer.id).run();
    return ok({ all: true });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return fail(ERR.VALIDATION_ERROR, 'VALIDATION_ERROR', 400, { field: 'id' });
  await env.DB.prepare(
    'UPDATE notifications SET read_at = ?1 WHERE user_id = ?2 AND id = ?3 AND read_at IS NULL',
  ).bind(now, g.viewer.id, id).run();
  return ok({ id });
}

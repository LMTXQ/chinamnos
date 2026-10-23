import type { Env } from './env';
import { ERR, fail, ok } from './envelope';
import { guard } from './auth';
import { getSetting } from './settings';
import { hitLimit } from './ratelimit';
import { extPushInstant } from '../notify/ext-push';

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

/* 全部通知事件类型清单（Worker 侧唯一副本）：settings 校验、渠道偏好过滤、
   cron 批量外推的白名单判定共用本清单（原 ext-push.ts 定义迁入于此）。
   前端唯一副本在 pages-dist/shell/notify-kinds.js（auth.js 渠道偏好 /
   admin.js 站点白名单共用）——两份各自收敛、不做接口下发（省一次前端请求），
   新增/调整事件时两处同步修改。 */
export const NOTIFY_KINDS = [
  'act_approved', 'act_rejected', 'chat_approved', 'chat_rejected',
  'act_retired', 'act_expired',
  'link_approved', 'link_rejected',
  'post_approved', 'post_rejected', 'post_closed', 'post_expired',
  'post_expiring', 'relay_request', 'dm_message',
] as const satisfies readonly NotificationKind[];

/* 管理后台白名单勾选项的中文标签（与前端 notify-kinds.js 的文案保持一致） */
export const NOTIFY_KIND_LABELS: Record<string, string> = {
  act_approved: '情报投稿通过审核',
  act_rejected: '情报投稿被驳回',
  chat_approved: '社群投稿通过审核',
  chat_rejected: '社群投稿被驳回',
  act_retired: '情报/社群被管理组下架',
  act_expired: '情报/社群到期自动下展',
  link_approved: '工具提交通过审核',
  link_rejected: '工具提交被驳回',
  post_approved: '帖子审核通过',
  post_rejected: '帖子审核驳回',
  post_closed: '帖子被管理组关闭',
  post_expired: '帖子到期自动下架',
  post_expiring: '帖子临期提醒',
  relay_request: '收到站长中转意向',
  dm_message: '收到新私信',
};

/* pushNotification：写一条站内通知。尽力而为——失败静默，绝不影响主流程（审核/发消息等）。
   同类过滤闸门（铃铛与外推共用）：同用户 + 同事件类型 + 同事件对象在 notify_throttle_minutes
   窗口内只写一条/推一次（防私信刷屏刷爆铃铛与外部机器人）；0 = 关闭过滤；闸门自身异常时不拦截。
   即时外推钩子（方案 B）：默认 src='instant' 的挂点在落库后 fire-and-forget 触发站外推送；
   cron 挂点（到期帖/临期/活动到期）必须显式传 { src: 'cron' } 跳过——cron 批量外推由方案 C
   的青龙管线接管，避免双发。 */
export async function pushNotification(
  env: Env, userId: string | null | undefined,
  kind: NotificationKind, refId: string | null,
  title: string, body: string | null,
  opts?: { src?: 'instant' | 'cron' },
): Promise<void> {
  if (!userId) return;
  try {
    let throttled = false;
    try {
      const minutes = await getSetting<number>(env, 'notify_throttle_minutes', 10);
      if (Number.isFinite(minutes) && minutes > 0) {
        const t = await hitLimit(env, `notif:f:${userId}:${kind}:${refId || 'none'}`, 1, minutes * 60);
        throttled = t.limited;
      }
    } catch { /* 过滤器异常不拦截，走原有写入行为 */ }
    if (throttled) return;
    await env.DB.prepare(
      'INSERT INTO notifications (id, user_id, kind, ref_id, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(crypto.randomUUID(), userId, kind, refId, title.slice(0, 120), body ? body.slice(0, 1000) : null, Date.now()).run();
  } catch { /* 通知失败不影响主流程 */ }
  if ((opts?.src ?? 'instant') === 'instant') {
    /* 外推必须在请求生命周期内确定性执行：不注册 waitUntil 的浮动任务在响应返回后
       可能被运行时取消（实测外推静默丢失）。竞速 1 秒上限——正常双渠道并行 ~300ms 完成，
       1 秒内完不成基本就是推送方故障（多等无益），超时放弃只影响外部推送（铃铛已落库），
       不会拖死业务请求（站长决策 2026-10-23：不上推送队列，保即时秒达，仅收紧超时上限） */
    await Promise.race([
      extPushInstant(env, userId, kind, title, body || '').catch(() => { /* 外推失败静默 */ }),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
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

import type { Env } from '../common/env';
import { notify } from '../mail/notifier';
import { deleteProofs } from './proofs';

const DAY = 86400 * 1000;

// CardHub 日常保洁：到期、关对话、删除、到期提醒
export async function runCardhubCron(env: Env): Promise<void> {
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * DAY;
  const threeDaysLater = now + 3 * DAY;
  const threeDaysLaterMinus1d = now + 2 * DAY;

  // 1) 到期帖：open 且 expires_at < now → expired，同时记 closed_at（置顶帖随到期取消置顶）
  const expRes = await env.DB.prepare(
    `UPDATE posts SET status = 'expired', closed_at = ?1, pinned_at = NULL WHERE status = 'open' AND expires_at < ?2`,
  ).bind(now, now).run();
  const expiredCount = expRes.meta.changes ?? 0;

  // 2) 关闭已过期/已关闭帖子的对话
  await env.DB.prepare(
    `UPDATE conversations SET status = 'closed'
     WHERE status = 'open' AND post_id IN (
       SELECT id FROM posts WHERE status IN ('closed', 'expired')
     )`,
  ).run();

  // 3) 删除关闭满 90 天的帖子（及其对话/消息/证明材料）
  const toPurge = await env.DB.prepare(
    `SELECT id FROM posts WHERE status IN ('closed', 'expired') AND closed_at < ?1`,
  ).bind(ninetyDaysAgo).all<{ id: string }>();
  for (const p of toPurge.results || []) {
    await deleteProofs(env, p.id);
  }
  await env.DB.prepare(`DELETE FROM messages WHERE conversation_id IN (
    SELECT id FROM conversations WHERE post_id IN (
      SELECT id FROM posts WHERE status IN ('closed', 'expired') AND closed_at < ?1
    )
  )`).bind(ninetyDaysAgo).run();
  await env.DB.prepare(`DELETE FROM conversations WHERE post_id IN (
    SELECT id FROM posts WHERE status IN ('closed', 'expired') AND closed_at < ?1
  )`).bind(ninetyDaysAgo).run();
  await env.DB.prepare(`DELETE FROM favorites WHERE post_id IN (
    SELECT id FROM posts WHERE status IN ('closed', 'expired') AND closed_at < ?1
  )`).bind(ninetyDaysAgo).run();
  await env.DB.prepare(
    `DELETE FROM posts WHERE status IN ('closed', 'expired') AND closed_at < ?1`,
  ).bind(ninetyDaysAgo).run();

  // 3.5) 已关闭工单保留 30 天后永久删除（计数已永久记录在 users.tickets_total，不受清理影响）
  const ticketCutoff = now - 30 * DAY;
  await env.DB.prepare(
    `DELETE FROM ticket_messages WHERE ticket_id IN (
       SELECT id FROM tickets WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?1
     )`,
  ).bind(ticketCutoff).run();
  await env.DB.prepare(
    `DELETE FROM tickets WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?1`,
  ).bind(ticketCutoff).run();

  // 4) 聊天记录保留 60 天：过期消息自动删除（会话骨架与计数保留，读路径同步过滤兜底）
  const msgCutoff = now - 60 * DAY;
  await env.DB.prepare(`DELETE FROM messages WHERE created_at < ?1`).bind(msgCutoff).run();

  // 5) 到期前 3 天提醒（仅提醒一次窗口 [now+2d, now+3d)）
  const expiring = await env.DB.prepare(
    `SELECT p.id, p.title, p.expires_at, u.email
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.status = 'open' AND p.expires_at >= ?1 AND p.expires_at < ?2`,
  ).bind(threeDaysLaterMinus1d, threeDaysLater).all();

  for (const row of expiring.results as Array<{ id: string; title: string; expires_at: number; email: string }>) {
    void notify(env, row.email, 'post_expiring', { title: row.title }).catch(() => {});
  }
}

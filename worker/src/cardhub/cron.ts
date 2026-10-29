import type { Env } from '../common/env';
import { getSetting } from '../common/settings';
import { deleteProofs } from './proofs';
import { loadActiveBindings, getSiteName } from '../auth/notify-channels';
import { qlDispatchPayload, type PayloadRow } from '../notify/ql-client';

const DAY = 86400 * 1000;

// CardHub 日常保洁：到期、关对话、删除、到期提醒
// 返回外推回执（rows = payload 行数，ql = 青龙分发结果），供手动触发端点透传
export async function runCardhubCron(env: Env): Promise<{ rows: number; ql: string }> {
  let qlRows = 0;
  let qlResult = '未触发（无到期/临期帖或开关未开）';
  const now = Date.now();
  const ninetyDaysAgo = now - 90 * DAY;
  const threeDaysLater = now + 3 * DAY;
  const threeDaysLaterMinus1d = now + 2 * DAY;

  // 1) 到期帖：open 且 expires_at < now → expired，同时记 closed_at（置顶帖随到期取消置顶）
  //    铃铛改为 batch 一次性直写（方案 C：cron 通知不走 pushNotification，站外通知走青龙批量管线）
  const expiringRows = await env.DB.prepare(
    `SELECT id, user_id, title FROM posts WHERE status = 'open' AND expires_at < ?1`,
  ).bind(now).all<{ id: string; user_id: string; title: string }>();
  await env.DB.prepare(
    `UPDATE posts SET status = 'expired', closed_at = ?1, pinned_at = NULL WHERE status = 'open' AND expires_at < ?2`,
  ).bind(now, now).run();
  const expiredCount = expiringRows.results?.length ?? 0;
  if (expiredCount) {
    await env.DB.batch(expiringRows.results.map((row) =>
      env.DB.prepare(
        'INSERT INTO notifications (id, user_id, kind, ref_id, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      ).bind(crypto.randomUUID(), row.user_id, 'post_expired', row.id,
        `你的帖子「${row.title}」已到期下架`, '帖子展示期已结束，已自动下架。', Date.now())));
  }

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

  // 5) 到期前 3 天提醒（仅提醒一次窗口 [now+2d, now+3d)）+ 本轮已到期帖：两类事件的站外批量
  //    合并为一次青龙分发——同一 cron 内只触发一次青龙任务，避免并发实例 flock 冲突导致告警与文件滞留。
  //    铃铛 batch 直写；站外行（方案 C，订阅制口径）：邮件行（SMTP 池）只发绑定 email 渠道的用户，
  //    webhook 行（钉钉/企微）按各自绑定下发；临期提醒行受「帖子到期提醒」邮件总闸（历史口径，
  //    该开关同时是临期站外行的总闸），到期帖行无邮件总闸场景；两类行均受 站外推送总开关 +
  //    事件白名单 + 渠道级偏好 过滤
  const expiring = await env.DB.prepare(
    `SELECT p.id, p.title, p.user_id, p.expires_at, u.email
     FROM posts p JOIN users u ON p.user_id = u.id
     WHERE p.status = 'open' AND p.expires_at >= ?1 AND p.expires_at < ?2`,
  ).bind(threeDaysLaterMinus1d, threeDaysLater).all();

  if (expiring.results.length) {
    await env.DB.batch(expiring.results.map((row) =>
      env.DB.prepare(
        'INSERT INTO notifications (id, user_id, kind, ref_id, title, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
      ).bind(crypto.randomUUID(), (row as { user_id: string }).user_id, 'post_expiring', row.id,
        '您的帖子即将到期',
        `帖子「${(row as { title: string }).title}」将在 3 天后到期自动下架，如需继续展示请到「我的发布」重新提交。`, Date.now())));
  }

  const mailExpiring = await getSetting<boolean>(env, 'mail_post_expiring_enabled', true);
  const extEnabled = await getSetting<boolean>(env, 'notify_ext_enabled', false);

  if (extEnabled && (expiring.results.length || expiredCount)) {
    const kindsCfg = await getSetting<unknown>(env, 'notify_ext_kinds', null);
    const kindOk = (k: string) => !Array.isArray(kindsCfg) || kindsCfg.includes(k);
    const site = env.PUBLIC_BASE_URL || 'https://chinamnos.ftac.dpdns.org';
    const siteName = await getSiteName(env);
    const pushTitle = `【${siteName}】消息通知`;
    const rows: PayloadRow[] = [];

    // 临期提醒行（post_expiring）：受「帖子到期提醒」邮件总闸
    if (mailExpiring && expiring.results.length && kindOk('post_expiring')) {
      for (const row of expiring.results as Array<{ id: string; title: string; user_id: string }>) {
        const bindings = await loadActiveBindings(env, row.user_id);
        for (const b of bindings) {
          if (b.kinds && !b.kinds.includes('post_expiring')) continue; // 渠道级偏好过滤
          const nid = `post_expiring:${row.id}:${b.id}`;               // 确定性去重键：重跑不重发（增量 3 按绑定行 id，多实例不互吞）
          const content =
            `站点：[${site.replace(/^https:\/\//, '')}](${site})\n\n` +
            `正文：帖子「${row.title}」将在 3 天后到期自动下架\n` +
            `如需继续展示请到「我的发布」重新提交。\n\n` +
            `若希望关闭打扰，请前往站点关闭外接消息通知或解绑通知渠道。`;
          if (b.channel_type === 'email') {
            rows.push({ nid, uid: row.user_id, kind: 'post_expiring', title: pushTitle, body: content, channel_type: 'email', email_target: b.cred.email || row.email });
          } else {
            rows.push({ nid, uid: row.user_id, kind: 'post_expiring', title: pushTitle, body: content, channel_type: b.channel_type, cred: b.cred });
          }
        }
      }
    }

    // 到期帖行（post_expired，F1 补齐）：无邮件总闸场景，与 act_expired 同口径三重过滤
    if (expiredCount && kindOk('post_expired')) {
      for (const row of (expiringRows.results || []) as Array<{ id: string; user_id: string; title: string }>) {
        const bindings = await loadActiveBindings(env, row.user_id);
        for (const b of bindings) {
          if (b.kinds && !b.kinds.includes('post_expired')) continue; // 渠道级偏好过滤
          const nid = `post_expired:${row.id}:${b.id}`;                // 确定性去重键：重跑不重发（增量 3 按绑定行 id，多实例不互吞）
          const content =
            `站点：[${site.replace(/^https:\/\//, '')}](${site})\n\n` +
            `正文：你的帖子「${row.title}」已到期下架\n` +
            `帖子展示期已结束，已自动下架。\n\n` +
            `若希望关闭打扰，请前往站点关闭外接消息通知或解绑通知渠道。`;
          if (b.channel_type === 'email') {
            rows.push({ nid, uid: row.user_id, kind: 'post_expired', title: pushTitle, body: content, channel_type: 'email', email_target: b.cred.email });
          } else {
            rows.push({ nid, uid: row.user_id, kind: 'post_expired', title: pushTitle, body: content, channel_type: b.channel_type, cred: b.cred });
          }
        }
      }
    }

    if (rows.length) {
      qlRows = rows.length;
      const filename = `batch_cron_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
      try {
        await qlDispatchPayload(env, filename, rows);
        qlResult = `ok（${rows.length} 行）`;
      } catch (e) {
        // 重试后仍失败：记日志放弃本轮外推（铃铛已落库，青龙侧遗留文件自愈机制兜底重试）
        qlResult = `FAILED: ${String(e).slice(0, 200)}`;
        console.warn(`[cron-ext] 帖子类外推失败（${rows.length} 条未推送）: ${qlResult}`);
      }
    }
  }
  return { rows: qlRows, ql: qlResult };
}
